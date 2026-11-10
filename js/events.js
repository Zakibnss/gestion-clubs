// ============================================
// MODULE ÉVÉNEMENTS & PAIEMENTS DE PARTICIPATION — V2
// ============================================

let v2EventsCache = [];
let currentEventId = null;

/* La table `events` possède-t-elle déjà `lieu` / `price` (migration 017) ?
   Probe unique puis mise en cache : évite d'envoyer des colonnes inconnues
   (400 PGRST204) tant que la migration n'est pas exécutée. */
let v2EventsHasColumns = null;
async function v2DetectEventColumns() {
    if (v2EventsHasColumns !== null) return v2EventsHasColumns;
    const { error } = await supabase.from('events').select('lieu,price').limit(1);
    v2EventsHasColumns = !error;
    return v2EventsHasColumns;
}

async function loadEvents() {
    if (currentClub === 'admin') await v2PopulateAdminClubSelect('eventsToolbar');
    const clubId = v2GetActiveClubId();

    try {
        // Événements du club actif + TOUS les événements généraux (inter-clubs).
        // Si l'admin n'a sélectionné aucun club : on affiche tout.
        let q = supabase.from('events').select('*').order('event_date', { ascending: false });
        if (clubId) q = q.or(`club_id.eq.${clubId},scope.eq.general`);

        let { data: events, error } = await q;
        if (error) {
            if (!clubId) throw error;
            // Repli si la colonne `scope` n'est pas encore migrée (017).
            const fb = await supabase.from('events').select('*')
                .eq('club_id', clubId).order('event_date', { ascending: false });
            if (fb.error) throw fb.error;
            events = fb.data;
        }
        v2EventsCache = events || [];
        await v2DetectEventColumns();
        const { data: events, error } = await supabase
            .from('events')
            .select('*')
            .eq('club_id', clubId)
            .order('event_date', { ascending: false });
        if (error) throw error;
        v2EventsCache = (events || []).map(v2NormalizeEvent);

        document.getElementById('eventsGrid').innerHTML = v2EventsCache.map(ev => {
            const isGeneral = ev.scope === 'general';
            const scopeBadge = isGeneral
                ? '<span class="badge badge-info">🌍 Général — tous les clubs</span>'
                : '<span class="badge" style="background:rgba(255,255,255,.12)">🏠 Local</span>';
            // Un club ne modifie/supprime que SES événements (l'admin peut tout).
            const canManage = v2IsAdmin() || !clubId || ev.club_id === clubId;
            return `
            <div class="event-card">
                <h3 style="color:var(--primary-color)">${escapeHtmlV2(ev.title)} ${scopeBadge}</h3>
                <div class="group-meta">
                    <span>📅 ${fmtDateV2(ev.event_date)}${ev.event_time ? ' ' + ev.event_time.slice(0, 5) : ''}</span>
                    ${ev.lieu ? `<span>📍 ${escapeHtmlV2(ev.lieu)}</span>` : ''}
                    <span>💰 ${Number(ev.price || 0).toLocaleString('fr-FR')} DA</span>
                    <span>🏷️ ${escapeHtmlV2(ev.type || 'stage')}</span>
                </div>
                ${ev.description ? `<p style="font-size:.85rem;color:var(--text-secondary);margin-bottom:12px">${escapeHtmlV2(ev.description)}</p>` : ''}
                <div class="group-actions">
                    <button class="btn btn-primary btn-sm" onclick="openParticipantsModal('${ev.id}')">👥 Participations</button>
                    ${canManage ? `<button class="btn btn-secondary btn-sm" onclick="openEventModal('${ev.id}')">✏️ Modifier</button>
                    <button class="btn btn-danger btn-sm" onclick="deleteEvent('${ev.id}')">🗑️</button>` : ''}
                </div>
            </div>`;
        }).join('') || '<p>Aucun événement. Créez-en un.</p>';
    } catch (err) {
        showMessage('eventsMessage', 'Erreur: ' + err.message, 'danger');
    }
}

