// ============================================================
// NFCReaderService — couche d'abstraction commune du lecteur NFC
// externe (MIFARE Classic 1K — UID uniquement, aucune donnée écrite).
//
// Règle d'architecture :
//   . TOUTES les opérations NFC de l'application passent par CE service.
//   . Le service ne connaît PAS le protocole matériel du lecteur.
//   . Le protocole réel est fourni par un ADAPTER (pilote) externe,
//     selon le modèle exact du lecteur — jamais inventé ici.
//   . Seule donnée retournée à l'application : l'UID de la carte.
//
// Flux (mode officiel/fiable) :
//   External NFC Reader
//         ↓
//   NFC Reader Adapter (driver / bridge)
//         ↓
//   NFCReaderService  -> readUID() -> UID
//         ↓
//   App -> Supabase
//
// Modes / adapters implémentés :
//   1. 'driver'   — driver injecté (config.driver) : protocole RÉEL du
//                   lecteur (WebUSB, Serial, HID, PC/SC, …).
//   2. 'bridge'   — window.NfcBridge (app native / serveur local).
//                   Chemin pour Android via USB OTG ET pour Windows.
//   3. 'simulate' — simulateur de dev/test (jamais en prod).
//   4. 'webnfc'   — [EXPERIMENTAL / FALLBACK] NFC intégré Android via
//                   Web NFC. NE DONNE PAS le UID brut d'une MIFARE
//                   Classic 1K : readUid() refuse de fabriquer un UID à
//                   partir de données NDEF. Il ne lit que des messages
//                   NDEF et l'application doit donc le traiter comme un
//                   adapter DISTINCT qui n'émet pas d'UID fiable.
//
// Device compatibility :
//   Windows  : Lecteur USB externe   -> UID ✅ (pas officiel Web NFC)
//   Android  : Lecteur USB OTG externe -> UID ✅
//   Android  : NFC intégré + Web NFC -> UID ⚠️ pas garanti (adapter webnfc)
//   iPhone   : NFC intégré           -> ❌ (hors architecture Web NFC)
//
// Le NFC interne android (via Web NFC) ne remplace PAS le lecteur
// externe pour l'UID brut MIFARE Classic 1K.
//
// Aucun VID/PID, endpoint ou octet de protocole n'est codé en dur ici :
// l'opérateur injecte le driver/bridge correspondant à son matériel.
// ============================================================

