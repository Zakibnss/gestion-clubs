// ============================================================
// UI CARTES NFC — vue d'inventaire + scanner (lecteur NFC externe)
// S'appuie sur :
//   . NfcCards         (js/nfc-cards.js)         -> logique métier/base
//   . NFCReaderService (js/nfc-reader-service.js) -> lecteur NFC externe
//
// Règle : la validation de présence et l'enregistrement des cartes
// utilisent EXCLUSIVEMENT le lecteur NFC externe via NFCReaderService.
// La saisie manuelle du UID n'existe qu'en section secondaire admin.
// ============================================================

/* =============================================================
   SCANNER DE PRÉSENCE — lecteur NFC externe
   ============================================================= */
let nfcPollingStarted = false;

// Adapter externe configuré par l'opérateur (hid/bridge/driver/...).
let nfcExternalAdapter = 'hid';
try { nfcExternalAdapter = NFCReaderService.getAdapterName() || 'hid'; } catch (e) { /* ignore */ }
let nfcSelectedMode = 'external';   // 'external' | 'android-integrated'

/* Modes réellement proposables (external toujours ; android-integrated
   uniquement sur Android + Web NFC + HTTPS). */
function nfcSupportedModes() {
    return NFCReaderService.supportedModes ? NFCReaderService.supportedModes() : ['external'];
}

/* Affichage de la dispo du NFC intégré Android */
function renderWebNfcStatus() {
    const el = document.getElementById('nfcWebNfcStatus');
    if (!el) return;
    // Sur Windows/iPhone : le NFC intégré n'est jamais proposé (spec).
    const canIntegrated = nfcSupportedModes().includes('android-integrated');
    if (!canIntegrated) {
        el.innerHTML = `<div>📱 NFC intégré Android — <span style="color:#dc3545;">🔴 Non disponible sur cet appareil</span></div>
            <div style="font-size:.78rem;margin-top:2px;">Utilisez le lecteur NFC externe USB / USB OTG.</div>`;
        return;
    }
    el.innerHTML = `<div>📱 NFC intégré Android — <span style="color:#28a745;">🟢 Disponible</span></div>
        <div style="font-size:.78rem;margin-top:2px;">⚠️ Le NFC intégré ne fournit pas l'UID brut d'une MIFARE Classic 1K. Le lecteur NFC externe reste le mode fiable.</div>`;
}

/* Bascule du mode de lecture */
function setNfcMode(mode) {
    nfcSelectedMode = mode;
    // Ne pas re-connecter si même mode déjà actif
    NfcCards.stopPolling();
    nfcPollingStarted = false;
    NFCReaderService.disconnect().catch(() => {});
    if (mode === 'android-integrated') {
        NFCReaderService.setMode('android-integrated');
        nfcReaderUi({
            connected: false,
            message: NFCReaderService.isWebNFCAvailable()
                ? 'Mode NFC intégré Android — cliquez sur Connecter, puis placez une carte près du téléphone.'
                : 'NFC intégré Android non disponible dans ce contexte'
        });
    } else {
        // external
        NFCReaderService.setMode('external');
        nfcReaderUi({ connected: false, message: 'Branchez le lecteur USB (HID Keyboard). Écoute automatique à la prochaine ouverture.' });
    }
    setNfcScannerCoreV2(false);
    setNfcScannerErrorV2('');
    renderNfcCardModeNote();
}

function nfcReaderUi(status) {
    const box = document.getElementById('nfcReaderStatus');
    if (!box) return;
    const c = status.connected;
    box.style.background = c
        ? 'rgba(40,167,69,.12)' : 'rgba(220,53,69,.1)';
    box.style.borderColor = c ? '#28a745' : '#dc3545';
    box.innerHTML = `
        <span style="font-size:1.2rem;">${c ? '🟢' : '🔴'}</span>
        <div>
            <div style="font-weight:700;" id="nfcReaderStatusTitle">${c ? 'Lecteur connecté' : 'Lecteur non connecté'}</div>
            <div style="font-size:.8rem;color:var(--text-secondary);" id="nfcReaderStatusSub">
                ${status.message || (c ? 'Prêt à scanner — présentez la carte.' : 'Branchez le lecteur USB puis cliquez sur Connecter.')}
            </div>
        </div>`;
    const connectBtn = document.getElementById('nfcConnectBtn');
    const disconnectBtn = document.getElementById('nfcDisconnectBtn');
    const core = document.getElementById('nfcScannerCore');
    if (connectBtn) connectBtn.style.display = c ? 'none' : '';
    if (disconnectBtn) disconnectBtn.style.display = c ? '' : 'none';
    // Le cœur du scanner n'apparaît que si le lecteur est connecté
    if (core) core.style.display = c ? '' : 'none';
}

