// ============================================
// MODULE GROUPES & SÉANCES — V2
// ============================================

function v2GetActiveClubId() {
    if (!window.v2AdminClubs) return currentClub === 'admin' ? null : currentClub.id;
    const sel = document.getElementById('v2AdminClubSelect');
    if (currentClub === 'admin') {
        return sel && sel.value ? sel.value : null;
    }
    return currentClub.id;
}

function v2IsAdmin() {
    return currentClub === 'admin' || (currentClub && currentClub.isadmin);
}

const V2_DAYS = [
    { idx: 1, key: 'lundi', label: 'Lun' },
    { idx: 2, key: 'mardi', label: 'Mar' },
    { idx: 3, key: 'mercredi', label: 'Mer' },
    { idx: 4, key: 'jeudi', label: 'Jeu' },
    { idx: 5, key: 'vendredi', label: 'Ven' },
    { idx: 6, key: 'samedi', label: 'Sam' },
    { idx: 0, key: 'dimanche', label: 'Dim' }
];

async function loadGroups() {
    if (currentClub === 'admin') await v2PopulateAdminClubSelect('groupsToolbar');
    renderGroupsEmpty();
    const clubId = v2GetActiveClubId();
    if (!clubId) return;

    try {
        const { data: groups, error } = await supabase
            .from('groups')
            .select('*')
            .eq('club_id', clubId)
            .order('created_at', { ascending: true });
        if (error) throw error;
        v2GroupsCache = groups || [];

        const { count: membersCount } = await supabase
            .from('group_members')
            .select('id', { count: 'exact', head: true })
            .eq('club_id', clubId)
            .is('end_date', null);

        const { data: sessionCounts } = await supabase
            .from('sessions')
            .select('group_id')
            .eq('club_id', clubId);

        const perGroup = {};
        (sessionCounts || []).forEach(s => { perGroup[s.group_id] = (perGroup[s.group_id] || 0) + 1; });

        const grid = document.getElementById('groupsGrid');
        grid.innerHTML = (groups || []).map(g => {
            const sched = g.schedule || {};
            const chips = Object.entries(sched)
                .map(([d, t]) => `<span class="schedule-chip">${d} ${t}</span>`).join('');
            return `
            <div class="group-card ${g.is_active ? '' : 'inactive'}">
                <h3>
                    ${escapeHtmlV2(g.name)}
                    <span class="session-status ${g.is_active ? 'live' : 'cancelled'}">
                        ${g.is_active ? 'Actif' : 'Inactif'}
                    </span>
                </h3>
                <div class="group-meta">
                    <span>📅 ${fmtDateV2(g.start_date)} → ${g.end_date ? fmtDateV2(g.end_date) : '…'}</span>
                    <span>🎯 ${g.planned_sessions_count ?? '—'} séances prévues</span>
                    <span>🗂️ ${perGroup[g.id] || 0} séances créées</span>
                    ${g.pause_start_date ? `<span>⏸️ Pause ${fmtDateV2(g.pause_start_date)} → ${g.pause_end_date ? fmtDateV2(g.pause_end_date) : '…'}</span>` : ''}
                    ${(g.extra_sessions || []).length ? `<span>➕ ${g.extra_sessions.length} séance(s) en plus</span>` : ''}
                </div>
                ${g.description ? `<p style="font-size:.85rem;color:var(--text-secondary);margin-bottom:10px">${escapeHtmlV2(g.description)}</p>` : ''}
                ${chips ? `<div class="group-schedule">${chips}</div>` : ''}
                <div class="group-actions">
                    <button class="btn btn-primary btn-sm" onclick="openAssignModal('${g.id}')">👥 Adhérents</button>
                    <button class="btn btn-info btn-sm" onclick="viewGroupSessions('${g.id}', '${escapeHtmlV2(g.name).replace(/'/g, "\\'")}')">🗓️ Séances</button>
                    <button class="btn btn-secondary btn-sm" onclick="openGroupModal('${g.id}')">✏️ Modifier</button>
                    <button class="btn btn-danger btn-sm" onclick="deleteGroup('${g.id}')">🗑️</button>
                </div>
            </div>`;
        }).join('') || '<p>Aucun groupe. Créez votre premier groupe.</p>';
    } catch (err) {
        console.error(err);
        showMessage('groupsMessage', 'Erreur chargement groupes: ' + err.message, 'danger');
    }
}