function openEventModal(eventId) {
    const form = document.getElementById('eventForm');
    form.reset();
    document.getElementById('eventId').value = eventId || '';
    document.getElementById('eventModalTitle').textContent =
        eventId ? '✏️ Modifier l\'événement' : '➕ Nouvel événement';

    const scopeEl = document.getElementById('eventScope');
    if (scopeEl) scopeEl.value = 'local';

    if (eventId) {
        const ev = v2EventsCache.find(e => e.id === eventId);
        if (ev) {
            document.getElementById('eventTitle').value = ev.title || '';
            document.getElementById('eventDate').value = ev.event_date || '';
            document.getElementById('eventTime').value = ev.event_time || '';
            document.getElementById('eventLieu').value = ev.lieu || '';
            document.getElementById('eventPrice').value = ev.price ?? 0;
            document.getElementById('eventDescription').value = ev.description || '';
            document.getElementById('eventType').value = ev.type || 'stage';
            if (scopeEl) scopeEl.value = ev.scope || 'local';
        }
    }
    openModal('eventModal');
}

async function handleEventSubmit(e) {
    e.preventDefault();
    const clubId = v2GetActiveClubId();
    if (!clubId) {
        showMessage('eventMessage', 'Sélectionnez un club avant de créer un événement.', 'warning');
        return;
    }

    const lieu = document.getElementById('eventLieu').value.trim() || null;
    const price = parseFloat(document.getElementById('eventPrice').value) || 0;
    const description = document.getElementById('eventDescription').value.trim() || '';

    const payload = {
        club_id: clubId,
        title: document.getElementById('eventTitle').value.trim(),
        event_date: document.getElementById('eventDate').value,
        event_time: document.getElementById('eventTime').value || null,
        lieu: document.getElementById('eventLieu').value.trim() || null,
        price: parseFloat(document.getElementById('eventPrice').value) || 0,
        description: document.getElementById('eventDescription').value.trim() || null,
        type: document.getElementById('eventType').value || 'stage',
        scope: document.getElementById('eventScope')?.value || 'local'
        description: description || null,
        type: document.getElementById('eventType').value || 'stage'
    };

    const id = document.getElementById('eventId').value;

    // Tant que la migration sql/017 n'est pas exécutée, les colonnes `lieu`
    // et `price` n'existent pas : on les encode alors dans la description.
    // Dès qu'elles existent, elles sont écrites en clair (prioritaires).
    const hasColumns = await v2DetectEventColumns();
    const withMeta = (fields) => ({ ...fields, description: v2EncodeEventMeta(description, lieu, price) });

    if (hasColumns) {
        payload.lieu = lieu;
        payload.price = price;
    } else {
        payload.description = v2EncodeEventMeta(description, lieu, price);
    }

    const write = async (fields) => {
        const q = supabase.from('events');
        return id ? q.update(fields).eq('id', id) : q.insert(fields);
    };

    try {
        let { error } = await write(payload);

        // Filet de sécurité : si la base ne connaît pas encore les colonnes
        // malgré la détection, on réessaie en mode métadonnées.
        if (error && (error.code === 'PGRST204' || error.code === '42703') &&
            /lieu|price/i.test(error.message || '')) {
            v2EventsHasColumns = false;
            const fallback = withMeta(payload);
            delete fallback.lieu;
            delete fallback.price;
            const retry = await write(fallback);
            error = retry.error;
        }

        if (error) throw error;

        closeModal('eventModal');
        await loadEvents();
    } catch (err) {
        let msg = err.message || String(err);
        if (err.code === '42703' && /updated_at/i.test(msg)) {
            msg = 'La modification d\'événement est bloquée par un trigger de la base : ' +
                'la colonne <b>events.updated_at</b> est absente. ' +
                'Exécutez la migration <b>sql/017_event_payments.sql</b> dans Supabase.';
            showMessage('eventMessage', 'Erreur: ' + msg, 'danger');
            return;
        }
        if (err.code === 'PGRST204' || /lieu|price/i.test(msg)) {
            msg += ' — exécutez la migration sql/017_event_payments.sql dans Supabase.';
        }
        showMessage('eventMessage', 'Erreur: ' + escapeHtmlV2(msg), 'danger');
    }
}

async function deleteEvent(eventId) {
    if (!confirm('Supprimer cet événement et ses participations ?')) return;
    const { error } = await supabase.from('events').delete().eq('id', eventId);
    if (error) { alert(error.message); return; }
    loadEvents();
}

/* ---------- Participations ---------- */

let v2EpCache = [];
let v2SavingParticipants = false;
let v2EpNfcPolling = false;
let v2EpNfcBusy = false;
let v2EpLastNfcUid = '';
let v2EpLastNfcAt = 0;

function epModalActive() {
    return !!document.getElementById('eventParticipantsModal')?.classList.contains('active');
}