async function connectNfcReader() {
    const btn = document.getElementById('nfcConnectBtn');
    btn.disabled = true;
    try {
        await NFCReaderService.connect();
        nfcReaderUi({ connected: true, message: 'Prêt à scanner' });

        // NFC intégré (Web NFC / PC) sans UID brut : on n'utilise pas la
        // boucle de présence par UID et on affiche l'avertissement.
        if (!NFCReaderService.supportsRawUid()) {
            const res = document.getElementById('nfcScanResult');
            res.innerHTML = `<div class="alert alert-warning">
                ⚠ <strong>Lecture UID non disponible avec le NFC intégré.</strong><br>
                Ce mode ne fournit pas l'UID brut d'une MIFARE Classic 1K.<br>
                Utilisez le lecteur NFC externe USB/OTG.
            </div>`;
            document.getElementById('nfcScannerCore').style.display = 'none';
            return;
        }

        // Lecteur externe : boucle de lecture continue de l'UID
        if (!nfcPollingStarted) {
            NfcCards.startPolling(onScannedUid);
            nfcPollingStarted = true;
        }
        setNfcScannerState('ready');
        loadNfcScannerHistory();
    } catch (err) {
        console.error(err);
        nfcReaderUi({ connected: false, message: err.message });
        setNfcScannerErrorV2(err.message);
    } finally {
        btn.disabled = false;
    }
}

/* Test du lecteur (mode externe) : le navigateur ne peut pas détecter
   lui-même la présence physique du lecteur HID (« USB Composite Device /
   HID Keyboard »). On affiche donc « 🟡 Prêt à scanner », on attend la
   frappe RÉELLE d'une carte, puis :
     . 🟢 Lecture réussie + valeur détectée (lecteur opérationnel)
     . 🔴 Aucune lecture détectée dans le délai
*/
async function testNfcReader() {
    const msg = document.getElementById('nfcScanResult');
    if (nfcSelectedMode === 'android-integrated') {
        await testIntegratedNfc();
        return;
    }
    try {
        if (!NFCReaderService.isConnected()) {
            await NFCReaderService.connect();
        }
        msg.innerHTML = `<div class="alert alert-warning" style="background:rgba(255,193,7,.12);border-color:#ffc107;">
            📡 <strong>Lecteur NFC externe</strong><br><br>
            🟡 <strong>Prêt à scanner</strong><br>
            Présentez une carte sur le lecteur.
        </div>`;
        const res = await NFCReaderService.testScan(10000);
        if (res.ok && res.value) {
            msg.innerHTML = `<div class="alert alert-success">✓ <strong>Lecture réussie</strong><br>
                📡 <strong>Lecteur opérationnel</strong><br>
                Type&nbsp;: <strong>HID Keyboard</strong><br><br>
                Valeur détectée&nbsp;:<br>
                <code style="font-size:1.1rem;font-weight:700;">${escapeHtmlV2(NFCReaderService.normalizeUid(res.value))}</code><br><br>
                <button class="btn btn-secondary btn-sm" onclick="testNfcReader()">🧪 Tester à nouveau</button></div>`;
        } else {
            msg.innerHTML = `<div class="alert alert-danger">🔴 <strong>Aucune lecture détectée.</strong><br>
                Présentez une carte et vérifiez que le lecteur USB est bien branché (HID Keyboard).</div>`;
        }
    } catch (err) {
        console.error(err);
        msg.innerHTML = `<div class="alert alert-danger">🔴 ${escapeHtmlV2(err.message)}</div>`;
    }
}

/* Test du NFC intégré Android : on attend qu'une carte passe près du
   téléphone, puis on rapporte UID (si exposé) ou l'avertissement
   WEB_NFC_UID_UNAVAILABLE (limitation API — jamais d'UID inventé). */
