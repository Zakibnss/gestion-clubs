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
                ${status.message || (c ? 'Prêt à scanner' : 'Branchez le lecteur USB puis cliquez sur Connecter.')}
            </div>
        </div>`;
    document.getElementById('nfcConnectBtn').style.display = c ? 'none' : '';
    document.getElementById('nfcDisconnectBtn').style.display = c ? '' : 'none';
    // Le cœur du scanner n'apparaît que si le lecteur est connecté
    document.getElementById('nfcScannerCore').style.display = c ? '' : 'none';
}

async function connectNfcReader() {
    const btn = document.getElementById('nfcConnectBtn');
    btn.disabled = true;
    try {
        await NFCReaderService.connect();
        nfcReaderUi({ connected: true, message: 'Prêt à scanner' });
        // Démarrer la boucle de lecture continue du lecteur externe
        if (!nfcPollingStarted) {
            NfcCards.startPolling(onScannedUid);
            nfcPollingStarted = true;
        }
        setNfcScannerState('ready');
        loadNfcScannerHistory();
    } catch (err) {
        console.error(err);
        nfcReaderUi({ connected: false, message: err.message });
        setNfcScannerError(err.message);
    } finally {
        btn.disabled = false;
    }
}

async function disconnectNfcReader() {
    NfcCards.stopPolling();
    nfcPollingStarted = false;
    try { await NFCReaderService.disconnect(); } catch (e) { /* ignore */ }
    nfcReaderUi({ connected: false, message: 'Lecteur déconnecté' });
    setNfcScannerCore(false);
}

function closeNfcScanner() {
    NfcCards.stopPolling();
    nfcPollingStarted = false;
    closeModal('nfcScannerModal');
}

/* ---------- États visuels du cœur du scanner ---------- */
function setNfcScannerCore(show) {
    document.getElementById('nfcScannerCore').style.display = show ? '' : 'none';
}

function setNfcScannerState(state) {
    const el = document.getElementById('nfcScannerCore');
    el.style.display = '';
    const title = document.getElementById('nfcScannerTitle');
    const sub = document.getElementById('nfcScannerSub');
    const res = document.getElementById('nfcScanResult');
    if (state === 'ready') {
        title.textContent = '📡 Prêt à scanner';
        sub.textContent = 'Placez la carte NFC sur le lecteur externe.';
        res.innerHTML = '';
    } else if (state === 'reading') {
        title.textContent = '🔄 Lecture en cours…';
        sub.textContent = 'Ne retirez pas la carte.';
        res.innerHTML = '';
    } else {
        el.style.display = 'none';
    }
}

function setNfcScannerError(msg) {
    const res = document.getElementById('nfcScanResult');
    if (res) res.innerHTML = `<div class="alert alert-danger">${escapeHtmlV2(msg)}</div>`;
}

/* ---------- Détection d'une carte (via lecteur externe) ---------- */
let nfcProcessing = false;

async function onScannedUid(rawUid) {
    if (nfcProcessing) return;
    nfcProcessing = true;
    const uid = NFCReaderService.normalizeUid(rawUid);
    if (!uid) { nfcProcessing = false; return; }

    setNfcScannerState('reading');

    try {
        const res = await NfcCards.scanPresence(uid, v2GetActiveClubId(), { method: 'NFC' });
        const autoReset = renderNfcScanResult(res);
        loadNfcScannerHistory();
        // Retour automatique à "Prêt à scanner" pour l'adhérent suivant
        if (autoReset) {
            setTimeout(() => { setNfcScannerState('ready'); nfcProcessing = false; }, 3000);
        } else {
            nfcProcessing = false;
        }
    } catch (err) {
        console.error(err);
        setNfcScannerError(err.message);
        nfcProcessing = false;
    }
}

function renderNfcScanResult(res) {
    const el = document.getElementById('nfcScannerCore');
    el.style.display = '';
    const title = document.getElementById('nfcScannerTitle');
    const sub = document.getElementById('nfcScannerSub');

    if (!res.ok && (res.result === 'unknown' || res.result === 'unassigned')) {
        title.textContent = '⚠ Carte non attribuée';
        sub.textContent = 'UID : ' + escapeHtmlV2(res.uid);
        document.getElementById('nfcScanResult').innerHTML = `
            <div class="alert alert-warning">
                <strong>Cette carte n'est associée à aucun adhérent.</strong><br>
                <div style="margin-top:10px;display:flex;gap:8px;justify-content:center;">
                    <button class="btn btn-primary btn-sm" onclick="assignScannedCard('${escapeAttr(res.uid)}')">Attribuer à un adhérent</button>
                    <button class="btn btn-secondary btn-sm" onclick="setNfcScannerState('ready');">Annuler</button>
                </div>
            </div>`;
        return false;
    }

    if (!res.ok && res.result === 'expired') {
        title.textContent = '⛔ Abonnement expiré';
        sub.textContent = escapeHtmlV2(res.member ? res.member.last_name + ' ' + res.member.first_name : '');
        document.getElementById('nfcScanResult').innerHTML =
            `<div class="alert alert-danger"><strong>Abonnement expiré</strong><br>${escapeHtmlV2(res.detail)}</div>`;
        return false;
    }

    if (res.duplicate) {
        title.textContent = 'ℹ Présence déjà enregistrée';
        sub.textContent = escapeHtmlV2(res.member ? res.member.last_name + ' ' + res.member.first_name : '');
        document.getElementById('nfcScanResult').innerHTML =
            `<div class="alert alert-info"><strong>Présence déjà enregistrée</strong><br>${escapeHtmlV2(res.detail)}</div>`;
        return true;
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
    return true;
}

/* Attribution depuis le scanner (carte non attribuée) */
function assignScannedCard(uid) {
    setNfcScannerState('ready');
    openNfcCardModal(null, uid);
}

/* ---------- Lecture d'un UID dans le modal d'enregistrement ---------- */
async function readUidIntoCardModal() {
    const btn = document.getElementById('nfcReadBtn');
    const msg = document.getElementById('nfcCardMessage');
    btn.disabled = true;
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
async function loadNfcScannerHistory() {
    try {
        const h = await NfcCards.listAllHistory(30);
        renderNfcScanHistory(h);
    } catch (e) { /* silencieux */ }
}
function renderNfcScanHistory(h) {
    const el = document.getElementById('nfcScanHistory');
    el.innerHTML = h.length
        ? h.slice(0, 30).map(x => `<div style="padding:4px 0;border-bottom:1px solid var(--border);font-size:.85rem;">
            ${new Date(x.scan_time).toLocaleString('fr-FR')} — ${NFC_RESULT_LABEL[x.scan_result] || x.scan_result}</div>`).join('')
        : '<p style="color:var(--text-secondary);">Aucun scan.</p>';
}

/* ---------- Ouverture du scanner ---------- */
async function openNfcScanner() {
    document.getElementById('nfcScanResult').innerHTML = '';
    setNfcScannerCore(false);
    const connected = NFCReaderService.isConnected();
    nfcReaderUi({ connected, message: connected ? 'Prêt à scanner' : 'Branchez le lecteur USB puis cliquez sur Connecter.' });
    if (connected) {
        if (!nfcPollingStarted) { NfcCards.startPolling(onScannedUid); nfcPollingStarted = true; }
        setNfcScannerState('ready');
    }
    loadNfcScannerHistory();
    openModal('nfcScannerModal');
}

/* Subscription permanente à l'état du lecteur (déconnexion USB) */
NFCReaderService.onStatus(s => {
    const opened = document.getElementById('nfcScannerModal')?.classList.contains('active');
    if (opened) nfcReaderUi(s);
    if (!s.connected && opened) setNfcScannerCore(false);
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
    const history = await NfcCards.listCardHistory(uid);
    const body = document.getElementById('nfcScanHistory');
    body.innerHTML = history.length
        ? history.map(h => `<div style="padding:6px 0;border-bottom:1px solid var(--border);">
            ${new Date(h.scan_time).toLocaleString('fr-FR')} — ${NFC_RESULT_LABEL[h.scan_result] || h.scan_result}
            <span style="color:var(--text-secondary);font-size:.8rem;">(${escapeHtmlV2(h.method)})</span></div>`).join('')
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
