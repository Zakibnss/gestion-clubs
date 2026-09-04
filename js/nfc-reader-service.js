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
    let _lastExternalAdapter = null;   // adapter externe opérateur (bridge/driver) restauré au retour du mode intégré
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
       (mode 'android-integrated', EXPERIMENTAL / COMPLÉMENTAIRE)
       ==========================================================
       Encapsule TOUT l'usage de NDEFReader ici — jamais dans les
       composants/UI. Ne fournit PAS l'UID brut/Serial Number d'une
       MIFARE Classic 1K de façon standard : readUid() REFUSE de
       fabriquer un UID à partir de données NDEF.

       Codes d'erreur (err.code) :
         WEB_NFC_UNAVAILABLE        - Web NFC indisponible dans ce contexte
         WEB_NFC_PERMISSION_DENIED  - autorisation refusée / scan bloqué
         WEB_NFC_SCAN_FAILED        - échec de scan
         WEB_NFC_UID_UNAVAILABLE    - carte détectée mais UID indisponible
         NFC_NOT_SUPPORTED          - navigateur/page non compatible
         NFC_SCAN_CANCELLED         - scan annulé
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

        /* Web NFC ne peut pas fournir l'UID MIFARE Classic 1K. */
        supportsRawUid() { return false; }

        isConnected() { return this.connected; }

        async connect() {
            if (!WebNfcAdapter.isAvailable()) {
                throw nfcError(NFC_ERROR_CODES.WEB_NFC_UNAVAILABLE,
                    'Web NFC non disponible. Utilisez Chrome sur Android en HTTPS, ou le lecteur externe.');
            }
            try {
                this.ndefReader = new NDEFReader();
                await this.ndefReader.scan();
                this.connected = true;
                emitStatus('connected', 'NFC intégré Android connecté');
            } catch (err) {
                this.connected = false;
                // L'utilisateur a refusé/annulé la permission ou le scan.
                const down = String(err && err.message || '').toLowerCase();
                throw nfcError(
                    /permission|cancel|denied|not allowed/.test(down)
                        ? NFC_ERROR_CODES.WEB_NFC_PERMISSION_DENIED
                        : NFC_ERROR_CODES.WEB_NFC_SCAN_FAILED,
                    'Impossible d\'activer le NFC intégré : ' + (err && err.message || 'erreur inconnue')
                );
            }
            return this;
        }

        async disconnect() {
            this.connected = false;
            if (this._unsub) { try { this._unsub(); } catch (e) {} this._unsub = null; }
            this.ndefReader = null;
            emitStatus('disconnected', 'NFC intégré Android déconnecté');
        }

        /* ⚠ Ne JAMAIS renvoyer un UID inventé à partir de NDEF. */
        async readUid() {
            throw nfcError(NFC_ERROR_CODES.WEB_NFC_UID_UNAVAILABLE,
                '⚠ Lecture UID non disponible avec le NFC intégré (Web NFC ne fournit pas l\'UID brut MIFARE Classic 1K). Utilisez le lecteur NFC externe USB/OTG.');
        }

        /* Lecture NDEF (expérimentale) — retourne le texte NDEF, PAS un UID.
           Utile uniquement pour des tags NDEF (NTAG) compatibles. */
        async readNdefMessage() {
            if (!this.connected || !this.ndefReader) throw nfcError(NFC_ERROR_CODES.NFC_NOT_SUPPORTED, 'NFC intégré non actif');
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
                const onError = (ev) => {
                    cleanup();
                    let code = NFC_ERROR_CODES.WEB_NFC_SCAN_FAILED;
                    let msg = 'Erreur de lecture NFC';
                    if (ev && (ev.error === 'NotAllowedError' || ev.error === 'SecurityError')) {
                        code = NFC_ERROR_CODES.WEB_NFC_PERMISSION_DENIED; msg = 'Autorisation NFC refusée';
                    }
                    reject(nfcError(code, msg));
                };
                const cleanup = () => {
                    this.ndefReader.removeEventListener('reading', onReading);
                    this.ndefReader.removeEventListener('error', onError);
                };
                this.ndefReader.addEventListener('reading', onReading);
                this.ndefReader.addEventListener('error', onError);
                // délai de sécurité
                setTimeout(() => { cleanup(); reject(nfcError(NFC_ERROR_CODES.NFC_SCAN_CANCELLED, 'Aucun tag NFC détecté.')); }, 8000);
            });
        }

        /* Test du NFC intégré : détecte réellement une carte qui passe
           devant le téléphone. Retourne { detected, uid, warning }.
           - detected=true  : une carte a été détectée.
           - uid            : UID si le navigateur l'expose (normalement non).
           - warning=true   : UID non garanti (limitation Web NFC).
           Ne fabrique JAMAIS un UID à partir du NDEF. */
        async testCard(timeoutMs) {
            timeoutMs = timeoutMs || 8000;
            const start = Date.now();
            // Attendre une carte : on espionne l'évènement 'reading' de NDEFReader.
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    cleanup();
                    resolve({ detected: false, uid: '', warning: false, timedOut: true });
                }, timeoutMs);

                const onReading = () => {
                    clearTimeout(timer);
                    cleanup();
                    // Carte détectée (via NDEF). L'UID n'est PAS exposé de façon fiable.
                    resolve({ detected: true, uid: '', warning: true, uidUnavailable: true });
                };
                const onError = (ev) => {
                    clearTimeout(timer);
                    cleanup();
                    let code = NFC_ERROR_CODES.WEB_NFC_SCAN_FAILED;
                    let msg = 'Erreur de lecture NFC';
                    if (ev && (ev.error === 'NotAllowedError' || ev.error === 'SecurityError')) {
                        code = NFC_ERROR_CODES.WEB_NFC_PERMISSION_DENIED; msg = 'Autorisation NFC refusée';
                    }
                    reject(nfcError(code, msg));
                };
                const cleanup = () => {
                    this.ndefReader.removeEventListener('reading', onReading);
                    this.ndefReader.removeEventListener('error', onError);
                };
                this.ndefReader.addEventListener('reading', onReading);
                this.ndefReader.addEventListener('error', onError);
            });
        }

        async test() { return this.connected; }

        async startPolling(onUid) {
            // En mode NFC intégré on ne peut pas poller l'UID : on notifie la
            // non-disponibilité pour le flux UID. L'application doit le savoir.
            if (onUid) onUid({ ndefOnly: true, uidUnavailable: true });
            this._loop = setInterval(() => {
                if (onUid) onUid({ ndefOnly: true, uidUnavailable: true });
            }, 5000);
        }
        _stopLoop() { if (this._loop) { clearInterval(this._loop); this._loop = null; } }
    }

    /* ==========================================================
       MODES DE LECTURE (NFCReaderMode)
       ==========================================================
       . 'external'           — lecteur NFC externe (USB / USB OTG).
       . 'android-integrated' — NFC intégré du smartphone Android via
                                Web NFC (mode complémentaire, expérimental).

       Windows utilise UNIQUEMENT 'external'. Le mode android-integrated
       n'est jamais proposé (ni Web NFC) sur Windows, ni sur iPhone.
       ========================================================== */
    const MODES = {
        EXTERNAL: 'external',
        ANDROID_INTEGRATED: 'android-integrated'
    };
    // L'adapter 'webnfc' incarne le mode 'android-integrated'.
    const MODE_TO_ADAPTER = {
        [MODES.EXTERNAL]: 'bridge',          // défaut : bridge externe de l'opérateur
        [MODES.ANDROID_INTEGRATED]: 'webnfc'
    };

    /* ==========================================================
       CODES D'ERREUR WEB NFC (lisibles par l'application)
       ========================================================== */
    const NFC_ERROR_CODES = {
        WEB_NFC_UNAVAILABLE: 'WEB_NFC_UNAVAILABLE',
        WEB_NFC_PERMISSION_DENIED: 'WEB_NFC_PERMISSION_DENIED',
        WEB_NFC_SCAN_FAILED: 'WEB_NFC_SCAN_FAILED',
        WEB_NFC_UID_UNAVAILABLE: 'WEB_NFC_UID_UNAVAILABLE',
        NFC_NOT_SUPPORTED: 'NFC_NOT_SUPPORTED',
        NFC_SCAN_CANCELLED: 'NFC_SCAN_CANCELLED'
    };

    function nfcError(code, message) {
        const err = new Error(message);
        err.code = code;
        return err;
    }

    /* ---------- Fabrique ---------- */
    function createAdapter(name) {
        switch (name) {
            case 'driver':   return new DriverAdapter(config.driver);
            case 'bridge':   return new BridgeAdapter(config.bridge || window.NfcBridge);
            case 'simulate': return new SimulateAdapter();
            case 'webnfc':   return new WebNfcAdapter();
            default: throw new Error('Adaptateur NFC inconnu : ' + name);
        }
    }

    /* ==========================================================
       API PUBLIQUE
       ========================================================== */
    const service = {
        DEFAULT_CONFIG,
        NFC_ERROR_CODES,
        MODES,

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
            const adapterName = config.adapter || 'bridge';
            const mode = this.getMode();
            // Mémoriser l'adapter externe opérateur (bridge/driver…) pour
            // pouvoir le restaurer après un passage en mode NFC intégré.
            if (mode !== MODES.ANDROID_INTEGRATED) _lastExternalAdapter = adapterName;
            emitStatus('connecting', mode === MODES.ANDROID_INTEGRATED
                ? 'Activation du NFC intégré Android…' : 'Connexion du lecteur NFC externe…');
            activeAdapter = createAdapter(adapterName);
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

        /* ---------- Compatibilité plateforme ---------- */
        isAndroid() {
            return /Android/i.test(navigator.userAgent);
        },
        isWindows() {
            return /Windows/i.test(navigator.userAgent);
        },
        isIOS() {
            return /iPhone|iPad|iPod/i.test(navigator.userAgent);
        },

        /* Définition des modes (NFCReaderMode) */
        getModes() { return MODES; },
        getMode() {
            const a = config.adapter || 'bridge';
            // adapter 'webnfc' incarne le mode 'android-integrated'
            return a === 'webnfc' ? MODES.ANDROID_INTEGRATED : MODES.EXTERNAL;
        },
        setMode(mode) {
            if (mode === MODES.ANDROID_INTEGRATED) {
                // Mémoriser l'adapter externe pour pouvoir y revenir, puis
                // passer en Web NFC.
                _lastExternalAdapter = config.adapter || 'bridge';
                return this.setTransportConfig({ adapter: MODE_TO_ADAPTER[MODES.ANDROID_INTEGRATED] });
            }
            // external : restaurer l'adapter externe opérateur (bridge/driver…)
            const ext = _lastExternalAdapter || config.bridge || 'bridge';
            _lastExternalAdapter = null;
            return this.setTransportConfig({ adapter: ext });
        },

        /* Modes réellement proposables sur CET appareil.
           Windows : externe uniquement (jamais Web NFC / NFC interne).
           Android : externe + android-integrated.
           iPhone  : externe uniquement. */
        supportedModes() {
            const modes = [MODES.EXTERNAL];
            if (this.isAndroid() && this.isWebNFCAvailable()) {
                modes.push(MODES.ANDROID_INTEGRATED);
            }
            return modes;
        },

        /* Détection : le NFC intégré Android (Web NFC) est-il disponible ?
           Vérifie : navigateur compatible + NDEFReader + HTTPS + Android.
           (Web NFC n'existe pas fiabilment sur Windows/iPhone.) */
        isWebNFCAvailable() {
            if (!this.isAndroid()) return false;             // jamais sur Windows/iPhone
            if (typeof window === 'undefined') return false;
            if (!('NDEFReader' in window)) return false;     // navigateur non compatible
            try {
                if (window.isSecureContext !== true) return false; // HTTPS requis
            } catch (e) { /* ignore */ }
            return true;
        },

        /* Web NFC disponible dans ce navigateur (indépendant de la plateforme) */
        webNfcAvailable() {
            return ('NDEFReader' in window);
        },

        /* L'adapter actif peut-il fournir un UID fiable ? */
        supportsRawUid() {
            if (!activeAdapter) {
                const a = config.adapter || 'bridge';
                if (a === 'webnfc') return false;
                return true;
            }
            if (typeof activeAdapter.supportsRawUid === 'function') return activeAdapter.supportsRawUid();
            return true;
        },

        /* Lecture NDEF (mode android-integrated uniquement, expérimental) */
        readNdefMessage() {
            if (!activeAdapter || typeof activeAdapter.readNdefMessage !== 'function') {
                throw new Error('Lecture NDEF disponible uniquement avec le NFC intégré (webnfc).');
            }
            return activeAdapter.readNdefMessage();
        },

        /* Test du NFC intégré Android : détecte réellement une carte.
           Retourne { detected, uid, warning, timedOut } sans jamais
           fabriquer un UID à partir du NDEF. */
        async testIntegratedCard(timeoutMs) {
            if (!activeAdapter) {
                await this.connect();
            }
            if (!activeAdapter || typeof activeAdapter.testCard !== 'function') {
                return { ok: false, message: 'Mode NFC intégré non actif.' };
            }
            return activeAdapter.testCard(timeoutMs);
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