function epNfcStatus(message, type) {
    const box = document.getElementById('epNfcStatus');
    if (!box) return;
    box.className = 'alert alert-' + (type || 'info');
    box.innerHTML = message;
}

async function openParticipantsModal(eventId) {
    currentEventId = eventId;
    const ev = v2EventsCache.find(e => e.id === eventId);
    const clubId = v2GetActiveClubId();
    // Événement local : le club de référence est celui qui l'a créé (utile
    // quand l'admin consulte sans club sélectionné).
    const localClubId = ev?.club_id || clubId;

    const isGeneral = ev?.scope === 'general';
    document.getElementById('epTitle').textContent =
        `👥 Participations — ${ev?.title || ''}${isGeneral ? ' 🌍 (tous les clubs)' : ''}`;
    document.getElementById('epTitle').textContent = `👥 Participations — ${ev?.title || ''}`;
    document.getElementById('epMessage').innerHTML = '';
    document.getElementById('epMembersList').innerHTML = '<div class="spinner"></div>';
    document.getElementById('epParticipantsTable').innerHTML = '';
    document.getElementById('epPaySummary').innerHTML = '';
    openModal('eventParticipantsModal');

    try {
        // Événement général : adhérents de TOUS les clubs/groupes.
        // Événement local : adhérents du club actif uniquement.
        let membersQ = supabase.from('members')
            .select('id, first_name, last_name, current_group_id, club_id')
            .order('last_name');
        if (!isGeneral) membersQ = membersQ.eq('club_id', localClubId);

        let groupsQ = supabase.from('groups').select('id, name');
        if (!isGeneral) groupsQ = groupsQ.eq('club_id', localClubId);

        const [membersRes, partsRes, groupsRes, clubsRes] = await Promise.all([
            membersQ,
            supabase.from('event_participants')
                .select('id, member_id')
                .eq('event_id', eventId),
            groupsQ,
            supabase.from('clubs').select('id, name')
        ]);
        if (membersRes.error) throw membersRes.error;
        if (partsRes.error) throw partsRes.error;

        const partSet = new Set((partsRes.data || []).map(p => p.member_id));
        const groupNameOf = {};
        (groupsRes.data || []).forEach(g => groupNameOf[g.id] = g.name);
        const clubNameOf = {};
        (clubsRes.data || []).forEach(c => clubNameOf[c.id] = c.name);

        document.getElementById('epMembersList').innerHTML =
            (membersRes.data || []).map(m => `
            <label class="assign-item ${partSet.has(m.id) ? 'selected' : ''}">
                <input type="checkbox" data-mid="${m.id}" ${partSet.has(m.id) ? 'checked' : ''}
                       onchange="this.closest('.assign-item').classList.toggle('selected', this.checked)">
                <span><b>${escapeHtmlV2(m.last_name)}</b> ${escapeHtmlV2(m.first_name)}</span>
                ${isGeneral ? `<span class="badge badge-secondary">${escapeHtmlV2(clubNameOf[m.club_id] || '—')}</span>` : ''}
                <span class="badge badge-info" style="margin-left:auto">
                    ${groupNameOf[m.current_group_id] || 'Sans groupe'}
                </span>
            </label>`).join('');

        await renderParticipantsTable();
        epNfcStatus('Scanner en attente — présentez une carte.', 'info');
        await armEventNfcScanner(false);
    } catch (err) {
        document.getElementById('epMembersList').innerHTML = '';
        showMessage('epMessage', 'Erreur: ' + escapeHtmlV2(err.message), 'danger');
    }
}

