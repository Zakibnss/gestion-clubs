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
        el.innerHTML = `<div>📱 NFC المدمج (أندرويد) — <span style="color:#dc3545;">🔴 غير متاح على هذا الجهاز</span></div>
            <div style="font-size:.78rem;margin-top:2px;">استخدم قارئ NFC الخارجي USB / USB OTG.</div>`;
        return;
    }
    el.innerHTML = `<div>📱 NFC المدمج (أندرويد) — <span style="color:#28a745;">🟢 متاح</span></div>
        <div style="font-size:.78rem;margin-top:2px;">⚠️ NFC المدمج لا يوفر UID الخام لبطاقة MIFARE Classic 1K. يبقى قارئ NFC الخارجي هو الوضع الموثوق.</div>`;
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
                ? 'وضع NFC المدمج (أندرويد) — اضغط على « اتصال »، ثم قرّب بطاقة من الهاتف.'
                : 'NFC المدمج (أندرويد) غير متاح في هذا السياق'
        });
    } else {
        // external
        NFCReaderService.setMode('external');
        nfcReaderUi({ connected: false, message: 'وصّل قارئ USB (HID Keyboard). الاستماع التلقائي عند الفتح التالي.' });
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
            <div style="font-weight:700;" id="nfcReaderStatusTitle">${c ? 'القارئ متصل' : 'القارئ غير متصل'}</div>
            <div style="font-size:.8rem;color:var(--text-secondary);" id="nfcReaderStatusSub">
                ${status.message || (c ? 'جاهز للمسح — قدّم البطاقة.' : 'وصّل قارئ USB ثم اضغط على « اتصال ».')}
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
        nfcReaderUi({ connected: true, message: 'جاهز للمسح' });

        // NFC intégré (Web NFC / PC) sans UID brut : on n'utilise pas la
        // boucle de présence par UID et on affiche l'avertissement.
        if (!NFCReaderService.supportsRawUid()) {
            const res = document.getElementById('nfcScanResult');
            res.innerHTML = `<div class="alert alert-warning">
                ⚠ <strong>قراءة UID غير متاحة مع NFC المدمج.</strong><br>
                هذا الوضع لا يوفر UID الخام لبطاقة MIFARE Classic 1K.<br>
                استخدم قارئ NFC الخارجي USB/OTG.
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
            📡 <strong>قارئ NFC الخارجي</strong><br><br>
            🟡 <strong>جاهز للمسح</strong><br>
            قدّم بطاقة على القارئ.
        </div>`;
        const res = await NFCReaderService.testScan(10000);
        if (res.ok && res.value) {
            msg.innerHTML = `<div class="alert alert-success">✓ <strong>تمت القراءة بنجاح</strong><br>
                📡 <strong>القارئ يعمل</strong><br>
                النوع&nbsp;: <strong>HID Keyboard</strong><br><br>
                القيمة المكتشفة&nbsp;:<br>
                <code style="font-size:1.1rem;font-weight:700;">${escapeHtmlV2(NFCReaderService.normalizeUid(res.value))}</code><br><br>
                <button class="btn btn-secondary btn-sm" onclick="testNfcReader()">🧪 اختبار مرة أخرى</button></div>`;
        } else {
            msg.innerHTML = `<div class="alert alert-danger">🔴 <strong>لم يتم رصد أي قراءة.</strong><br>
                قدّم بطاقة وتأكد من توصيل قارئ USB بشكل صحيح (HID Keyboard).</div>`;
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
            msg.innerHTML = `<div class="alert alert-warning">تعذّر تفعيل NFC المدمج.</div>`;
            return;
        }
        msg.innerHTML = `<div class="alert alert-info">📱 NFC المدمج (أندرويد)<br>قرّب بطاقة NFC من الهاتف...</div>`;
        const r = await NFCReaderService.testIntegratedCard(8000);
        if (r.timedOut) {
            msg.innerHTML = `<div class="alert alert-warning">لم يتم رصد أي بطاقة. قرّب بطاقة من الهاتف.</div>`;
        } else if (r.detected) {
            if (r.uid) {
                msg.innerHTML = `<div class="alert alert-success">✓ تم التعرف على البطاقة<br><strong>UID&nbsp;:</strong> <code>${escapeHtmlV2(NFCReaderService.normalizeUid(r.uid))}</code></div>`;
            } else {
                msg.innerHTML = `<div class="alert alert-warning">⚠ تم التعرف على البطاقة<br>رصد NFC المدمج البطاقة، لكن المتصفح لا يوفر UID المطلوب. استخدم قارئ NFC الخارجي.</div>`;
            }
        }
    } catch (err) {
        const code = err && err.code;
        let text = escapeHtmlV2(err && err.message || 'خطأ');
        if (code === 'WEB_NFC_PERMISSION_DENIED') {
            text = 'تم رفض إذن NFC. فعّل NFC واسمح به في المتصفح.';
        } else if (code === 'WEB_NFC_UNAVAILABLE') {
            text = 'NFC المدمج غير متاح. استخدم قارئ NFC الخارجي USB/OTG.';
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
    nfcReaderUi({ connected: false, message: 'تم فصل القارئ' });
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
        title.textContent = '📡 جاهز للمسح';
        sub.textContent = 'قدّم البطاقة';
        res.innerHTML = '';
    } else if (state === 'reading') {
        title.textContent = '🔄 جاري القراءة…';
        sub.textContent = 'لا تبعد البطاقة.';
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
        ⚠ <strong>قراءة UID غير متاحة مع NFC المدمج.</strong><br>
        استخدم قارئ NFC الخارجي USB/OTG لقراءة UID لبطاقات MIFARE Classic.
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
        const eventId = document.getElementById('nfcScanEvent')?.value || null;
        const res = await NfcCards.scanPresence(uid, v2GetActiveClubId(), { method: 'NFC', eventId });
        renderNfcScanResult(res);
        loadNfcScannerHistory();
        // Retour automatique court pour l'adhérent suivant : la lecture
        // reste armée en permanence, on réaffiche « Prêt à scanner »
        // rapidement (1,5 s) pour absorber un défilement rapide de cartes.
        scheduleNfcAutoReset(1500);
    } catch (err) {
        console.error(err);
        setNfcScannerErrorV2(err.message);
        scheduleNfcAutoReset(1500);
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

/* Bloc HTML affichant le résultat du paiement d'événement (si demandé). */
function eventPaymentHtml(payment) {
    if (!payment) return '';
    if (payment.reason === 'not_participant') {
        const title = payment.event?.title || 'Événement';
        return `<div class="alert alert-warning" style="margin-top:8px;">
            ⚠ <strong>${escapeHtmlV2(title)}</strong><br>
            Cet adhérent n'est pas inscrit à cet événement — aucun paiement enregistré.
        </div>`;
    }
    if (payment.reason === 'event_not_found') {
        return `<div class="alert alert-danger" style="margin-top:8px;">Événement introuvable.</div>`;
    }
    if (payment.reason === 'error') {
        return `<div class="alert alert-danger" style="margin-top:8px;">Erreur paiement : ${escapeHtmlV2(payment.message || 'inconnue')}</div>`;
    }
    const title = payment.event?.title || 'Événement';
    if (payment.alreadyPaid) {
        return `<div class="alert alert-info" style="margin-top:8px;">
            ℹ️ Paiement déjà enregistré — <strong>${escapeHtmlV2(title)}</strong> (${payment.amount} DA).
        </div>`;
    }
    if (payment.paid) {
        return `<div class="alert alert-success" style="margin-top:8px;">
            💰 Paiement encaissé : <strong>${payment.amount} DA</strong><br>
            <span style="font-size:.9rem;">${escapeHtmlV2(title)}</span>
        </div>`;
    }
    return '';
}

function renderNfcScanResult(res) {
    const el = document.getElementById('nfcScannerCore');
    el.style.display = '';
    const title = document.getElementById('nfcScannerTitle');
    const sub = document.getElementById('nfcScannerSub');

    if (!res.ok && (res.result === 'unknown' || res.result === 'unassigned')) {
        title.textContent = '⚠ بطاقة غير معروفة';
        sub.textContent = 'UID : ' + escapeHtmlV2(res.uid);
        document.getElementById('nfcScanResult').innerHTML = `
            <div class="alert alert-warning">
                <strong>هذه البطاقة غير مرتبطة بأي عضو.</strong><br>
                <div style="font-size:.9rem;margin-top:6px;">UID المكتشف : <code>${escapeHtmlV2(res.uid)}</code></div>
                <div style="margin-top:10px;display:flex;gap:8px;justify-content:center;">
                    <button class="btn btn-primary btn-sm" onclick="assignScannedCard('${escapeAttr(res.uid)}')">إسناد إلى عضو</button>
                    <button class="btn btn-secondary btn-sm" onclick="setNfcScannerState('ready');">إلغاء</button>
                </div>
            </div>`;
        return;
    }

    if (res.expired) {
        // Carte lue + adhérent identifié + présence ENREGISTRÉE malgré
        // l'abonnement expiré (couleur avertissement, pas succès).
        const m = res.member || {};
        title.textContent = '⚠ تم تسجيل الحضور — الاشتراك منتهي';
        sub.textContent = escapeHtmlV2(m.last_name ? m.last_name + ' ' + m.first_name : '');
        const dateFmt = res.date ? new Date(res.date + 'T00:00:00').toLocaleDateString('fr-FR') : '';
        document.getElementById('nfcScanResult').innerHTML = `
            <div class="alert alert-warning">
                <div style="font-size:1.15rem;font-weight:700;margin-bottom:4px;">${escapeHtmlV2(m.last_name || '')} ${escapeHtmlV2(m.first_name || '')}</div>
                <div style="font-size:.9rem;color:var(--text-secondary);">
                    ID : #${escapeHtmlV2(m.id || '')}${res.groupName ? ' — المجموعة : ' + escapeHtmlV2(res.groupName) : ''}
                </div>
                <hr style="margin:8px 0;border:none;border-top:1px solid rgba(255,255,255,.2);">
                <div style="font-size:.9rem;">
                    الحضور :<br><strong>${dateFmt} — ${escapeHtmlV2(res.time)}</strong><br>
                    <span style="color:var(--warn);">الاشتراك منتهي — تم التحقق من الحضور مع ذلك.</span>
                </div>
            </div>${eventPaymentHtml(res.payment)}`;
        return;
    }

    if (!res.ok && res.result === 'expired') {
        title.textContent = '⛔ الاشتراك منتهي';
        sub.textContent = escapeHtmlV2(res.member ? res.member.last_name + ' ' + res.member.first_name : '');
        document.getElementById('nfcScanResult').innerHTML =
            `<div class="alert alert-danger"><strong>الاشتراك منتهي</strong><br>${escapeHtmlV2(res.detail)}</div>${eventPaymentHtml(res.payment)}`;
        return;
    }

    if (res.duplicate) {
        title.textContent = 'ℹ تم تسجيل الحضور مسبقًا';
        sub.textContent = escapeHtmlV2(res.member ? res.member.last_name + ' ' + res.member.first_name : '');
        document.getElementById('nfcScanResult').innerHTML =
            `<div class="alert alert-info"><strong>تم تسجيل الحضور مسبقًا</strong><br>${escapeHtmlV2(res.detail)}</div>${eventPaymentHtml(res.payment)}`;
        return;
    }

    // Succès
    const m = res.member || {};
    title.textContent = '✓ تم تسجيل الحضور';
    sub.textContent = '';
    const dateFmt = res.date ? new Date(res.date + 'T00:00:00').toLocaleDateString('fr-FR') : '';
    document.getElementById('nfcScanResult').innerHTML = `
        <div class="alert alert-success">
            <div style="font-size:1.15rem;font-weight:700;margin-bottom:4px;">${escapeHtmlV2(m.last_name || '')} ${escapeHtmlV2(m.first_name || '')}</div>
            <div style="font-size:.9rem;color:var(--text-secondary);">
                ID : #${escapeHtmlV2(m.id || '')}${res.groupName ? ' — المجموعة : ' + escapeHtmlV2(res.groupName) : ''}
            </div>
            <hr style="margin:8px 0;border:none;border-top:1px solid rgba(255,255,255,.2);">
            <div style="font-size:.9rem;">
                الحضور :<br><strong>${dateFmt} — ${escapeHtmlV2(res.time)}</strong>
            </div>
        </div>${eventPaymentHtml(res.payment)}`;
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
        ? `<span style="color:#e0a800;">📱 الطريقة النشطة : NFC المدمج للهاتف (لا يمكن قراءة UID هنا — استخدم القارئ الخارجي لقراءة UID).</span>`
        : `🔌 الطريقة النشطة : قارئ NFC الخارجي — اضغط على « 📡 قراءة البطاقة » ثم ضع البطاقة على القارئ.`;
}

/* ---------- Lecture d'un UID dans le modal d'enregistrement ---------- */
async function readUidIntoCardModal() {
    const btn = document.getElementById('nfcReadBtn');
    const msg = document.getElementById('nfcCardMessage');
    btn.disabled = true;

    // Mode NFC intégré : ne fournit pas l'UID ; on prévient clairement.
    if (nfcSelectedMode === 'android-integrated') {
        msg.innerHTML = `<div class="alert alert-warning">⚠ <strong>قراءة UID غير متاحة مع NFC المدمج.</strong><br>
            Web NFC لا يوفر UID الخام لبطاقة MIFARE Classic 1K.<br>
            بدّل إلى طريقة <strong>قارئ NFC الخارجي</strong> لقراءة UID لبطاقة.</div>`;
        btn.disabled = false;
        return;
    }

    msg.innerHTML = '<div class="alert alert-info">📡 ضع البطاقة على القارئ…</div>';
    try {
        if (!NFCReaderService.isConnected()) {
            await NFCReaderService.connect();
        }
        const uid = await NFCReaderService.readUID();
        if (!uid) throw new Error('لم يتم رصد أي بطاقة.');
        document.getElementById('nfcUid').value = NFCReaderService.normalizeUid(uid);
        msg.innerHTML = `<div class="alert alert-success">✓ تم التعرف على البطاقة — UID : <code>${escapeHtmlV2(NFCReaderService.normalizeUid(uid))}</code></div>`;
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
        : '<p style="color:var(--text-secondary);">لا يوجد أي مسح حتى الآن.</p>';
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
        nfcReaderUi({ connected: false, message: 'وضع NFC المدمج — اضغط على « اتصال » ثم قرّب البطاقة من الهاتف.' });
        return;
    }
    setNfcScannerCoreV2(true);
    nfcReaderUi({ connected: true, message: 'جاهز للمسح — قدّم البطاقة.' });
    try {
        await NFCReaderService.connect();
        if (!nfcPollingStarted) {
            NfcCards.startPolling(onScannedUid);
            nfcPollingStarted = true;
        }
        setNfcScannerState('ready');
    } catch (err) {
        console.error(err);
        nfcReaderUi({ connected: false, message: err.message || 'تعذّر الاتصال بالقارئ.' });
        setNfcScannerErrorV2(err.message || 'تعذّر الاتصال بالقارئ.');
    }
}

/* ---------- Ouverture du scanner ---------- */
/* ---------- Événements proposés pour le paiement par carte ---------- */
async function loadNfcScanEvents() {
    const sel = document.getElementById('nfcScanEvent');
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = '<option value="">— Présence seulement —</option>';
    try {
        // Événements du club actif + tous les événements généraux.
        const events = await NfcCards.listEventsForScanner(v2GetActiveClubId());
        sel.innerHTML += events.map(ev => {
            const d = ev.event_date
                ? new Date(ev.event_date + 'T00:00:00').toLocaleDateString('fr-FR') : '';
            const scope = ev.scope === 'general' ? ' 🌍' : '';
            const price = Number(ev.price || 0);
            return `<option value="${ev.id}">${escapeHtmlV2(ev.title || '')} — ${d}${scope} (${price} DA)</option>`;
        }).join('');
    } catch (e) {
        console.warn('loadNfcScanEvents', e);
    }
    if (prev) sel.value = prev;
}

/* ---------- Ouverture du scanner ---------- */
async function openNfcScanner() {
    renderWebNfcStatus();
    updateNfcModeSelector();
    document.getElementById('nfcScanResult').innerHTML = '';
    await loadNfcScanEvents();
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
const NFC_RESULT_LABEL = { present: '✅ حاضر', unassigned: '⬜ بطاقة حرة', expired: '⛔ منتهي', unknown: '❓ غير معروفة' };

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
        : '<p style="color:var(--text-secondary);">لا توجد عمليات مسح لهذه البطاقة.</p>';
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