async function testIntegratedNfc() {
    const msg = document.getElementById('nfcScanResult');
    try {
        if (!NFCReaderService.isConnected()) {
            await NFCReaderService.connect();
        } else if (NFCReaderService.supportsRawUid()) {
            // Le NFC intégré ne fournit jamais d'UID fiable
        }
        if (!NFCReaderService.isConnected()) {
            msg.innerHTML = `<div class="alert alert-warning">Impossible d'activer le NFC intégré.</div>`;
            return;
        }
        msg.innerHTML = `<div class="alert alert-info">📱 NFC intégré Android<br>Placez une carte NFC près du téléphone...</div>`;
        const r = await NFCReaderService.testIntegratedCard(8000);
        if (r.timedOut) {
            msg.innerHTML = `<div class="alert alert-warning">Aucune carte détectée. Approchez une carte du téléphone.</div>`;
        } else if (r.detected) {
            if (r.uid) {
                msg.innerHTML = `<div class="alert alert-success">✓ Carte détectée<br><strong>UID&nbsp;:</strong> <code>${escapeHtmlV2(NFCReaderService.normalizeUid(r.uid))}</code></div>`;
            } else {
                msg.innerHTML = `<div class="alert alert-warning">⚠ Carte détectée<br>Le NFC intégré a détecté la carte, mais le navigateur ne fournit pas le UID nécessaire. Utilisez le lecteur NFC externe.</div>`;
            }
        }
    } catch (err) {
        const code = err && err.code;
        let text = escapeHtmlV2(err && err.message || 'Erreur');
        if (code === 'WEB_NFC_PERMISSION_DENIED') {
            text = 'Autorisation NFC refusée. Activez le NFC et autorisez-le dans le navigateur.';
        } else if (code === 'WEB_NFC_UNAVAILABLE') {
            text = 'NFC intégré indisponible. Utilisez le lecteur NFC externe USB/OTG.';
        }
        msg.innerHTML = `<div class="alert alert-warning">⚠ ${text}</div>`;
    }
}

async function disconnectNfcReader() {
    NfcCards.stopPolling();
    nfcPollingStarted = false;
    if (nfcAutoResetTimer) { clearTimeout(nfcAutoResetTimer); nfcAutoResetTimer = null; }
    nfcProcessing = false;
    try { await NFCReaderService.disconnect(); } catch (e) { /* ignore */ }
    nfcReaderUi({ connected: false, message: 'Lecteur déconnecté' });
    setNfcScannerCoreV2(false);
}

function closeNfcScanner() {
    NfcCards.stopPolling();
    nfcPollingStarted = false;
    if (nfcAutoResetTimer) { clearTimeout(nfcAutoResetTimer); nfcAutoResetTimer = null; }
    nfcProcessing = false;
    closeModal('nfcScannerModal');
}

/* ---------- États visuels du cœur du scanner ---------- */
function setNfcScannerCoreV2(show) {
    const el = document.getElementById('nfcScannerCore');
    if (el) el.style.display = show ? '' : 'none';
}

function setNfcScannerState(state) {
    const el = document.getElementById('nfcScannerCore');
    if (!el) return;
    el.style.display = '';
    const title = document.getElementById('nfcScannerTitle');
    const sub = document.getElementById('nfcScannerSub');
    const res = document.getElementById('nfcScanResult');
    if (state === 'ready') {
        title.textContent = '📡 Prêt à scanner';
        sub.textContent = 'Présentez une carte';
        res.innerHTML = '';
    } else if (state === 'reading') {
        title.textContent = '🔄 Lecture en cours…';
        sub.textContent = 'Ne retirez pas la carte.';
        res.innerHTML = '';
    } else {
        el.style.display = 'none';
    }
}

function setNfcScannerErrorV2(msg) {
    const res = document.getElementById('nfcScanResult');
    if (res) res.innerHTML = `<div class="alert alert-danger">${escapeHtmlV2(msg)}</div>`;
}

function renderNfcWebNfcWarning() {
    setNfcScannerCoreV2(false);
    const res = document.getElementById('nfcScanResult');
    if (res) res.innerHTML = `<div class="alert alert-warning">
        ⚠ <strong>Lecture UID non disponible avec le NFC intégré.</strong><br>
        Utilisez le lecteur NFC externe USB/OTG pour lire l'UID des cartes MIFARE Classic.
    </div>`;
}

/* ---------- Détection d'une carte (via lecteur externe) ---------- */
let nfcProcessing = false;
let nfcAutoResetTimer = null;

async function onScannedUid(rawUid) {
    if (nfcProcessing) return;
    nfcProcessing = true;

    // Marqueur du WebNfcAdapter : NDEF seulement, pas d'UID
    if (rawUid && typeof rawUid === 'object' && rawUid.uidUnavailable) {
        renderNfcWebNfcWarning();
        nfcProcessing = false;
        return;
    }

    const uid = NFCReaderService.normalizeUid(rawUid);
    if (!uid) { nfcProcessing = false; return; }

    setNfcScannerState('reading');

    try {
        const res = await NfcCards.scanPresence(uid, v2GetActiveClubId(), { method: 'NFC' });
        renderNfcScanResult(res);
        loadNfcScannerHistory();
        // Retour automatique à "Prêt à scanner" pour l'adhérent suivant,
        // quel que soit le résultat (présence, expiré, inconnu…).
        scheduleNfcAutoReset(3000);
    } catch (err) {
        console.error(err);
        setNfcScannerErrorV2(err.message);
        scheduleNfcAutoReset(3000);
    }
}

