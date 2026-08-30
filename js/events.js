// ============================================
// MODULE ÉVÉNEMENTS & PAIEMENTS DE PARTICIPATION — V2
// ============================================

let v2EventsCache = [];
let currentEventId = null;

async function loadEvents() {
    if (currentClub === 'admin') await v2PopulateAdminClubSelect('eventsToolbar');
    const clubId = v2GetActiveClubId();
    if (!clubId) return;

    try {
        const { data: events, error } = await supabase
            .from('events')
            .select('*')
            .eq('club_id', clubId)
            .order('event_date', { ascending: false });
        if (error) throw error;
        v2EventsCache = events || [];

        document.getElementById('eventsGrid').innerHTML = v2EventsCache.map(ev => `
            <div class="event-card">
                <h3 style="color:var(--primary-color)">${escapeHtmlV2(ev.title)}</h3>
                <div class="group-meta">
                    <span>📅 ${fmtDateV2(ev.event_date)}${ev.event_time ? ' ' + ev.event_time.slice(0, 5) : ''}</span>
                    ${ev.lieu ? `<span>📍 ${escapeHtmlV2(ev.lieu)}</span>` : ''}
                    <span>💰 ${Number(ev.price || 0).toLocaleString('fr-FR')} DA</span>
                    <span>🏷️ ${escapeHtmlV2(ev.type || 'stage')}</span>
                </div>
                ${ev.description ? `<p style="font-size:.85rem;color:var(--text-secondary);margin-bottom:12px">${escapeHtmlV2(ev.description)}</p>` : ''}
                <div class="group-actions">
                    <button class="btn btn-primary btn-sm" onclick="openParticipantsModal('${ev.id}')">👥 Participations</button>
                    <button class="btn btn-secondary btn-sm" onclick="openEventModal('${ev.id}')">✏️ Modifier</button>
                    <button class="btn btn-danger btn-sm" onclick="deleteEvent('${ev.id}')">🗑️</button>
                </div>
            </div>`).join('') || '<p>Aucun événement. Créez-en un.</p>';
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
        }
    }
    openModal('eventModal');
}

