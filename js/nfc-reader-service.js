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
// Flux :
//   External NFC Reader
//         ↓
//   NFC Reader Adapter (driver / bridge / simulate)
//         ↓
//   NFCReaderService  -> readUID() -> UID
//         ↓
//   App -> Supabase
//
// Device compatibility :
//   Windows   : USB -> WebUSB / Serial / HID / PC/SC (via driver ou bridge)
//   Android   : USB OTG -> le navigateur peut ne pas permettre l'accès USB
//               direct. Dans ce cas on utilise un BRIDGE (app native /
//               serveur local) qui lit le lecteur et expose readUID().
//   Le NFC interne du smartphone n'est JAMAIS utilisé. Web NFC jamais.
//
// Nombre de pilotes (adapters) fournis :
//   1. 'driver'   — utilise un driver injecté (config.driver) qui
//                   implémente { open, close, isConnected, readUid, test }.
//                   Permet le WebUSB/Serial/HID/PC/SC réel selon le lecteur.
//   2. 'bridge'   — utilise window.NfcBridge (app native / pont local pour
//                   Android & Windows) : { isConnected, readUid, test }.
//   3. 'simulate' — simulateur de dev/test (jamais en production).
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

    /* ---------- Fabrique ---------- */
    function createAdapter(name) {
        switch (name) {
            case 'driver':   return new DriverAdapter(config.driver);
            case 'bridge':   return new BridgeAdapter(config.bridge);
            case 'simulate': return new SimulateAdapter();
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
            return String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
        },
        isSimulation() {
            return (config.adapter || 'bridge') === 'simulate';
        }
    };

    return service;
})();