/* Retour automatique de l'écran à « Prêt à scanner » après un scan.
   Un scan plus récent annule le reset programmé par un scan précédent
   (jamais un message ne réaffiche l'état précédent). */
function scheduleNfcAutoReset(delayMs) {
    clearTimeout(nfcAutoResetTimer);
    nfcAutoResetTimer = setTimeout(() => {
        nfcAutoResetTimer = null;
        nfcProcessing = false;
        setNfcScannerState('ready');
    }, delayMs);
}

function renderNfcScanResult(res) {
    const el = document.getElementById('nfcScannerCore');
    el.style.display = '';
    const title = document.getElementById('nfcScannerTitle');
    const sub = document.getElementById('nfcScannerSub');

    if (!res.ok && (res.result === 'unknown' || res.result === 'unassigned')) {
        title.textContent = '⚠ Carte inconnue';
        sub.textContent = 'UID : ' + escapeHtmlV2(res.uid);
        document.getElementById('nfcScanResult').innerHTML = `
            <div class="alert alert-warning">
                <strong>Cette carte n'est associée à aucun adhérent.</strong><br>
                <div style="font-size:.9rem;margin-top:6px;">UID détecté : <code>${escapeHtmlV2(res.uid)}</code></div>
                <div style="margin-top:10px;display:flex;gap:8px;justify-content:center;">
                    <button class="btn btn-primary btn-sm" onclick="assignScannedCard('${escapeAttr(res.uid)}')">Attribuer à un adhérent</button>
                    <button class="btn btn-secondary btn-sm" onclick="setNfcScannerState('ready');">Annuler</button>
                </div>
            </div>`;
        return;
    }

    if (res.expired) {
        // Carte lue + adhérent identifié + présence ENREGISTRÉE malgré
        // l'abonnement expiré (couleur avertissement, pas succès).
        const m = res.member || {};
        title.textContent = '⚠ Présence enregistrée — abonnement expiré';
        sub.textContent = escapeHtmlV2(m.last_name ? m.last_name + ' ' + m.first_name : '');
        const dateFmt = res.date ? new Date(res.date + 'T00:00:00').toLocaleDateString('fr-FR') : '';
        document.getElementById('nfcScanResult').innerHTML = `
            <div class="alert alert-warning">
                <div style="font-size:1.15rem;font-weight:700;margin-bottom:4px;">${escapeHtmlV2(m.last_name || '')} ${escapeHtmlV2(m.first_name || '')}</div>
                <div style="font-size:.9rem;color:var(--text-secondary);">
                    ID : #${escapeHtmlV2(m.id || '')}${res.groupName ? ' — Groupe : ' + escapeHtmlV2(res.groupName) : ''}
                </div>
                <hr style="margin:8px 0;border:none;border-top:1px solid rgba(255,255,255,.2);">
                <div style="font-size:.9rem;">
                    Présence :<br><strong>${dateFmt} — ${escapeHtmlV2(res.time)}</strong><br>
                    <span style="color:var(--warn);">Abonnement expiré — présence quand même validée.</span>
                </div>
            </div>`;
        return;
    }

    if (!res.ok && res.result === 'expired') {
        title.textContent = '⛔ Abonnement expiré';
        sub.textContent = escapeHtmlV2(res.member ? res.member.last_name + ' ' + res.member.first_name : '');
        document.getElementById('nfcScanResult').innerHTML =
            `<div class="alert alert-danger"><strong>Abonnement expiré</strong><br>${escapeHtmlV2(res.detail)}</div>`;
        return;
    }

    if (res.duplicate) {
        title.textContent = 'ℹ Présence déjà enregistrée';
        sub.textContent = escapeHtmlV2(res.member ? res.member.last_name + ' ' + res.member.first_name : '');
        document.getElementById('nfcScanResult').innerHTML =
            `<div class="alert alert-info"><strong>Présence déjà enregistrée</strong><br>${escapeHtmlV2(res.detail)}</div>`;
        return;
    }

    // Succès
    const m = res.member || {};
    title.textContent = '✓ Présence enregistrée';
    sub.textContent = '';
    const dateFmt = res.date ? new Date(res.date + 'T00:00:00').toLocaleDateString('fr-FR') : '';
    document.getElementById('nfcScanResult').innerHTML = `
        <div class="alert alert-success">
            <div style="font-size:1.15rem;font-weight:700;margin-bottom:4px;">${escapeHtmlV2(m.last_name || '')} ${escapeHtmlV2(m.first_name || '')}</div>
            <div style="font-size:.9rem;color:var(--text-secondary);">
                ID : #${escapeHtmlV2(m.id || '')}${res.groupName ? ' — Groupe : ' + escapeHtmlV2(res.groupName) : ''}
            </div>
            <hr style="margin:8px 0;border:none;border-top:1px solid rgba(255,255,255,.2);">
            <div style="font-size:.9rem;">
                Présence :<br><strong>${dateFmt} — ${escapeHtmlV2(res.time)}</strong>
            </div>
        </div>`;
}