async function handleEventSubmit(e) {
    e.preventDefault();
    const clubId = v2GetActiveClubId();
    if (!clubId) return;

    const payload = {
        club_id: clubId,
        title: document.getElementById('eventTitle').value.trim(),
        event_date: document.getElementById('eventDate').value,
        event_time: document.getElementById('eventTime').value || null,
        lieu: document.getElementById('eventLieu').value.trim() || null,
        price: parseFloat(document.getElementById('eventPrice').value) || 0,
        description: document.getElementById('eventDescription').value.trim() || null,
        type: document.getElementById('eventType').value || 'stage'
    };

    const id = document.getElementById('eventId').value;
    try {
        const q = supabase.from('events');
        const { error } = id ? await q.update(payload).eq('id', id)
                             : await q.insert(payload);
        if (error) throw error;
        closeModal('eventModal');
        loadEvents();
    } catch (err) {
        showMessage('eventMessage', 'Erreur: ' + err.message, 'danger');
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

async function openParticipantsModal(eventId) {
    currentEventId = eventId;
    const ev = v2EventsCache.find(e => e.id === eventId);
    const clubId = v2GetActiveClubId();

    document.getElementById('epTitle').textContent = `👥 Participations — ${ev?.title || ''}`;
    document.getElementById('epMembersList').innerHTML = '<div class="spinner"></div>';
    document.getElementById('epParticipantsTable').innerHTML = '';
    openModal('eventParticipantsModal');

    try {
        const [membersRes, partsRes] = await Promise.all([
            supabase.from('members')
                .select('id, first_name, last_name, current_group_id')
                .eq('club_id', clubId).order('last_name'),
            supabase.from('event_participants')
                .select('id, member_id')
                .eq('event_id', eventId)
        ]);

        const partSet = new Set((partsRes.data || []).map(p => p.member_id));
        const groupsRes = await supabase.from('groups').select('id, name').eq('club_id', clubId);
        const groupNameOf = {};
        (groupsRes.data || []).forEach(g => groupNameOf[g.id] = g.name);

        document.getElementById('epMembersList').innerHTML =
            (membersRes.data || []).map(m => `
            <label class="assign-item ${partSet.has(m.id) ? 'selected' : ''}">
                <input type="checkbox" data-mid="${m.id}" ${partSet.has(m.id) ? 'checked' : ''}
                       onchange="this.closest('.assign-item').classList.toggle('selected', this.checked)">
                <span><b>${escapeHtmlV2(m.last_name)}</b> ${escapeHtmlV2(m.first_name)}</span>
                <span class="badge badge-info" style="margin-left:auto">
                    ${groupNameOf[m.current_group_id] || 'Sans groupe'}
                </span>
            </label>`).join('');

        await renderParticipantsTable();
    } catch (err) {
        alert(err.message);
    }
}

async function renderParticipantsTable() {
    const ev = v2EventsCache.find(e => e.id === currentEventId);

    const [partsRes, paysRes, gmRes] = await Promise.all([
        supabase.from('event_participants')
            .select('id, member_id')
            .eq('event_id', currentEventId),
        supabase.from('event_payments')
            .select('participant_id, status, paid_on, amount, created_at')
            .order('created_at'),
        supabase.from('group_members')
            .select('member_id, group_id').is('end_date', null)
    ]);

    const memberIds = (partsRes.data || []).map(p => p.member_id);
    const membersRes = memberIds.length
        ? await supabase.from('members').select('id, first_name, last_name').in('id', memberIds)
        : { data: [] };

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

    v2EpCache = partsRes.data || [];

    document.getElementById('epParticipantsTable').innerHTML = `
        <table class="matrix-table">
            <thead><tr>
                <th class="row-label">Adhérent</th><th>Groupe</th>
                <th>Montant</th><th>Statut</th><th>Date paiement</th><th></th>
            </tr></thead>
            <tbody>
            ${(partsRes.data || []).map(p => {
                const pay = lastPay[p.id];
                const paid = pay?.status === 'PAYE';
                return `<tr>
                    <td class="row-label">${escapeHtmlV2(nameOf[p.member_id] || p.member_id)}</td>
                    <td>${escapeHtmlV2(groupNameOf[groupOf[p.member_id]] || '—')}</td>
                    <td>${Number(pay?.amount ?? ev?.price ?? 0).toLocaleString('fr-FR')} DA</td>
                    <td><span class="pay-toggle ${paid ? 'paid' : 'unpaid'}">${paid ? '✅ PAYÉ' : '❌ NON PAYÉ'}</span></td>
                    <td>${pay?.paid_on ? fmtDateV2(pay.paid_on) : '—'}</td>
                    <td>
                        <button class="btn btn-sm ${paid ? 'btn-danger' : 'btn-success'}"
                                onclick="toggleEventPayment('${p.id}', '${paid ? 'PAYE' : 'NON PAYE'}')">
                            ${paid ? 'Annuler' : 'Encaisser'}
                        </button>
                    </td>
                </tr>`;
            }).join('') || '<tr><td colspan="6">Aucun participant sélectionné.</td></tr>'}
            </tbody>
        </table>`;
}

async function saveParticipants() {
    const clubId = v2GetActiveClubId();
    const checked = [...document.querySelectorAll('#epMembersList input[type=checkbox]:checked')]
        .map(cb => cb.dataset.mid);

    try {
        const { data: current } = await supabase
            .from('event_participants')
            .select('id, member_id')
            .eq('event_id', currentEventId);
        const currentIds = new Set((current || []).map(c => c.member_id));

        // Ajouts
        const toAdd = checked.filter(id => !currentIds.has(id));
        if (toAdd.length) {
            const { error } = await supabase.from('event_participants')
                .insert(toAdd.map(mid => ({
                    club_id: clubId, event_id: currentEventId,
                    member_id: mid, group_id: null
                })));
            if (error) throw error;
        }

        // Retraits (les paiements sont supprimés en cascade)
        const removed = (current || []).filter(c => !checked.includes(c.member_id));
        for (const r of removed) {
            await supabase.from('event_participants').delete().eq('id', r.id);
        }

        await renderParticipantsTable();
        showMessage('epMessage', 'Participations mises à jour.', 'success');
    } catch (err) {
        showMessage('epMessage', err.message, 'danger');
    }
}

async function toggleEventPayment(participantId, currentState) {
    const nowPaid = currentState === 'PAYE';
    const ev = v2EventsCache.find(e => e.id === currentEventId);

    const payload = {
        participant_id: participantId,
        amount: Number(ev?.price || 0),
        status: nowPaid ? 'NON PAYE' : 'PAYE',
        previous_status: currentState,
        paid_on: nowPaid ? null : new Date().toISOString().slice(0, 10),
        changed_by: currentUser || 'system'
    };

    const { error } = await supabase.from('event_payments').insert(payload);
    if (error) { alert(error.message); return; }
    renderParticipantsTable();
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('eventForm')?.addEventListener('submit', handleEventSubmit);
});