function renderGroupsEmpty() {
    document.getElementById('groupsGrid').innerHTML =
        '<div class="spinner"></div>';
}

function escapeHtmlV2(str) {
    return String(str ?? '').replace(/[&<>"']/g,
        c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDateV2(d) {
    if (!d) return '-';
    return new Date(d + 'T00:00:00').toLocaleDateString('fr-FR');
}

/* ---------- Création / modification ---------- */

/* ---------- Planning : pause + séances en plus ---------- */

const GROUP_EXTRA_DAYS = [
    { idx: 0, key: 'dimanche', label: 'Dimanche' },
    { idx: 1, key: 'lundi',    label: 'Lundi' },
    { idx: 2, key: 'mardi',    label: 'Mardi' },
    { idx: 3, key: 'mercredi', label: 'Mercredi' },
    { idx: 4, key: 'jeudi',    label: 'Jeudi' },
    { idx: 5, key: 'vendredi', label: 'Vendredi' },
    { idx: 6, key: 'samedi',   label: 'Samedi' }
];

let groupExtras = [];

function populateGroupExtraDayOptions() {
    const sel = document.getElementById('groupExtraDay');
    if (!sel || sel.options.length > 1) return;
    GROUP_EXTRA_DAYS.forEach(d => {
        sel.add(new Option(d.label, String(d.idx)));
    });
}

function ymd(dt) {
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const d = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

// Rentrée (1er septembre) de la saison en cours
function currentSeasonStartYmd() {
    const now = new Date();
    const y = now.getMonth() + 1 >= 9 ? now.getFullYear() : now.getFullYear() - 1;
    return `${y}-09-01`;
}

function addDays(dateStr, n) {
    const dt = new Date(dateStr + 'T00:00:00');
    dt.setDate(dt.getDate() + n);
    return ymd(dt);
}

function nextOccurrence(dayIdx) {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    let diff = (dayIdx - t.getDay() + 7) % 7;
    if (diff === 0) diff = 7;     // strictement après aujourd'hui
    t.setDate(t.getDate() + diff);
    return ymd(t);
}

function renderGroupExtras() {
    const wrap = document.getElementById('groupExtrasList');
    if (!wrap) return;
    groupExtras.sort((a, b) => a.date.localeCompare(b.date));
    wrap.innerHTML = groupExtras.map((e, i) => `
        <div class="schedule-row" style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
            <span style="min-width:120px;font-weight:600;">${fmtDateV2(e.date)}</span>
            <span>${e.time}</span>
            <button type="button" class="btn btn-danger btn-sm" onclick="removeGroupExtra(${i})">✖</button>
        </div>`).join('')
        || '<span style="color:var(--text-secondary);font-size:.85rem;">Aucune séance en plus.</span>';
}

function addGroupExtraWeeks() {
    const daySel = document.getElementById('groupExtraDay');
    const time = document.getElementById('groupExtraTime').value;
    const weeks = parseInt(document.getElementById('groupExtraWeeks').value, 10) || 1;
    const dayIdx = parseInt(daySel.value, 10);
    if (isNaN(dayIdx)) { alert('Choisissez un jour.'); return; }
    if (!time) { alert('Choisissez une heure.'); return; }
    let d = nextOccurrence(dayIdx);
    for (let i = 0; i < weeks; i++) {
        groupExtras.push({ date: d, time });
        d = addDays(d, 7);
    }
    renderGroupExtras();
}

function removeGroupExtra(index) {
    groupExtras.splice(index, 1);
    renderGroupExtras();
}

function openGroupModal(groupId) {
    const modal = document.getElementById('groupModal');
    const form = document.getElementById('groupForm');
    form.reset();
    document.getElementById('groupId').value = groupId || '';
    document.getElementById('groupModalTitle').textContent = groupId ? '✏️ Modifier le groupe' : '➕ Nouveau groupe';
    populateGroupExtraDayOptions();

    if (groupId) {
        const card = findGroupCache(groupId);
        if (card) {
            document.getElementById('groupName').value = card.name || '';
            document.getElementById('groupDescription').value = card.description || '';
            document.getElementById('groupStartDate').value = card.start_date || '';
            document.getElementById('groupEndDate').value = card.end_date || '';
            document.getElementById('groupPlannedCount').value = card.planned_sessions_count ?? '';
            document.getElementById('groupPauseStart').value = card.pause_start_date || '';
            document.getElementById('groupPauseEnd').value = card.pause_end_date || '';
            const sched = card.schedule || {};
            V2_DAYS.forEach(d => {
                const cb = document.getElementById('sched_' + d.key);
                const tm = document.getElementById('schedtime_' + d.key);
                cb.checked = !!sched[d.key];
                tm.value = sched[d.key] || '';
            });
            groupExtras = Array.isArray(card.extra_sessions)
                ? card.extra_sessions.map(e => ({ date: e.date, time: e.time }))
                : [];
            renderGroupExtras();
        }
    } else {
        V2_DAYS.forEach(d => {
            document.getElementById('sched_' + d.key).checked = false;
            document.getElementById('schedtime_' + d.key).value = '';
        });
        document.getElementById('groupStartDate').value = currentSeasonStartYmd();
        document.getElementById('groupPauseStart').value = '';
        document.getElementById('groupPauseEnd').value = '';
        groupExtras = [];
        renderGroupExtras();
    }
    openModal('groupModal');
}

let v2GroupsCache = [];
function findGroupCache(id) {
    return v2GroupsCache.find(g => g.id === id);
};

async function handleGroupSubmit(e) {
    e.preventDefault();
    const clubId = v2GetActiveClubId();
    if (!clubId) { showMessage('groupMessage', 'Sélectionnez un club', 'danger'); return; }

    const schedule = {};
    V2_DAYS.forEach(d => {
        const cb = document.getElementById('sched_' + d.key);
        const tm = document.getElementById('schedtime_' + d.key);
        if (cb.checked && tm.value) schedule[d.key] = tm.value;
    });

    const pauseStart = document.getElementById('groupPauseStart').value || null;
    const pauseEnd = document.getElementById('groupPauseEnd').value || null;
    if (pauseStart && pauseEnd && pauseStart > pauseEnd) {
        showMessage('groupMessage', 'La fin de pause doit être après son début.', 'danger');
        return;
    }

    const payload = {
        club_id: clubId,
        name: document.getElementById('groupName').value.trim(),
        description: document.getElementById('groupDescription').value.trim() || null,
        start_date: document.getElementById('groupStartDate').value || null,
        end_date: document.getElementById('groupEndDate').value || null,
        planned_sessions_count: parseInt(document.getElementById('groupPlannedCount').value, 10) || null,
        pause_start_date: pauseStart,
        pause_end_date: pauseEnd,
        extra_sessions: groupExtras,
        schedule
    };

    const id = document.getElementById('groupId').value;
    try {
        const q = supabase.from('groups');
        const { error } = id
            ? await q.update(payload).eq('id', id)
            : await q.insert(payload);
        if (error) throw error;
        closeModal('groupModal');
        loadGroups();
    } catch (err) {
        showMessage('groupMessage', 'Erreur: ' + err.message, 'danger');
    }
}

async function toggleGroupActive(groupId, isActive) {
    const { error } = await supabase.from('groups').update({ is_active: isActive }).eq('id', groupId);
    if (!error) loadGroups();
}

async function deleteGroup(groupId) {
    if (!confirm('Supprimer ce groupe ? Les séances liées seront également supprimées.')) return;
    const { error } = await supabase.from('groups').delete().eq('id', groupId);
    if (error) { alert('Erreur lors de la suppression'); return; }
    loadGroups();
}

/* ---------- Affectation des adhérents ---------- */

let assignGroupId = null;
let assignSelection = new Set();

async function openAssignModal(groupId) {
    assignGroupId = groupId;
    assignSelection = new Set();
    const clubId = v2GetActiveClubId();
    if (!clubId) return;

    try {
        const [membersRes, currentRes] = await Promise.all([
            supabase.from('members')
                .select('id, first_name, last_name, current_group_id')
                .eq('club_id', clubId)
                .order('last_name'),
            supabase.from('group_members')
                .select('member_id')
                .eq('group_id', groupId)
                .is('end_date', null)
        ]);

        (currentRes.data || []).forEach(r => assignSelection.add(r.member_id));
        const group = findGroupCache(groupId);

        document.getElementById('assignModalTitle').textContent =
            `👥 Affectation — ${group ? group.name : ''}`;

        const list = document.getElementById('assignMembersList');
        list.innerHTML = (membersRes.data || []).map(m => {
            const selected = assignSelection.has(m.id);
            const inOther = m.current_group_id && m.current_group_id !== groupId;
            return `
            <label class="assign-item ${selected ? 'selected' : ''}" data-mid="${m.id}">
                <input type="checkbox" ${selected ? 'checked' : ''} onchange="toggleAssign('${m.id}', this)">
                <span><b>${escapeHtmlV2(m.last_name)}</b> ${escapeHtmlV2(m.first_name)}</span>
                ${inOther ? '<span class="badge badge-warning" style="margin-left:auto">autre groupe</span>' : ''}
            </label>`;
        }).join('') || '<p style="padding:15px">Aucun adhérent.</p>';

        updateAssignCount();
        openModal('assignModal');
    } catch (err) {
        alert('Erreur: ' + err.message);
    }
}

function toggleAssign(memberId, checkbox) {
    if (checkbox.checked) assignSelection.add(memberId);
    else assignSelection.delete(memberId);
    checkbox.closest('.assign-item').classList.toggle('selected', checkbox.checked);
    updateAssignCount();
}

function updateAssignCount() {
    document.getElementById('assignCount').textContent =
        `${assignSelection.size} sélectionné(s)`;
}

async function saveAssignments() {
    const clubId = v2GetActiveClubId();
    if (!clubId || !assignGroupId) return;
    try {
        // Clôturer les affectations actuelles du groupe qui ne sont plus sélectionnées
        const { data: current } = await supabase
            .from('group_members')
            .select('id, member_id')
            .eq('group_id', assignGroupId)
            .is('end_date', null);

        const toClose = (current || []).filter(r => !assignSelection.has(r.member_id));
        for (const row of toClose) {
            await supabase
                .from('group_members')
                .update({ end_date: new Date().toISOString().slice(0, 10) })
                .eq('id', row.id);
        }

        // Ajouter les nouveaux
        const existingIds = new Set((current || []).map(r => r.member_id));
        const toAdd = [...assignSelection].filter(id => !existingIds.has(id));

        if (toAdd.length) {
            const rows = toAdd.map(mid => ({
                club_id: clubId,
                group_id: assignGroupId,
                member_id: mid,
                start_date: new Date().toISOString().slice(0, 10)
            }));
            const { error } = await supabase.from('group_members').insert(rows);
            if (error) throw error;
        }

        // Mettre à jour le groupe courant des membres
        const allTouched = [...toAdd, ...toClose.map(r => r.member_id)];
        for (const mid of allTouched) {
            const stillHere = assignSelection.has(mid);
            await supabase
                .from('members')
                .update({ current_group_id: stillHere ? assignGroupId : null })
                .eq('id', mid);
        }

        closeModal('assignModal');
        alert('Affectations enregistrées.');
    } catch (err) {
        alert('Erreur: ' + err.message);
    }
}

/* ---------- Séances ---------- */

let currentSessionsGroup = null;

async function viewGroupSessions(groupId, groupName) {
    currentSessionsGroup = groupId;
    document.getElementById('sessionsPanelTitle').textContent = `🗓️ Séances — ${groupName}`;
    document.getElementById('sessionsPanel').classList.remove('hidden');

    const { data: sessions, error } = await supabase
        .from('sessions')
        .select('*')
        .eq('group_id', groupId)
        .order('session_date', { ascending: true })
        .limit(200);
    if (error) { alert(error.message); return; }

    const tbody = document.getElementById('sessionsTableBody');
    tbody.innerHTML = (sessions || []).map(s => `
        <tr>
            <td>${fmtDateV2(s.session_date)}</td>
            <td>${(s.start_time || '').slice(0, 5)}</td>
            <td>${s.duration ? s.duration + ' min' : '—'}</td>
            <td><span class="session-status ${s.status}">${s.status}</span></td>
            <td>
                ${s.status === 'waiting' ? `<button class="btn btn-success btn-sm" onclick="setSessionStatus('${s.id}','live')">▶ Démarrer</button>` : ''}
                ${s.status === 'live' ? `<button class="btn btn-secondary btn-sm" onclick="setSessionStatus('${s.id}','paused')">⏸ Pause</button>` : ''}
                ${s.status === 'paused' ? `<button class="btn btn-success btn-sm" onclick="setSessionStatus('${s.id}','live')">▶ Reprendre</button>` : ''}
                ${(s.status === 'live' || s.status === 'paused') ? `<button class="btn btn-danger btn-sm" onclick="setSessionStatus('${s.id}','completed')">⏹ Terminer</button>` : ''}
                ${(s.status === 'waiting' || s.status === 'paused') ? `<button class="btn btn-warning btn-sm" onclick="setSessionStatus('${s.id}','cancelled')">⛔ Annuler</button>` : ''}
            </td>
        </tr>`        ).join('') || '<tr><td colspan="5">Aucune séance. Utilisez « Générer » pour créer le planning.</td></tr>';
}

async function generateSessionsForGroup() {
    const g = findGroupCache(currentSessionsGroup);
    if (!g) return;
    const hasSchedule = !!(g.schedule && Object.keys(g.schedule).length);
    const hasExtras = Array.isArray(g.extra_sessions) && g.extra_sessions.length;
    if (!hasSchedule && !hasExtras) {
        alert("Définissez d'abord un planning du groupe (jours + heures) ou des séances en plus.");
        return;
    }
    if (!confirm('Générer les séances manquantes depuis le planning centralisé ?\n(Saison en cours, pauses et séances annulées respectées — rien n\'est supprimé.)')) return;

    const created = await generateGroupSessions(currentSessionsGroup);
    if (created === 0) {
        alert('Aucune nouvelle séance à générer : toutes les dates planifiées existent déjà.');
    } else {
        alert(`${created} séance(s) générée(s).`);
    }
    viewGroupSessions(g.id, g.name);
}

async function setSessionStatus(sessionId, action) {
    const now = new Date().toISOString();
    const patch = {};

    if (action === 'live') {
        const { data: s } = await supabase
            .from('sessions').select('status, session_started_at, session_paused_at')
            .eq('id', sessionId).single();
        patch.status = 'live';
        if (s && s.session_paused_at) {
            // Reprendre : décaler started_at de la durée de pause
            if (s.session_started_at) {
                const pausedMs = new Date(now) - new Date(s.session_paused_at);
                const shifted = new Date(new Date(s.session_started_at).getTime() + pausedMs);
                patch.session_started_at = shifted.toISOString();
            }
            patch.session_paused_at = null;
        } else {
            patch.session_started_at = now;
        }
    } else if (action === 'paused') {
        patch.status = 'paused';
        patch.session_paused_at = now;
    } else if (action === 'completed') {
        patch.status = 'completed';
        patch.session_ended_at = now;
    } else if (action === 'cancelled') {
        if (!confirm('Annuler cette séance ? Les présences déjà pointées sont conservées (historique).')) return;
        patch.status = 'cancelled';
        patch.session_ended_at = now;
    }

    const { error } = await supabase.from('sessions').update(patch).eq('id', sessionId);
    if (error) { alert(error.message); return; }

    // Rafraîchir la ligne affichée
    const { data: grp } = await supabase.from('groups').select('name').eq('id', currentSessionsGroup).single();
    if (grp) viewGroupSessions(currentSessionsGroup, grp.name);
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('groupForm')?.addEventListener('submit', handleGroupSubmit);
    populateGroupExtraDayOptions();
});