/* Attribution depuis le scanner (carte non attribuée) */
function assignScannedCard(uid) {
    setNfcScannerState('ready');
    openNfcCardModal(null, uid);
}

/* Indique dans le modal carte la méthode de lecture active. */
function renderNfcCardModeNote() {
    const el = document.getElementById('nfcCardModeNote');
    if (!el) return;
    el.innerHTML = nfcSelectedMode === 'android-integrated'
        ? `<span style="color:#e0a800;">📱 Méthode active&nbsp;: NFC intégré du smartphone (l'UID ne peut pas être lu ici — utilisez le lecteur externe pour lire l'UID).</span>`
        : `🔌 Méthode active : Lecteur NFC externe — appuyez sur « 📡 Lire la carte » puis placez la carte sur le lecteur.`;
}

/* ---------- Lecture d'un UID dans le modal d'enregistrement ---------- */
async function readUidIntoCardModal() {
    const btn = document.getElementById('nfcReadBtn');
    const msg = document.getElementById('nfcCardMessage');
    btn.disabled = true;

    // Mode NFC intégré : ne fournit pas l'UID ; on prévient clairement.
    if (nfcSelectedMode === 'android-integrated') {
        msg.innerHTML = `<div class="alert alert-warning">⚠ <strong>Lecture UID non disponible avec le NFC intégré.</strong><br>
            Le Web NFC ne fournit pas l'UID brut d'une MIFARE Classic 1K.<br>
            Passez en méthode <strong>Lecteur NFC externe</strong> pour lire l'UID d'une carte.</div>`;
        btn.disabled = false;
        return;
    }

    msg.innerHTML = '<div class="alert alert-info">📡 Placez la carte sur le lecteur…</div>';
    try {
        if (!NFCReaderService.isConnected()) {
            await NFCReaderService.connect();
        }
        const uid = await NFCReaderService.readUID();
        if (!uid) throw new Error('Aucune carte détectée.');
        document.getElementById('nfcUid').value = NFCReaderService.normalizeUid(uid);
        msg.innerHTML = `<div class="alert alert-success">✓ Carte détectée — UID : <code>${escapeHtmlV2(NFCReaderService.normalizeUid(uid))}</code></div>`;
    } catch (err) {
        console.error(err);
        msg.innerHTML = `<div class="alert alert-danger">${escapeHtmlV2(err.message)}</div>`;
    } finally {
        btn.disabled = false;
    }
}

/* ---------- Saisie manuelle (admin, cas exceptionnel) ---------- */
async function performNfcScan() {
    const uid = NfcCards.buildUidFromText(document.getElementById('nfcScanInput').value);
    if (!uid) return;
    document.getElementById('nfcScanInput').value = '';
    await onScannedUid(uid);
}

/* ---------- Historique du scanner ---------- */
let nfcScanViewEpoch = 0;   // incrémenté quand on affiche l'historique d'une carte

async function loadNfcScannerHistory() {
    const epoch = nfcScanViewEpoch;
    try {
        const h = await NfcCards.listAllHistory(30);
        // Ne pas écraser un historique-carte affiché entre-temps.
        if (epoch !== nfcScanViewEpoch) return;
        renderNfcScanHistory(h);
    } catch (e) { /* silencieux */ }
}
function renderNfcScanHistory(h) {
    const el = document.getElementById('nfcScanHistory');
    el.innerHTML = h.length
        ? h.slice(0, 30).map(x => `<div style="padding:4px 0;border-bottom:1px solid var(--border);font-size:.85rem;">
            ${new Date(x.scan_time).toLocaleString('fr-FR')} — ${NFC_RESULT_LABEL[x.scan_result] || x.scan_result}
            <span style="color:var(--text-secondary);">UID <code>${escapeHtmlV2(x.uid)}</code></span></div>`).join('')
        : '<p style="color:var(--text-secondary);">Aucun scan.</p>';
}

/* Affiche/masque l'option "NFC intégré Android" dans le sélecteur.
   Windows/iPhone : uniquement lecteur externe (spec). */
