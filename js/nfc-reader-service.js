// ============================================================
// NFCReaderService — couche d'abstraction commune du lecteur NFC
// externe.
//
// Règle d'architecture : TOUTES les opérations NFC de l'application
// (attribution, validation présence, remplacement, test lecteur)
// passent par CE service unique. Aucun composant ne communique
// directement avec le matériel.
//
// Interface publique d'un transport :
//   connect()            -> Promise
//   disconnect()         -> Promise
//   isConnected()        -> boolean
//   readUid()            -> Promise<string>   // UID / Serial Number
//
// Le service expose : connect(), disconnect(), isConnected(),
// readUID(), onStatus(cb), plus une fabrique de transport.
//
// Transport : le plus important. Le lecteur cible est un lecteur
// 13.56 MHz compatible NTAG213/215/216 (ISO 14443A / NFC Forum Type 2).
// Deux transports sont fournis :
//   1. 'webusb'   — WebUSB (Chrome/Edge) : envoie les commandes de
//                  sélection ISO14443A et lit l'UID renvoyé par la carte.
//                  CONFIGURABLE (VID/PID/endpoint) car le modèle exact
//                  du lecteur n'est pas encore connu.
//   2. 'simulate' — lecteur simulé pour tester l'UI tant que le vrai
//                  matériel n'est pas branché. JAMAIS utilisé en prod.
//
// Extension : pour un autre matériel (PC/SC, HID, Bluetooth) il suffit
// d'ajouter un transport implémentant l'interface ci-dessus.
// ============================================================