async function renderParticipantsTable() {
    const ev = v2EventsCache.find(e => e.id === currentEventId);
    const tbody = document.getElementById('epParticipantsTable');
    const summary = document.getElementById('epPaySummary');

    try {
        const { data: parts, error: partsErr } = await supabase
            .from('event_participants')
            .select('id, member_id')
            .eq('event_id', currentEventId);
        if (partsErr) throw partsErr;

        const participantIds = (parts || []).map(p => p.id);
        const memberIds = (parts || []).map(p => p.member_id);

        const [paysRes, gmRes, membersRes] = await Promise.all([
            participantIds.length
                ? supabase.from('event_payments')
                    .select('participant_id, status, paid_on, amount, created_at')
                    .in('participant_id', participantIds)
                    .order('created_at')
                : Promise.resolve({ data: [], error: null }),
            supabase.from('group_members')
                .select('member_id, group_id').is('end_date', null),
            memberIds.length
                ? supabase.from('members')
                    .select('id, first_name, last_name').in('id', memberIds)
                : Promise.resolve({ data: [], error: null })
        ]);

        // Un problème d'accès aux paiements ne doit pas masquer les participants.
        if (paysRes.error) {
            showMessage('epMessage',
                'Paiements indisponibles : ' + escapeHtmlV2(paysRes.error.message), 'danger');
        }

        const nameOf = {};
        (membersRes.data || []).forEach(m =>
            nameOf[m.id] = `${m.last_name} ${m.first_name}`);
        const groupOf = {};
        (gmRes.data || []).forEach(r => groupOf[r.member_id] = r.group_id);
        const groupsRes = Object.keys(groupOf).length
            ? await supabase.from('groups').select('id, name').in('id', [...new Set(Object.values(groupOf))])
            : { data: [] };
        const groupNameOf = {};
        (groupsRes.data || []).forEach(g => groupNameOf[g.id] = g.name);

        // Dernier paiement = statut courant ; les lignes précédentes = historique
        const lastPay = {};
        (paysRes.data || []).forEach(p => {
            lastPay[p.participant_id] = p;
        });

        v2EpCache = parts || [];

        let paidCount = 0;
        let unpaidCount = 0;
        let revenue = 0;

        tbody.innerHTML = (parts || []).map(p => {
            const pay = lastPay[p.id];
            const paid = pay?.status === 'PAYE';
            const amount = Number(pay?.amount ?? ev?.price ?? 0);
            if (paid) {
                paidCount++;
                revenue += amount;
            } else {
                unpaidCount++;
            }
            return `<tr>
                <td class="row-label">${escapeHtmlV2(nameOf[p.member_id] || p.member_id)}</td>
                <td>${escapeHtmlV2(groupNameOf[groupOf[p.member_id]] || '—')}</td>
                <td>${amount.toLocaleString('fr-FR')} DA</td>
                <td><span class="pay-toggle ${paid ? 'paid' : 'unpaid'}">${paid ? '✅ PAYÉ' : '❌ NON PAYÉ'}</span></td>
                <td>${pay?.paid_on ? fmtDateV2(pay.paid_on) : '—'}</td>
                <td>
                    <button class="btn btn-sm ${paid ? 'btn-danger' : 'btn-success'}"
                            onclick="toggleEventPayment(this, '${p.id}', '${paid ? 'PAYE' : 'NON PAYE'}')">
                        ${paid ? 'Annuler' : 'Encaisser'}
                    </button>
                </td>
            </tr>`;
        }).join('') || '<tr><td colspan="6">Aucun participant sélectionné.</td></tr>';

        summary.innerHTML = `
            <span class="stat-pill">Participants : <b>${(parts || []).length}</b></span>
            <span class="stat-pill">Payés : <b>${paidCount}</b></span>
            <span class="stat-pill">Non payés : <b>${unpaidCount}</b></span>
            <span class="stat-pill">Recette : <b>${revenue.toLocaleString('fr-FR')} DA</b></span>`;
    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="6">Erreur de chargement des participations.</td></tr>';
        showMessage('epMessage', 'Erreur: ' + escapeHtmlV2(err.message), 'danger');
    }
}

async function saveParticipants() {
    if (!currentEventId || v2SavingParticipants) return;

    const clubId = v2GetActiveClubId();
    const btn = document.getElementById('epSaveParticipantsBtn');
    if (!clubId) {
        showMessage('epMessage', 'Aucun club sélectionné.', 'danger');
        return;
    }

    const checked = [...document.querySelectorAll('#epMembersList input[type=checkbox]:checked')]
        .map(cb => cb.dataset.mid);

    v2SavingParticipants = true;
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Enregistrement...'; }

    try {
        const { data: current, error: curErr } = await supabase
            .from('event_participants')
            .select('id, member_id')
            .eq('event_id', currentEventId);
        if (curErr) throw curErr;
        const currentIds = new Set((current || []).map(c => c.member_id));

        // Ajouts
        const toAdd = checked.filter(id => !currentIds.has(id));
        if (toAdd.length) {
            // Rattacher chaque participant à SON club (événement général :
            // adhérents issus de clubs différents).
            const { data: mems } = await supabase.from('members')
                .select('id, club_id').in('id', toAdd);
            const clubOf = {};
            (mems || []).forEach(m => clubOf[m.id] = m.club_id);

            const { error } = await supabase.from('event_participants')
                .insert(toAdd.map(mid => ({
                    club_id: clubOf[mid] || clubId, event_id: currentEventId,
                    member_id: mid, group_id: null
                })));
            if (error) throw error;
        }

        // Retraits (les paiements sont supprimés en cascade)
        const removed = (current || []).filter(c => !checked.includes(c.member_id));
        if (removed.length) {
            const { error } = await supabase.from('event_participants')
                .delete().in('id', removed.map(r => r.id));
            if (error) throw error;
        }

        await renderParticipantsTable();
        showMessage('epMessage',
            `${toAdd.length} ajout(s), ${removed.length} retrait(s).`, 'success');
    } catch (err) {
        showMessage('epMessage', 'Erreur: ' + escapeHtmlV2(err.message), 'danger');
    } finally {
        v2SavingParticipants = false;
        if (btn) {
            btn.disabled = false;
            btn.textContent = '💾 Enregistrer les participations';
        }
    }
}

