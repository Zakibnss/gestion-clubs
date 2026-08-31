// ============================================================
// SAMPLE DRIVER — Lecteur NFC externe (MIFARE Classic 1K, UID only)
// ------------------------------------------------------------
// CECI EST UN GABARIT (template). Il n'est PAS chargé activement.
//
// L'application n'invente JAMAIS le protocole ni le VID/PID du
// lecteur. Pour utiliser un lecteur réel, l'opérateur doit créer un
// driver conforme à l'interface ci-dessous avec les valeurs RÉELLES
// de son matériel, puis l'activer :
//
//   NFCReaderService.setTransportConfig({
//       adapter: 'driver',
//       driver : new MyReaderDriver({ ... valeurs réelles de votre lecteur ... })
//   });
//
// Interface driver attendue par NFCReaderService :
//   open()                         -> Promise
//   close()                        -> Promise
//   isConnected()                  -> boolean
//   readUid()                      -> Promise<string> "AA:BB:CC:.."
//   test()                         -> Promise<boolean>   (optionnel)
//   startPolling(onUid)            -> (optionnel) si le lecteur gère les callbacks
// ============================================================

// Exemple de squelette (à compléter selon le modèle exact du lecteur).
// NE PAS DÉPLOYER AVEC DES VALEURS FICTIVES.
/*
class MyReaderDriver {
    constructor(options) {
        // REMPLACER par les vraies caractéristiques du lecteur :
        //   options.vendorId, options.productId, endpoints, etc.
        this.options = options || {};
        this.device = null;
    }

    isConnected() {
        return !!(this.device && this.device.opened);
    }

    async open() {
        // REMPLACER par la vraie méthode d'ouverture du lecteur.
        // ex : WebUSB (navigator.usb.requestDevice), Web Serial (navigator.serial),
        //      HID (navigator.hid), ou connexion à un bridge (voir js/bridge).
        // Aucune valeur n'est codée en dur ici : tout vient de this.options.
        // this.device = await navigator.usb.requestDevice({ filters: [this.options.filter] });
        // await this.device.open();
        // await this.device.claimInterface(this.options.interface);
    }

    async close() {
        // Fermeture propre du lecteur.
    }

    async readUid() {
        if (!this.isConnected()) throw new Error('Lecteur non connecté');
        // REMPLACER par l'envoi de la séquence d'anti-collision ISO14443A
        // RÉELLE du lecteur (selon sa doc : PC/SC, HID, USB, Serial…).
        // DOIT retourner uniquement l'UID de la carte, ex : "04:A7:32:91:BC:45:12"
        throw new Error('Driver non implémenté — voir nfc-driver-sample.js');
    }

    async test() {
        // Retourne true si le lecteur répond correctement.
        return this.isConnected();
    }
}
*/

// Export (non actif par défaut) pour être référencé/modifié par l'opérateur.
window.NfcDriverSample = { MyReaderDriver: null };