function updateNfcModeSelector() {
    const wrap = document.getElementById('nfcIntegratedModeWrap');
    if (!wrap) return;
    const canIntegrated = nfcSupportedModes().includes('android-integrated');
    wrap.style.display = canIntegrated ? '' : 'none';
    // Si le mode intégré n'est pas proposable, forcer le mode externe.
    if (!canIntegrated && nfcSelectedMode === 'android-integrated') {
        const radio = document.querySelector('input[name="nfcMode"][value="external"]');
        if (radio) { radio.checked = true; }
        setNfcMode('external');
    }
}

/* ---------- Armement du scanner (R30 / HID Keyboard) ---------- */
/* En mode externe, l'écoute HID est armée immédiatement : le R30 tape
   les UID dans la page et la boucle de présence traite chaque carte
   automatiquement — aucun clic sur « Connecter » requis dans le
   workflow normal. En mode NFC intégré (webnfc), l'activation reste
   manuelle (permission navigateur obligatoire). */
async function armNfcScanner() {
    if (nfcSelectedMode === 'android-integrated') {
        setNfcScannerCoreV2(false);
        nfcReaderUi({ connected: false, message: 'Mode NFC intégré — cliquez sur Connecter puis placez la carte près du téléphone.' });
        return;
    }
    setNfcScannerCoreV2(true);
    nfcReaderUi({ connected: true, message: 'Prêt à scanner — présentez la carte.' });
    try {
        await NFCReaderService.connect();
        if (!nfcPollingStarted) {
            NfcCards.startPolling(onScannedUid);
            nfcPollingStarted = true;
        }
        setNfcScannerState('ready');
    } catch (err) {
        console.error(err);
        nfcReaderUi({ connected: false, message: err.message || 'Connexion du lecteur impossible.' });
        setNfcScannerErrorV2(err.message || 'Connexion du lecteur impossible.');
    }
}

/* ---------- Ouverture du scanner ---------- */
async function openNfcScanner() {
    renderWebNfcStatus();
    updateNfcModeSelector();
    document.getElementById('nfcScanResult').innerHTML = '';
    await armNfcScanner();
    loadNfcScannerHistory();
    openModal('nfcScannerModal');
}

/* Subscription permanente à l'état du lecteur (déconnexion USB) */
NFCReaderService.onStatus(s => {
    const opened = document.getElementById('nfcScannerModal')?.classList.contains('active');
    if (opened) nfcReaderUi(s);
    if (!s.connected && opened) setNfcScannerCoreV2(false);
});

/* =============================================================
   INVENTAIRE / ADMINISTRATION
   ============================================================= */
async function loadNfcCards() {
    const section = document.getElementById('nfcCardsSection');
    if (!section) return;

    if (currentClub === 'admin') await v2PopulateAdminClubSelect('nfcToolbar');
    const clubId = v2GetActiveClubId();

    try {
        const [cards, history] = await Promise.all([
            NfcCards.listCards(currentFilters()),
            clubId ? NfcCards.listAllHistory(100) : Promise.resolve([])
        ]);
        renderNfcStats(cards, history);
        renderNfcCardsTable(cards);
        renderNfcHistory(history);
    } catch (err) {
        console.error(err);
        document.getElementById('nfcMessage').innerHTML =
            `<div class="alert alert-danger">Erreur de chargement : ${escapeHtmlV2(err.message)}</div>`;
    }
}

function currentFilters() {
    const q = document.getElementById('nfcSearch')?.value || '';
    const status = document.getElementById('nfcFilter')?.value || 'all';
    return { q, status };
}

function renderNfcStats(cards, history) {
    const assigned = cards.filter(c => c.status === 'assigned').length;
    document.getElementById('nfcStatTotal').textContent = cards.length;
    document.getElementById('nfcStatAssigned').textContent = assigned;
    document.getElementById('nfcStatScans').textContent = history.filter(h => h.scan_result === 'present').length;
}

const NFC_BADGE = { assigned: 'success', unassigned: 'secondary', lost: 'warning', retired: 'danger' };
const NFC_LABEL = { assigned: 'Attribuée', unassigned: 'Libre', lost: 'Perdue', retired: 'Retirée' };
const NFC_RESULT_LABEL = { present: '✅ Présent', unassigned: '⬜ Carte libre', expired: '⛔ Expiré', unknown: '❓ Inconnu' };