async function toggleEventPayment(btn, participantId, currentState) {
    if (!participantId || (btn && btn.disabled)) return;

    const ev = v2EventsCache.find(e => e.id === currentEventId);
    const nowPaid = currentState === 'PAYE';

    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }

    const payload = {
        participant_id: participantId,
        amount: Number(ev?.price || 0),
        status: nowPaid ? 'NON PAYE' : 'PAYE',
        previous_status: currentState,
        paid_on: nowPaid ? null : new Date().toISOString().slice(0, 10),
        changed_by: currentUser || 'system'
    };

    try {
        const { error } = await supabase.from('event_payments').insert(payload);
        if (error) throw error;
        await renderParticipantsTable();
        showMessage('epMessage', nowPaid ? 'Paiement annulé.' : 'Paiement encaissé.', 'success');
    } catch (err) {
        showMessage('epMessage', 'Erreur paiement: ' + escapeHtmlV2(err.message), 'danger');
        if (btn && btn.isConnected) btn.disabled = false;
    }
}

/* ---------- Paiement / inscription par lecture de carte NFC ---------- */

async function armEventNfcScanner(userAction) {
    const btn = document.getElementById('epNfcConnectBtn');
    if (!window.NFCReaderService || !window.NfcCards) {
        epNfcStatus('Lecteur NFC indisponible dans ce navigateur.', 'warning');
        return;
    }
    if (btn && userAction) { btn.disabled = true; btn.textContent = '⏳ Connexion...'; }
    try {
        if (!NFCReaderService.isConnected()) {
            await NFCReaderService.connect();
        }
        if (!v2EpNfcPolling) {
            NfcCards.startPolling(eventNfcOnUid);
            v2EpNfcPolling = true;
        }
        if (userAction) epNfcStatus('✅ Scanner prêt — présentez une carte.', 'success');
    } catch (err) {
        epNfcStatus('❌ Lecteur NFC : ' + escapeHtmlV2(err.message), 'danger');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '📡 Connecter le lecteur'; }
    }
}

function eventNfcManualScan() {
    const input = document.getElementById('epNfcManualUid');
    if (!input) return;
    const uid = window.NFCReaderService
        ? NFCReaderService.normalizeUid(input.value)
        : String(input.value || '').trim().toUpperCase();
    input.value = '';
    if (!uid) return;
    eventNfcOnUid(uid);
}