window.NFCReaderService = (function () {

    const DEFAULT_CONFIG = {
        adapter: 'bridge',       // 'driver' | 'bridge' | 'simulate'
        driver: null,            // objet driver optionnel (adapter='driver')
        bridge: null             // objet bridge optionnel (adapter='bridge')
    };

    let config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    let activeAdapter = null;
    const statusCallbacks = [];

    /* ---------- Status ---------- */
    function emitStatus(state, info) {
        const evt = { state, connected: state === 'connected', message: info || '', time: Date.now() };
        statusCallbacks.forEach(cb => { try { cb(evt); } catch (e) { console.error(e); } });
    }

    /* ==========================================================
       ADAPTER : 'driver' — protocole matériel injecté
       ==========================================================
       Le driver (fourni par l'opérateur selon le modèle réel) doit
       implémenter :
         open()                 -> Promise
         close()                -> Promise
         isConnected()          -> boolean
         readUid()              -> Promise<string>   // "AA:BB:.."
         test()                 -> Promise<boolean>  // optionnel
       ========================================================== */
    class DriverAdapter {
        constructor(drv) {
            if (!drv || typeof drv.readUid !== 'function') {
                throw new Error('Aucun driver NFC configuré pour ce lecteur.');
            }
            this.drv = drv;
            this.connected = false;
        }
        isConnected() { return !!(this.drv.isConnected && this.drv.isConnected()); }
        async connect() {
            if (this.drv.open) await this.drv.open();
            this.connected = true;
            emitStatus('connected', 'Lecteur NFC externe connecté');
            return this;
        }
        async disconnect() {
            if (this.drv.close) { try { await this.drv.close(); } catch (e) {} }
            this.connected = false;
            emitStatus('disconnected', 'Lecteur NFC externe déconnecté');
        }
        async readUid() {
            if (!this.isConnected()) throw new Error('Lecteur non connecté');
            return this.drv.readUid();
        }
        async test() {
            return this.drv.test ? this.drv.test() : (await this.readUid()) !== null;
        }
        async startPolling(onUid) {
            if (this.drv.startPolling) return this.drv.startPolling(onUid);
            this._loop = setInterval(async () => {
                if (!this.isConnected()) return;
                try { const u = await this.readUid(); if (u && onUid) onUid(u); } catch (e) {}
            }, this.drv.pollInterval || 600);
        }
        _stopLoop() { if (this._loop) { clearInterval(this._loop); this._loop = null; } }
    }

    /* ==========================================================
       ADAPTER : 'bridge' — pont local / app native
       (Android via USB OTG, ou Windows)
       ==========================================================
       Utilise window.NfcBridge — objet fourni par une app native ou un
       serveur local qui pilote le lecteur USB réel. Nécessite au moins :
         isConnected() -> boolean
         readUid()     -> Promise<string>
       Optionnel : test(), startPolling(onUid)
       ========================================================== */
    class BridgeAdapter {
        constructor(brg) {
            if (!brg) {
                // Aucun bridge injecté : on regarde un bridge global (app native)
                brg = window.NfcBridge;
            }
            if (!brg || typeof brg.readUid !== 'function') {
                throw new Error('Aucun bridge NFC disponible. Installez/lancez le pont du lecteur pour cet appareil.');
            }
            this.brg = brg;
            this.connected = false;
        }
        isConnected() { return !!(this.brg.isConnected && this.brg.isConnected()); }
        async connect() {
            if (this.brg.open) await this.brg.open();
            if (!this.isConnected()) throw new Error('Lecteur NFC externe non détecté.');
            this.connected = true;
            emitStatus('connected', 'Lecteur NFC externe connecté');
            return this;
        }
        async disconnect() {
            if (this.brg.close) { try { await this.brg.close(); } catch (e) {} }
            this.connected = false;
            emitStatus('disconnected', 'Lecteur NFC externe déconnecté');
        }
        async readUid() {
            if (!this.isConnected()) throw new Error('Lecteur non connecté');
            return this.brg.readUid();
        }
        async test() {
            return this.brg.test ? this.brg.test() : this.isConnected();
        }
        async startPolling(onUid) {
            if (this.brg.startPolling) return this.brg.startPolling(onUid);
            this._loop = setInterval(async () => {
                if (!this.isConnected()) return;
                try { const u = await this.readUid(); if (u && onUid) onUid(u); } catch (e) {}
            }, 600);
        }
        _stopLoop() { if (this._loop) { clearInterval(this._loop); this._loop = null; } }
    }

    /* ==========================================================
       ADAPTER : 'simulate' — dev/test uniquement
       ========================================================== */
    class SimulateAdapter {
        constructor() { this.connected = false; this._loop = null; }
        isConnected() { return this.connected; }
        async connect() { this.connected = true; emitStatus('connected', 'Lecteur (simulation) connecté'); return this; }
        async disconnect() { this.connected = false; emitStatus('disconnected', 'Simulation déconnectée'); }
        async readUid() {
            if (!this.connected) throw new Error('Lecteur non connecté');
            const mk = () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0').toUpperCase();
            await new Promise(r => setTimeout(r, 400));
            return `04:${mk()}:${mk()}:${mk()}:${mk()}:${mk()}:${mk()}`;
        }
        async test() { return this.connected; }
        startPolling(onUid) { this._loop = setInterval(async () => { try { const u = await this.readUid(); if (u && onUid) onUid(u); } catch (e) {} }, 1200); }
        _stopLoop() { if (this._loop) { clearInterval(this._loop); this._loop = null; } }
    }

    /* ==========================================================
       ADAPTER : 'webnfc' — NFC intégré Android via Web NFC
       [EXPERIMENTAL / FALLBACK — ne produit PAS un UID fiable]
       ==========================================================
       Le Web NFC (NDEFReader) permet de lire des messages NDEF sur des
       tags compatibles (NTAG216…). Il n'expose PAS le UID brut/Serial
       Number d'une MIFARE Classic 1K de façon standard.

       Conformément à l'exigence « ne pas fabriquer un UID », readUid()
       de cet adapter REFUSE de convertir artificiellement des données
       NDEF en UID : il lève une erreur explicite invitant à utiliser le
       lecteur externe. L'application doit traiter ce mode comme un
       adapter DISTINCT (capable au mieux de lire un NDEF, jamais d'émettre
       un UID fiable).
       ========================================================== */
    class WebNfcAdapter {
        constructor() {
            this.connected = false;
            this.ndefReader = null;
            this._ondata = null;
        }

        /* Capacité réelle : le Web NFC ne fournit pas l'UID brut. */
        static isAvailable() {
            return ('NDEFReader' in window);
        }
        supportsRawUid() { return false; }

        isConnected() { return this.connected; }

        async connect() {
            if (!WebNfcAdapter.isAvailable()) {
                throw new Error('Web NFC (NFC intégré) non disponible dans ce navigateur. Utilisez Chrome sur Android, ou le lecteur externe.');
            }
            try {
                this.ndefReader = new NDEFReader();
                await this.ndefReader.scan();
                this.connected = true;
                emitStatus('connected', 'NFC intégré (Web NFC) connecté');
            } catch (err) {
                this.connected = false;
                throw new Error('Impossible d\'activer le NFC intégré : ' + err.message);
            }
            return this;
        }

        async disconnect() {
            this.connected = false;
            if (this._unsub) { try { this._unsub(); } catch (e) {} this._unsub = null; }
            this.ndefReader = null;
            emitStatus('disconnected', 'NFC intégré déconnecté');
        }

        /* ⚠ Ne JAMAIS renvoyer un UID inventé à partir de NDEF. */
        async readUid() {
            throw new Error('⚠ Lecture UID non disponible avec le NFC intégré (Web NFC ne fournit pas l\'UID brut MIFARE Classic 1K). Utilisez le lecteur NFC externe USB/OTG.');
        }

        /* Lecture NDEF (expérimentale) — retourne le texte NDEF, PAS un UID.
           Utile uniquement pour des tags NDEF (NTAG) compatibles. */
        async readNdefMessage() {
            if (!this.connected || !this.ndefReader) throw new Error('NFC intégré non actif');
            return new Promise((resolve, reject) => {
                const onReading = (ev) => {
                    let text = '';
                    for (const record of ev.message.records || []) {
                        if (record.recordType === 'text' && record.data) {
                            text += new TextDecoder(record.encoding || 'utf-8').decode(record.data);
                        }
                    }
                    cleanup();
                    resolve(text || null);
                };
                const onError = () => { cleanup(); reject(new Error('Erreur de lecture NDEF')); };
                const cleanup = () => {
                    this.ndefReader.removeEventListener('reading', onReading);
                    this.ndefReader.removeEventListener('error', onError);
                };
                this.ndefReader.addEventListener('reading', onReading);
                this.ndefReader.addEventListener('error', onError);
                // délai de sécurité
                setTimeout(() => { cleanup(); reject(new Error('Aucun tag NDEF détecté.')); }, 8000);
            });
        }

        async test() { return this.connected; }

        async startPolling(onUid) {
            // En mode Web NFC on ne peut pas poller l'UID : on notifie la
            // non-disponibilité pour le flux UID. L'application doit le savoir.
            if (onUid) onUid({ ndefOnly: true, uidUnavailable: true });
            this._loop = setInterval(() => {
                if (onUid) onUid({ ndefOnly: true, uidUnavailable: true });
            }, 5000);
        }
        _stopLoop() { if (this._loop) { clearInterval(this._loop); this._loop = null; } }
    }

    /* ==========================================================
       ADAPTER : 'pcnfc' — NFC intégré du PC
       [via PC/SC ou bridge — ne pas supposer la lecture de l'UID]
       ==========================================================
       Certains PC disposent d'un lecteur NFC intégré, normalement
       exposé via PC/SC. Le navigateur n'y accède pas directement :
       il faut un bridge natif (app/serveur local) exposant readUid().

       Cet adapter utilise donc un bridge/driver fourni par l'opérateur
       (config.pcnfc ou window.NfcBridgePc). Il ne PRÉTEND pas lire
       l'UID tant qu'aucun bridge réel n'est disponible :
         supportsRawUid() = false  -> lecture UID indisponible.
       ========================================================== */
    class PcNfcAdapter {
        constructor() {
            this.brg = (config.pcnfc && config.pcnfc.bridge) || window.NfcBridgePc || window.NfcBridge;
            this.connected = false;
            this._loop = null;
        }
        static isAvailable() {
            const b = (config && config.pcnfc && config.pcnfc.bridge) || window.NfcBridgePc || window.NfcBridge;
            return !!(typeof NDEFReader === 'undefined' && b && typeof b.readUid === 'function');
        }
        supportsRawUid() { return !!(this.brg && typeof this.brg.readUid === 'function'); }
        isConnected() { return !!(this.brg && this.brg.isConnected && this.brg.isConnected()); }
        async connect() {
            if (!this.brg || typeof this.brg.readUid !== 'function') {
                throw new Error('NFC intégré du PC : aucun bridge PC/SC disponible. Installez/lancez le pont (lecteur NFC du PC).');
            }
            if (this.brg.open) await this.brg.open();
            this.connected = true;
            emitStatus('connected', 'NFC intégré du PC connecté');
            return this;
        }
        async disconnect() {
            if (this.brg && this.brg.close) { try { await this.brg.close(); } catch (e) {} }
            this.connected = false;
            emitStatus('disconnected', 'NFC intégré du PC déconnecté');
        }
        async readUid() {
            if (!this.brg || typeof this.brg.readUid !== 'function') {
                throw new Error('⚠ Lecture UID non disponible avec le NFC intégré du PC (pas de bridge PC/SC). Utilisez le lecteur NFC externe USB.');
            }
            return this.brg.readUid();
        }
        async test() { return this.isConnected(); }
        async startPolling(onUid) {
            if (this.brg && this.brg.startPolling) return this.brg.startPolling(onUid);
            this._loop = setInterval(async () => {
                try { const u = await this.readUid(); if (u && onUid) onUid(u); } catch (e) {}
            }, 600);
        }
        _stopLoop() { if (this._loop) { clearInterval(this._loop); this._loop = null; } }
    }

    /* ---------- Fabrique ---------- */
    function createAdapter(name) {
        switch (name) {
            case 'driver':   return new DriverAdapter(config.driver);
            case 'bridge':   return new BridgeAdapter(config.bridge || window.NfcBridge);
            case 'simulate': return new SimulateAdapter();
            case 'webnfc':   return new WebNfcAdapter();
            case 'pcnfc':    return new PcNfcAdapter();
            default: throw new Error('Adaptateur NFC inconnu : ' + name);
        }
    }

    /* ==========================================================
       API PUBLIQUE
       ========================================================== */
    const service = {
        DEFAULT_CONFIG,

        /* Configurer le mode + driver/bridge sans coder de matériel ici.
           Ex. :
             NFCReaderService.setTransportConfig({ adapter:'driver', driver: myReaderDriver });
             NFCReaderService.setTransportConfig({ adapter:'bridge' });       // utilise window.NfcBridge
             NFCReaderService.setTransportConfig({ adapter:'simulate' });     // dev uniquement */
        setTransportConfig(cfg) {
            config = Object.assign({}, DEFAULT_CONFIG, cfg || {});
        },

        getAdapterName() { return config.adapter || 'bridge'; },

        async connect() {
            await this.disconnect();
            emitStatus('connecting', 'Connexion du lecteur NFC externe…');
            activeAdapter = createAdapter(config.adapter || 'bridge');
            await activeAdapter.connect();
            return activeAdapter;
        },

        async disconnect() {
            if (activeAdapter) {
                try { await activeAdapter.disconnect(); } catch (e) {}
                activeAdapter = null;
            }
        },

        isConnected() {
            return !!(activeAdapter && activeAdapter.isConnected());
        },

        async readUID() {
            if (!activeAdapter || !activeAdapter.isConnected()) throw new Error('Lecteur non connecté');
            const uid = await activeAdapter.readUid();
            return this.normalizeUid(uid);
        },

        /* Test de connexion du lecteur */
        async testConnection() {
            if (!activeAdapter) {
                try { await this.connect(); } catch (e) { return { ok: false, message: e.message }; }
            }
            if (!activeAdapter.isConnected()) {
                return { ok: false, message: 'Lecteur non connecté' };
            }
            // Mode NFC intégré (Web NFC ou PC) : le lecteur est actif,
            // mais il ne fournit pas d'UID brut fiable
            if (typeof activeAdapter.supportsRawUid === 'function' && !activeAdapter.supportsRawUid()) {
                return { ok: false, message: '⚠ Lecture UID non disponible avec le NFC intégré. Utilisez le lecteur NFC externe USB/OTG.' };
            }
            try {
                if (activeAdapter.test) {
                    const r = await activeAdapter.test();
                    return { ok: !!r, message: r ? 'Lecteur opérationnel' : 'Lecteur détecté mais non opérationnel' };
                }
                return { ok: true, message: 'Lecteur opérationnel' };
            } catch (e) {
                return { ok: false, message: e.message };
            }
        },

        /* Capacités / sélection des modes */

        /* Web NFC (NFC intégré Android) disponible dans ce navigateur ? */
        webNfcAvailable() {
            return ('NDEFReader' in window);
        },

        /* NFC intégré du PC disponible (bridge PC/SC fourni) ? */
        pcNfcAvailable() {
            return PcNfcAdapter.isAvailable();
        },

        /* L'adapter actif peut-il fournir un UID fiable ? */
        supportsRawUid() {
            if (!activeAdapter) {
                const a = config.adapter || 'bridge';
                if (a === 'webnfc') return false;
                if (a === 'pcnfc') return PcNfcAdapter.isAvailable();
                return true;
            }
            if (typeof activeAdapter.supportsRawUid === 'function') return activeAdapter.supportsRawUid();
            return true;
        },

        /* Lecture NDEF (mode webnfc uniquement, expérimental) */
        readNdefMessage() {
            if (!activeAdapter || typeof activeAdapter.readNdefMessage !== 'function') {
                throw new Error('Lecture NDEF disponible uniquement avec le NFC intégré (webnfc).');
            }
            return activeAdapter.readNdefMessage();
        },

        startPolling(onUid) {
            if (!activeAdapter) throw new Error('Lecteur non connecté — appelez connect() d\'abord');
            return activeAdapter.startPolling(onUid);
        },
        stopPolling() {
            if (activeAdapter && activeAdapter._stopLoop) activeAdapter._stopLoop();
            return this;
        },

        onStatus(cb) {
            statusCallbacks.push(cb);
            return () => { const i = statusCallbacks.indexOf(cb); if (i >= 0) statusCallbacks.splice(i, 1); };
        },

        normalizeUid(raw) {
            if (raw === null || raw === undefined || typeof raw !== 'string') return '';
            return raw.trim().toUpperCase().replace(/\s+/g, '');
        },
        isSimulation() {
            return (config.adapter || 'bridge') === 'simulate';
        }
    };

    return service;
})();