function renderNfcCardsTable(cards) {
    const tbody = document.getElementById('nfcCardsTable');
    if (!cards.length) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-secondary);padding:20px;">Aucune carte NFC enregistrée.</td></tr>`;
        return;
    }
    tbody.innerHTML = cards.map(c => `
        <tr>
            <td><code style="font-size:.85rem;">${escapeHtmlV2(c.uid)}</code></td>
            <td>${c.member_id
                ? memberAvatar(c) + ' ' + escapeHtmlV2(c.last_name + ' ' + c.first_name)
                : '<span style="color:var(--text-secondary)">— libre —</span>'}</td>
            <td><span class="badge badge-${NFC_BADGE[c.status] || 'secondary'}">${NFC_LABEL[c.status] || c.status}</span></td>
            <td>${c.assigned_at ? new Date(c.assigned_at).toLocaleDateString('fr-FR') : '—'}</td>
            <td>
                <button class="btn btn-info btn-sm" onclick="openNfcCardModal('${c.id}')">✏️</button>
                ${c.status === 'assigned'
                    ? `<button class="btn btn-warning btn-sm" onclick="replaceNfcCard('${c.id}')">🔁</button>
                       <button class="btn btn-warning btn-sm" onclick="unassignNfcCard('${c.id}', '${escapeAttr(c.uid)}')">↩️</button>`
                    : ''}
                <button class="btn btn-secondary btn-sm" onclick="viewNfcHistory('${escapeAttr(c.uid)}')">🕓</button>
            </td>
        </tr>`).join('');
}

function memberAvatar(c) {
    if (c.photo_url) {
        return `<img src="${c.photo_url}" onerror="this.style.display='none'"
            style="width:28px;height:28px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:6px;">`;
    }
    return '';
}

function escapeAttr(s) { return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;'); }

function renderNfcHistory(history) {
    const tbody = document.getElementById('nfcHistoryTable');
    if (!history.length) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--text-secondary);padding:20px;">Aucun scan enregistré.</td></tr>`;
        return;
    }
    tbody.innerHTML = history.slice(0, 50).map(h => `
        <tr>
            <td>${new Date(h.scan_time).toLocaleString('fr-FR')}</td>
            <td><code style="font-size:.8rem;">${escapeHtmlV2(h.uid)}</code></td>
            <td>${h.member_id ? escapeHtmlV2(h.member_id.slice(0, 8)) + '…' : '—'}</td>
            <td>${NFC_RESULT_LABEL[h.scan_result] || h.scan_result}</td>
            <td>${escapeHtmlV2(h.method || 'NFC')}</td>
        </tr>`).join('');
}

/* =============================================================
   MODAL CARTE — création / édition / attribution / remplacement
   ============================================================= */
let nfcEditingId = null;
let nfcReplaceCardId = null;

async function openNfcCardModal(cardId, prefillUid) {
    nfcEditingId = cardId || null;
    nfcReplaceCardId = null;
    renderNfcCardModeNote();
    document.getElementById('nfcCardMessage').innerHTML = '';
    document.getElementById('nfcUid').value = prefillUid ? NFCReaderService.normalizeUid(prefillUid) : '';
    document.getElementById('nfcStatus').value = 'unassigned';
    document.getElementById('nfcCardModalTitle').textContent = cardId
        ? '✏️ Modifier / attribuer une carte' : '📇 Nouvelle carte NFC';

    // Charger la liste des adhérents
    const sel = document.getElementById('nfcMemberSelect');
    try {
        const members = await NfcCards.listMembers(v2GetActiveClubId());
        sel.innerHTML = '<option value="">— Carte libre —</option>' +
            members.map(m => `<option value="${m.id}">${escapeHtmlV2(m.last_name)} ${escapeHtmlV2(m.first_name)}</option>`).join('');
    } catch (err) {
        sel.innerHTML = '<option value="">Erreur adhérents</option>';
    }

    // Si édition, pré-remplir
    if (cardId) {
        try {
            const cards = await NfcCards.listCards({ status: 'all', q: '' });
            const card = cards.find(c => c.id === cardId);
            if (card) {
                document.getElementById('nfcUid').value = card.uid;
                document.getElementById('nfcStatus').value = card.status;
                if (card.member_id) sel.value = card.member_id;
            }
        } catch (err) { /* silencieux */ }
    }

    openModal('nfcCardModal');
}