async function eventNfcOnUid(rawUid) {
    // Le lecteur reste armé globalement : on ne traite une carte que si la
    // modal de participations est ouverte (évite les scans « fantômes »).
    if (!epModalActive() || !currentEventId) return;

    if (rawUid && typeof rawUid === 'object' && rawUid.uidUnavailable) {
        epNfcStatus('⚠️ Cette carte ne fournit pas d\'UID exploitable.', 'warning');
        return;
    }

    const uid = window.NFCReaderService
        ? NFCReaderService.normalizeUid(rawUid)
        : String(rawUid || '').trim().toUpperCase();
    if (!uid) return;

    // Anti-rebond : même carte lue deux fois de suite très rapidement.
    const now = Date.now();
    if (uid === v2EpLastNfcUid && now - v2EpLastNfcAt < 3000) return;
    if (v2EpNfcBusy) return;

    v2EpNfcBusy = true;
    v2EpLastNfcUid = uid;
    v2EpLastNfcAt = now;
    epNfcStatus('🔎 Lecture de la carte <code>' + escapeHtmlV2(uid) + '</code>…', 'info');

    try {
        const clubId = v2GetActiveClubId();
        if (!clubId) throw new Error('Aucun club sélectionné.');

        // 1. UID -> carte -> adhérent
        const { data: card, error: cardErr } = await supabase
            .from('nfc_cards')
            .select('uid, member_id, status')
            .eq('uid', uid)
            .maybeSingle();
        if (cardErr) throw cardErr;

        if (!card) {
            epNfcStatus('❌ Carte non reconnue (UID <code>' + escapeHtmlV2(uid) +
                '</code>). Attribuez-la à un adhérent dans « Cartes NFC ».', 'warning');
            return;
        }
        if (card.status !== 'assigned' || !card.member_id) {
            epNfcStatus('⚠️ Carte non attribuée à un adhérent (statut ' +
                escapeHtmlV2(card.status || '—') + ').', 'warning');
            return;
        }

        const { data: member, error: memErr } = await supabase
            .from('members')
            .select('id, first_name, last_name, club_id, current_group_id')
            .eq('id', card.member_id)
            .maybeSingle();
        if (memErr) throw memErr;
        if (!member) {
            epNfcStatus('⚠️ Adhérent introuvable pour cette carte.', 'warning');
            return;
        }
        if (member.club_id !== clubId) {
            epNfcStatus('⚠️ Cette carte appartient à un adhérent d\'un autre club.', 'warning');
            return;
        }

        const ev = v2EventsCache.find(e => e.id === currentEventId);
        const amount = Number(ev?.price || 0);
        const fullName = `${member.last_name} ${member.first_name}`;

        // 2. Inscription à l'événement (si pas déjà participant)
        const { data: existingPart, error: partErr } = await supabase
            .from('event_participants')
            .select('id')
            .eq('event_id', currentEventId)
            .eq('member_id', member.id)
            .maybeSingle();
        if (partErr) throw partErr;

        let part = existingPart;
        let created = false;
        if (!part) {
            const { data: inserted, error: insErr } = await supabase
                .from('event_participants')
                .insert({
                    club_id: clubId,
                    event_id: currentEventId,
                    member_id: member.id,
                    group_id: member.current_group_id || null
                })
                .select('id')
                .single();
            if (insErr) throw insErr;
            part = inserted;
            created = true;
        }

        // 3. Paiement : dernier paiement = statut courant
        const { data: pays, error: payErr } = await supabase
            .from('event_payments')
            .select('status, paid_on, amount, created_at')
            .eq('participant_id', part.id)
            .order('created_at', { ascending: false })
            .limit(1);
        if (payErr) throw payErr;

        const last = pays && pays[0];
        if (last && last.status === 'PAYE') {
            await refreshEpAfterNfc(member.id);
            epNfcStatus(`ℹ️ <b>${escapeHtmlV2(fullName)}</b> est déjà inscrit et payé pour cet événement.`, 'info');
            return;
        }

        const { error: insPayErr } = await supabase.from('event_payments').insert({
            participant_id: part.id,
            amount,
            status: 'PAYE',
            previous_status: last ? last.status : 'NON PAYE',
            paid_on: new Date().toISOString().slice(0, 10),
            changed_by: currentUser || 'NFC'
        });
        if (insPayErr) throw insPayErr;

        await refreshEpAfterNfc(member.id);
        epNfcStatus(
            `✅ <b>${escapeHtmlV2(fullName)}</b> ${created ? 'inscrit' : 'déjà inscrit'} et payé — ` +
            `<b>${amount.toLocaleString('fr-FR')} DA</b>.`, 'success');
    } catch (err) {
        console.error(err);
        epNfcStatus('❌ Erreur NFC : ' + escapeHtmlV2(err.message), 'danger');
    } finally {
        v2EpNfcBusy = false;
    }
}

async function refreshEpAfterNfc(memberId) {
    // Coche l'adhérent scanné dans la liste de sélection…
    const cb = document.querySelector(
        `#epMembersList input[type=checkbox][data-mid="${memberId}"]`);
    if (cb) {
        cb.checked = true;
        cb.closest('.assign-item')?.classList.add('selected');
    }
    // …puis rafraîchit le tableau / le résumé des paiements.
    await renderParticipantsTable();
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('eventForm')?.addEventListener('submit', handleEventSubmit);

    // Si le lecteur est déconnecté (ex. depuis « Cartes NFC »), le
    // prochain scan ré-enregistrera le watcher.
    if (window.NFCReaderService && NFCReaderService.onStatus) {
        NFCReaderService.onStatus(s => {
            if (!s || !s.connected) v2EpNfcPolling = false;
        });
    }
});