window.NFCReaderService = (function () {

    /* ---------- Config transport par défaut (WebUSB) ----------
       Le modèle exact n'est pas défini : ces valeurs sont des pistes.
       L'utilisateur peut les surcharger via setTransportConfig(). */
    const DEFAULT_CONFIG = {
        transport: 'webusb',
        webusb: {
            // Exemples de lecteurs ISO 14443A (NTAG) :
            // ACR122U  : vendorId 0x072F, productId 0x2200
            // ACR1252U : vendorId 0x072F, productId 0x2250
            vendorId: 0x072F,
            productId: 0x2200,
            configValue: 1,
            interface: 0,
            // Endpoint bulk IN (réponse) — dépend du lecteur réel.
            // Si = -1, on lit via entrée de contrôle (CCID-like).
            inEndpoint: -1,
            outEndpoint: -1
        }
    };

    let config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    let transport = null;
    const statusCallbacks = [];

    /* ---------- Status helpers ---------- */
    function emitStatus(state, info) {
        const evt = { state, connected: state === 'connected', message: info || '', time: Date.now() };
        statusCallbacks.forEach(cb => { try { cb(evt); } catch (e) { console.error(e); } });
    }

    /* ==========================================================
       TRANSPORT : WebUSB (ISO 14443A)
       ==========================================================
       Envoie la séquence d'anti-collision ISO 14443A pour obtenir
       le Serial Number (UID) de la carte NTAG posée sur le lecteur.

       Commandes implémentées (selon le lemme PC/SC / ISO14443-3) :
         REQA/WUPA     26 / 52          (wake up)
         ANTICOLL casc1 93 20           -> 4 octets + BCC
         SELECT casc1   93 70 ...       (sélection indépendante du UID)
         / cascade level 2 (95 20) pour UID 7 octets.

       NB : le protocole exact de transport (CCID via controlTransfer
       vs HID via transferOut) dépend du modèle. Ce transport est donc
       générique + configurable ; à affiner une fois le lecteur connu.
       ========================================================== */
    class WebUsbTransport {
        constructor(cfg) {
            this.cfg = cfg;
            this.device = null;
            this.connected = false;
            this._readerLoop = null;
            this._onUid = null;
        }

        isConnected() { return this.connected; }

        async connect() {
            if (!('usb' in navigator)) {
                throw new Error('WebUSB non supporté par ce navigateur. Utilisez Chrome/Edge sur Windows ou Android.');
            }
            // Sélection du périphérique (l'utilisateur choisit son lecteur)
            this.device = await navigator.usb.requestDevice({
                filters: [{ vendorId: this.cfg.vendorId, productId: this.cfg.productId }]
            });
            await this.device.open();
            await this.device.selectConfiguration(this.cfg.configValue || 1);
            await this.device.claimInterface(this.cfg.interface || 0);
            this.connected = true;
            emitStatus('connected', 'Lecteur connecté');
            // Autorisation de reconnexion automatique
            navigator.usb.addEventListener('disconnect', (e) => {
                if (e.device === this.device) {
                    this.connected = false;
                    emitStatus('disconnected', 'Lecteur déconnecté');
                }
            });
            return this;
        }

        async disconnect() {
            this._stopReaderLoop();
            if (this.device) {
                try { await this.device.close(); } catch (e) { /* ignore */ }
            }
            this.device = null;
            this.connected = false;
            emitStatus('disconnected', 'Lecteur déconnecté');
        }

        /* ---------- Bas niveau : envoi d'une trame et réception ---------- */
        async _transferOut(dataBytes) {
            const data = new Uint8Array(dataBytes);
            const b = this.device;
            if (!b) throw new Error('Lecteur non connecté');
            if (this.cfg.outEndpoint >= 0) {
                await b.transferOut(this.cfg.outEndpoint, data);
            } else {
                // CCID-like : CLASS/VENDOR control transfer out, wValue interface)
                await b.controlTransferOut({
                    requestType: 'class',
                    recipient: 'interface',
                    request: 0x6B,          // PC_to_Reader_Secure (VENDOR_SPECIFIC selon lecteur)
                    value: 0x00,
                    index: (this.cfg.interface || 0)
                }, data);
            }
        }

        async _transferIn() {
            const b = this.device;
            if (!b) throw new Error('Lecteur non connecté');
            if (this.cfg.inEndpoint >= 0) {
                const res = await b.transferIn(this.cfg.inEndpoint, 256);
                return res.data ? new Uint8Array(res.data.buffer) : new Uint8Array(0);
            }
            const res = await b.controlTransferIn({
                requestType: 'class',
                recipient: 'interface',
                request: 0x6B,
                value: 0x00,
                index: (this.cfg.interface || 0)
            }, 256);
            return new Uint8Array(res.data.buffer);
        }

        /* ---------- Anti-collision ISO14443A : récupération UID ---------- */
        async readUid() {
            const b = this.device;
            if (!b || !this.connected) throw new Error('Lecteur non connecté');

            const REQA = 0x26;
            await this._transferOut([REQA]);
            await this._sleep(40);
            await this._drainIn();

            // Cascade 1 : anticollision
            await this._transferOut([0x93, 0x20]);
            const atqa = await this._transferIn();
            await this._sleep(30);

            // Niveau 1 : 4 octets UID
            await this._transferOut([0x93, 0x20]);
            let resp = await this._transferIn();
            await this._sleep(30);

            if (!resp || resp.length < 5) {
                // Niveau 2 (UID 7 octets) : SEL cascade 95 70
                await this._transferOut([0x95, 0x20]);
                resp = await this._transferIn();
                await this._sleep(30);
                // Poursuite sel 95 70 avec les octets déjà connus
                if (resp && resp.length >= 5) {
                    await this._transferOut([0x95, 0x70].concat(Array.from(resp.slice(0, 4))));
                    resp = await this._transferIn();
                }
            }

            const uid = this._extractUid(resp);
            if (!uid) throw new Error('Aucune carte détectée — placez la carte sur le lecteur.');
            return uid;
        }

        _extractUid(resp) {
            if (!resp || resp.length < 4) return null;
            // corps [len][...octets][cks] : on prend les octets utiles
            let body = resp;
            if (resp[0] >= 4) {            // format avec longueur explicite
                body = resp.slice(1);
            }
            // le dernier octet est le BCC (contrôle) -> exclu
            const uidBytes = Array.from(body).slice(0, body.length ? body.length - 1 : 0);
            if (!uidBytes.length) return null;
            // anticollision peut renvoyer SAK etc. On garde 4 ou 7 premiers octets significatifs
            const n = (uidBytes.length >= 7) ? 7 : (uidBytes.length >= 4 ? 4 : uidBytes.length);
            return this._formatUid(uidBytes.slice(0, n));
        }

        _formatUid(bytes) {
            return bytes.map(x => x.toString(16).padStart(2, '0').toUpperCase()).join(':');
        }

        async _drainIn() {
            try { await this._transferIn(); } catch (e) { /* rien */ }
        }
        _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

        /* ---------- Lecture continue (pour un scanner permanent) ---------- */
        startPolling(onUid) {
            this._onUid = onUid;
            this._readerLoop = setInterval(async () => {
                if (!this.connected) return;
                try {
                    const uid = await this.readUid();
                    if (uid && this._onUid) this._onUid(uid);
                } catch (e) { /* pas de carte -> on retente */ }
            }, 600);
        }

        _stopReaderLoop() {
            if (this._readerLoop) { clearInterval(this._readerLoop); this._readerLoop = null; }
        }
    }

    /* ==========================================================
       TRANSPORT : simulateur (dev/test uniquement, jamais en prod)
       ========================================================== */
    class SimulateTransport {
        constructor() { this.connected = false; this._onUid = null; this._loop = null; }
        isConnected() { return this.connected; }
        async connect() {
            this.connected = true;
            emitStatus('connected', 'Lecteur (simulation) connecté');
            return this;
        }
        async disconnect() { this.connected = false; emitStatus('disconnected', 'Simulation déconnectée'); }
        async readUid() {
            if (!this.connected) throw new Error('Lecteur non connecté');
            // UID de test simulé
            const mk = () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0').toUpperCase();
            await new Promise(r => setTimeout(r, 400));
            return `04:${mk()}:${mk()}:${mk()}:${mk()}:${mk()}:${mk()}`;
        }
        startPolling(onUid) { this._onUid = onUid; this._loop = setInterval(async () => { try { const u = await this.readUid(); if (u && this._onUid) this._onUid(u); } catch(e){} }, 1200); }
        _stopLoop() { if (this._loop) { clearInterval(this._loop); this._loop = null; } }
    }

    /* ---------- Fabrique ---------- */
    function createTransport(name) {
        switch (name) {
            case 'webusb': return new WebUsbTransport(Object.assign({}, DEFAULT_CONFIG.webusb, config.webusb || {}));
            case 'simulate': return new SimulateTransport();
            default:
                throw new Error('Transport NFC inconnu : ' + name);
        }
    }

    /* ==========================================================
       API PUBLIQUE DU SERVICE
       ========================================================== */
    const service = {
        DEFAULT_CONFIG,

        setTransportConfig(cfg) {
            config = Object.assign({}, DEFAULT_CONFIG, cfg || {});
        },

        async connect() {
            await this.disconnect();
            transport = createTransport(config.transport || 'webusb');
            emitStatus('connecting', 'Connexion du lecteur NFC…');
            await transport.connect();
            return transport;
        },

        async disconnect() {
            if (transport) {
                try { await transport.disconnect(); } catch (e) { /* ignore */ }
                transport = null;
            }
        },

        isConnected() {
            return !!(transport && transport.isConnected());
        },

        async readUID() {
            if (!transport || !transport.isConnected()) throw new Error('Lecteur non connecté');
            return transport.readUid();
        },

        /* Lecture continue : appelle onUid(uid) à chaque détection de carte.
           startPolling/stopPolling sont délégués au transport. */
        startPolling(onUid) {
            if (!transport) throw new Error('Lecteur non connecté — appelez connect() d\'abord');
            transport.startPolling(onUid);
            return this;
        },
        stopPolling() {
            if (transport && transport._stopReaderLoop) transport._stopReaderLoop();
            if (transport && transport._stopLoop) transport._stopLoop();
            return this;
        },

        /* Abonnement aux changements d'état */
        onStatus(cb) {
            statusCallbacks.push(cb);
            return () => { const i = statusCallbacks.indexOf(cb); if (i >= 0) statusCallbacks.splice(i, 1); };
        },

        /* Utilitaires UID */
        normalizeUid(raw) {
            return String(raw || '').trim().toUpperCase().replace(/\s+/g, '');
        },
        isSimulation() {
            return (config.transport || 'webusb') === 'simulate';
        }
    };

    return service;
})();