/* Remplacement de carte : désattribue l'ancienne et attribue la nouvelle */
async function replaceNfcCard(cardId) {
    nfcReplaceCardId = cardId;
    nfcEditingId = cardId;
    renderNfcCardModeNote();
    document.getElementById('nfcCardMessage').innerHTML = '';
    const cards = await NfcCards.listCards({ status: 'all', q: '' });
    const card = cards.find(c => c.id === cardId);
    const sel = document.getElementById('nfcMemberSelect');
    const members = await NfcCards.listMembers(v2GetActiveClubId());
    sel.innerHTML = '<option value="">— Carte libre —</option>' +
        members.map(m => `<option value="${m.id}">${escapeHtmlV2(m.last_name)} ${escapeHtmlV2(m.first_name)}</option>`).join('');
    if (card && card.member_id) sel.value = card.member_id;

    document.getElementById('nfcUid').value = card ? card.uid : '';
    document.getElementById('nfcUid').readOnly = false;
    document.getElementById('nfcStatus').value = 'assigned';
    document.getElementById('nfcCardModalTitle').textContent = '🔁 Remplacer la carte NFC';
    document.getElementById('nfcCardMessage').innerHTML =
        `<div class="alert alert-info">Appuyez sur <strong>📡 Lire la carte</strong>, placez la NOUVELLE carte sur le lecteur puis enregistrez. L'ancienne sera désattribuée.</div>`;
    openModal('nfcCardModal');
}

async function saveNfcCard() {
    const uid = NfcCards.buildUidFromText(document.getElementById('nfcUid').value);
    const memberId = document.getElementById('nfcMemberSelect').value || null;
    const status = document.getElementById('nfcStatus').value;
    const msgBox = document.getElementById('nfcCardMessage');

    if (!uid) {
        msgBox.innerHTML = '<div class="alert alert-danger">L\'UID est obligatoire — lisez la carte avec le lecteur.</div>';
        return;
    }

    try {
        // Mode remplacement : désattribuer l'ancien UID puis attribuer le nouveau
        if (nfcReplaceCardId && memberId) {
            const old = (await NfcCards.listCards({ status: 'all', q: '' })).find(c => c.id === nfcReplaceCardId);
            if (old && old.uid !== uid) {
                await NfcCards.unassignCard(nfcReplaceCardId);
            }
            await NfcCards.assignCard(uid, memberId);
        } else if (nfcEditingId) {
            if (memberId && status === 'assigned') {
                await NfcCards.assignCard(uid, memberId);
            } else {
                await NfcCards.setCardStatus(nfcEditingId, status === 'assigned' ? 'unassigned' : status);
            }
        } else {
            if (memberId && status === 'assigned') {
                await NfcCards.assignCard(uid, memberId);
            } else {
                await NfcCards.createCard(uid);
                if (status !== 'unassigned') {
                    const cards = await NfcCards.listCards({ status: 'all', q: '' });
                    const card = cards.find(c => c.uid === uid);
                    if (card) await NfcCards.setCardStatus(card.id, status);
                }
            }
        }

        msgBox.innerHTML = '<div class="alert alert-success">✅ Carte enregistrée.</div>';
        closeModal('nfcCardModal');
        loadNfcCards();
    } catch (err) {
        console.error(err);
        msgBox.innerHTML = `<div class="alert alert-danger">${escapeHtmlV2(err.message)}</div>`;
    }
}

async function unassignNfcCard(cardId, uid) {
    if (!confirm(`Désattribuer la carte ${uid} ?`)) return;
    try {
        await NfcCards.unassignCard(cardId);
        loadNfcCards();
    } catch (err) {
        alert('Erreur : ' + err.message);
    }
}

async function viewNfcHistory(uid) {
    nfcScanViewEpoch++;
    await armNfcScanner();
    const history = await NfcCards.listCardHistory(uid);
    const body = document.getElementById('nfcScanHistory');
    body.innerHTML = history.length
        ? history.map(h => `<div style="padding:6px 0;border-bottom:1px solid var(--border);">
            ${new Date(h.scan_time).toLocaleString('fr-FR')} — ${NFC_RESULT_LABEL[h.scan_result] || h.scan_result}
            <span style="color:var(--text-secondary);font-size:.8rem;">UID <code>${escapeHtmlV2(h.uid)}</code> (${escapeHtmlV2(h.method)})</span></div>`).join('')
        : '<p style="color:var(--text-secondary);">Aucun scan pour cette carte.</p>';
    openModal('nfcScannerModal');
}

/* ---------- Écouteurs ---------- */
document.addEventListener('DOMContentLoaded', () => {
    const search = document.getElementById('nfcSearch');
    const filter = document.getElementById('nfcFilter');
    if (search) search.addEventListener('input', debounceNfc(() => loadNfcCards(), 300));
    if (filter) filter.addEventListener('change', loadNfcCards);

    const scanInput = document.getElementById('nfcScanInput');
    if (scanInput) scanInput.addEventListener('keydown', e => { if (e.key === 'Enter') performNfcScan(); });
});

function debounceNfc(fn, ms) {
    let t;
    return function () { clearTimeout(t); t = setTimeout(fn, ms); };
}
