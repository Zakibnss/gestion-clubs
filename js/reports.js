// ============================================
// MODULE RAPPORTS V2
// Présence individuel / matrice groupe / abonnements
// Export CSV (UTF-8 Excel FR) + PDF (impression)
// ============================================

let v2LastReport = null;

/* ---------- Filtres du rapport de paiement ---------- */

/* Sélecteur de club du rapport de paiement (comptes admin uniquement).
   Permet de générer un rapport global « tous les clubs ». */
async function v2InitPayClubFilter() {
    const wrap = document.getElementById('payClubWrap');
    const sel = document.getElementById('payClub');
    if (!wrap || !sel) return;

    if (!v2IsAdmin()) {
        wrap.style.display = 'none';
        return;
    }
    wrap.style.display = '';

    if (!Array.isArray(window.v2AdminClubs) || !window.v2AdminClubs.length) {
        const { data } = await supabase.from('clubs').select('id, name').order('name');
        window.v2AdminClubs = data || [];
    }

    const hadOptions = sel.options.length > 0;
    const current = sel.value;
    sel.innerHTML = '<option value="">🌍 Tous les clubs (global)</option>' +
        (window.v2AdminClubs || []).map(c =>
            `<option value="${c.id}">${escapeHtmlV2(c.name)}</option>`).join('');

    if (hadOptions && [...sel.options].some(o => o.value === current)) {
        sel.value = current;
    } else {
        const active = v2GetActiveClubId();
        sel.value = active || '';
    }
}

/* Recharge la liste des événements selon le club choisi pour le rapport.
   En mode global, le nom du club est ajouté au libellé de l'événement. */
async function v2LoadPayEventOptions() {
    const sel = document.getElementById('payEvent');
    if (!sel) return;

    const isAdmin = v2IsAdmin();
    const payClub = document.getElementById('payClub');
    const globalScope = isAdmin && payClub && !payClub.value;
    const clubId = globalScope ? null
        : (isAdmin ? (payClub?.value || v2GetActiveClubId()) : v2GetActiveClubId());

    if (!globalScope && !clubId) {
        sel.innerHTML = '<option value="">Tous les événements</option>';
        return;
    }

    let q = supabase.from('events')
        .select('id, title, event_date, club_id')
        .order('event_date', { ascending: false });
    if (!globalScope) q = q.eq('club_id', clubId);

    const { data, error } = await q;
    if (error) { console.error('[rapport paiement] événements:', error.message); return; }

    const clubName = {};
    if (globalScope) {
        (window.v2AdminClubs || []).forEach(c => clubName[c.id] = c.name);
        const missingIds = [...new Set((data || []).map(ev => ev.club_id))]
            .filter(id => id && !clubName[id]);
        if (missingIds.length) {
            const { data: clubs } = await supabase.from('clubs')
                .select('id, name').in('id', missingIds);
            (clubs || []).forEach(c => clubName[c.id] = c.name);
        }
    }

    sel.innerHTML = '<option value="">Tous les événements</option>' +
        (data || []).map(ev => {
            const suffix = globalScope && clubName[ev.club_id]
                ? ' (' + escapeHtmlV2(clubName[ev.club_id]) + ')' : '';
            return `<option value="${ev.id}">${escapeHtmlV2(ev.title)} — ${fmtDateV2(ev.event_date)}${suffix}</option>`;
        }).join('');
}

async function initReports() {
    if (currentClub === 'admin') await v2PopulateAdminClubSelect('reportsToolbar');
    await v2InitPayClubFilter();
    const clubId = v2GetActiveClubId();

    // Dates par défaut : renseignées même sans club sélectionné pour que
    // le rapport de paiement global (admin) soit utilisable directement.
    const today = new Date().toISOString().slice(0, 10);
    const firstOfMonth = today.slice(0, 8) + '01';
    document.getElementById('repFrom').value = firstOfMonth;
    document.getElementById('repTo').value = today;
    document.getElementById('srFrom').value = today.slice(0, 4) + '-01';
    document.getElementById('srTo').value = today.slice(0, 7);
    document.getElementById('evFrom').value = firstOfMonth;
    document.getElementById('evTo').value = today;
    if (document.getElementById('payFrom')) {
        document.getElementById('payFrom').value = firstOfMonth;
        document.getElementById('payTo').value = today;
    }

    await v2LoadPayEventOptions();

    if (!clubId) return;

    try {
        const [membersRes, groupsRes] = await Promise.all([
            supabase.from('members').select('id, first_name, last_name')
                .eq('club_id', clubId).order('last_name'),
            supabase.from('groups').select('id, name')
                .eq('club_id', clubId).order('name')
        ]);

        const opt = (list) => (list || [])
            .map(x => `<option value="${x.id}">${escapeHtmlV2(x.last_name ? x.last_name + ' ' + x.first_name : x.name)}</option>`)
            .join('');

        document.getElementById('repMember').innerHTML = '<option value="">— Choisir —</option>' + opt(membersRes.data);
        document.getElementById('repGroup').innerHTML = '<option value="">— Choisir —</option>' + opt(groupsRes.data);
        document.getElementById('srMember').innerHTML = '<option value="">Tous les adhérents</option>' + opt(membersRes.data);
    } catch (err) {
        showMessage('reportsMessage', 'Erreur init rapports: ' + err.message, 'danger');
    }
}

function repRange() {
    return [
        document.getElementById('repFrom').value,
        document.getElementById('repTo').value
    ];
}

/* ================= RAPPORT INDIVIDUEL ================= */

async function runIndividualReport() {
    const memberId = document.getElementById('repMember').value;
    if (!memberId) { alert('Sélectionnez un adhérent'); return; }
    const [from, to] = repRange();
    const clubId = v2GetActiveClubId();

    try {
        const { data: member } = await supabase.from('members')
            .select('id, first_name, last_name, current_group_id, start_date').eq('id', memberId).single();

        let groupId = member.current_group_id;
        if (!groupId) {
            const { data: gm } = await supabase.from('group_members')
                .select('group_id').eq('member_id', memberId).is('end_date', null).limit(1);
            groupId = gm?.[0]?.group_id;
        }

        // Date de réinscription : aucune présence/absence avant (source unique)
        const { data: regs } = await supabase.from('registrations')
            .select('start_date')
            .eq('member_id', memberId)
            .eq('is_active', true)
            .order('start_date', { ascending: false })
            .limit(1);
        const rein = (regs?.[0]?.start_date || member.start_date || null);
        const effFrom = (rein && rein > from) ? rein : from;

        const [groupRes, attLegacyRes] = await Promise.all([
            groupId ? supabase.from('groups').select('name').eq('id', groupId).single()
                    : Promise.resolve({ data: null }),
            supabase.from('attendance')
                .select('attendance_date, attendance_time')
                .eq('member_id', memberId)
                .gte('attendance_date', from).lte('attendance_date', to)
        ]);

        // Présences legacy par date (NFC / scan manuel / pointage)
        const legacyTimes = {};
        (attLegacyRes.data || []).forEach(a => {
            legacyTimes[a.attendance_date] = (a.attendance_time || '').slice(0, 5);
        });

        // Présences enregistrées au niveau des séances (session_attendances)
        let sessionPresenceDates = new Set();
        if (groupId) {
            const { data: sa } = await supabase.from('session_attendances')
                .select('session_id')
                .eq('member_id', memberId)
                .neq('status', 'ABSENT');
            const saIds = (sa || []).map(x => x.session_id);
            if (saIds.length) {
                const { data: sRows } = await supabase.from('sessions')
                    .select('session_date')
                    .in('id', saIds)
                    .gte('session_date', from).lte('session_date', to)
                    .eq('group_id', groupId);
                (sRows || []).forEach(r => sessionPresenceDates.add(r.session_date));
            }
        }

        // Séances planifiées du groupe (source unique : planning + extras − pauses − annulées)
        const planned = groupId ? await getGroupSessions(groupId, effFrom, to) : [];

        let rows;
        if (planned.length) {
            rows = planned.map(s => {
                const present = legacyTimes[s.session_date] || sessionPresenceDates.has(s.session_date);
                return {
                    date: s.session_date,
                    time: (legacyTimes[s.session_date] || '').slice(0, 5),
                    present: !!present,
                    extra: s.source === 'extra'
                };
            });
        } else {
            // Aucune séance planifiée sur la période → pointages legacy
            rows = Object.keys(legacyTimes).sort().map(d => ({
                date: d,
                time: legacyTimes[d],
                present: true,
                extra: false
            }));
        }

        const present = rows.filter(r => r.present).length;
        const rate = rows.length ? (present * 100 / rows.length) : 0;

        const memberName = `${member.last_name} ${member.first_name}`;
        const groupName = groupRes.data?.name || 'Sans groupe';

        const headers = ['Date', 'Heure pointage', 'Statut'];
        const csvRows = rows.map(r => [fmtDateV2(r.date), r.time || '-', r.present ? 'PRESENT' : 'ABSENT']);

        document.getElementById('individualReportResult').innerHTML = `
            <h3 style="color:var(--primary-color)">👤 ${escapeHtmlV2(memberName)} — ${escapeHtmlV2(groupName)}</h3>
            ${rein ? `<p style="color:var(--text-secondary);font-size:.85rem">ℹ️ Objectif compté depuis la réinscription : ${fmtDateV2(rein)}.</p>` : ''}
            <div class="report-stats">
                <span class="stat-pill">Séances : <b>${rows.length}</b></span>
                <span class="stat-pill">Présences : <b>${present}</b></span>
                <span class="stat-pill">Absences : <b>${rows.length - present}</b></span>
                <span class="stat-pill">Taux : <b>${rate.toFixed(2)} %</b></span>
            </div>
            <div class="table-responsive">
                <table class="matrix-table">
                    <thead><tr><th>Date</th><th>Pointage</th><th>Statut</th></tr></thead>
                    <tbody>${rows.map(r => `
                        <tr>
                            <td class="row-label">${fmtDateV2(r.date)}${r.extra ? ' <span class="session-status live">+ extra</span>' : ''}</td>
                            <td>${r.time || '-'}</td>
                            <td class="${r.present ? 'cell-p' : 'cell-a'}">${r.present ? 'Présent' : 'Absent'}</td>
                        </tr>`).join('')}
                    </tbody>
                </table>
            </div>`;

        setLastReport('Rapport de présence — ' + memberName, headers, csvRows,
            [`Adhérent : ${memberName}`, `Groupe : ${groupName}`,
             `Période : ${fmtDateV2(from)} → ${fmtDateV2(to)}`,
             rein ? `Réinscription : ${fmtDateV2(rein)}` : null],
            [['Séances', rows.length], ['Présences', present], ['Absences', rows.length - present], ['Taux', rate.toFixed(2) + ' %']],
            buildDetailHtml(rows));
    } catch (err) {
        showMessage('reportsMessage', err.message, 'danger');
    }
}

function buildDetailHtml(rows) {
    return `<table><thead><tr><th>Date</th><th>Pointage</th><th>Statut</th></tr></thead>
        <tbody>${rows.map(r => `<tr><td>${fmtDateV2(r.date)}</td><td>${r.time || '-'}</td>
        <td>${r.present ? 'Présent' : 'Absent'}</td></tr>`).join('')}</tbody></table>`;
}

/* ================= MATRICE GROUPE ================= */

async function runGroupMatrix() {
    const groupId = document.getElementById('repGroup').value;
    if (!groupId) { alert('Sélectionnez un groupe'); return; }
    const [from, to] = repRange();
    const clubId = v2GetActiveClubId();

    try {
        const [groupRes, sessionsRes, gmRes] = await Promise.all([
            supabase.from('groups').select('name').eq('id', groupId).single(),
            supabase.from('sessions')
                .select('id, session_date')
                .eq('group_id', groupId)
                .gte('session_date', from).lte('session_date', to)
                .neq('status', 'cancelled')
                .order('session_date'),
            supabase.from('group_members')
                .select('member_id, start_date, end_date')
                .eq('group_id', groupId)
        ]);

        // Membres qui appartenaient au groupe durant la période
        const memberIds = (gmRes.data || [])
            .filter(gm => gm.start_date <= to && (!gm.end_date || gm.end_date >= from))
            .map(gm => gm.member_id);

        if (!memberIds.length) {
            document.getElementById('groupMatrixResult').innerHTML = '<p>Aucun membre sur la période.</p>';
            return;
        }

        const [membersRes, saRes, legacyRes, regsRes] = await Promise.all([
            supabase.from('members').select('id, first_name, last_name, start_date').in('id', memberIds),
            supabase.from('session_attendances')
                .select('member_id, session_id, check_in_time, status')
                .in('session_id', (sessionsRes.data || []).map(s => s.id)),
            // Pointages legacy par date (QR / manuel / NFC miroir)
            supabase.from('attendance')
                .select('member_id, attendance_date')
                .in('member_id', memberIds)
                .gte('attendance_date', from).lte('attendance_date', to),
            supabase.from('registrations')
                .select('member_id, start_date')
                .eq('is_active', true)
                .in('member_id', memberIds)
        ]);

        // Séances planifiées = source unique (planning + extras − pauses − annulées)
        const planned = await getGroupSessions(groupId, from, to);
        const sessionDateById = {};
        (sessionsRes.data || []).forEach(s => sessionDateById[s.id] = s.session_date);

        // Clés "member|date" présentes dans le système legacy
        const legacySet = new Set(
            (legacyRes.data || []).map(a => a.member_id + '|' + a.attendance_date)
        );

        // Présences niveau séance : member_id -> Set(session_date)
        const presDateByMember = {};
        (saRes.data || []).forEach(a => {
            if (a.status === 'ABSENT') return;
            const d = sessionDateById[a.session_id];
            if (!d) return;
            (presDateByMember[a.member_id] = presDateByMember[a.member_id] || new Set()).add(d);
        });
        const presentOn = (mid, d) =>
            (presDateByMember[mid] && presDateByMember[mid].has(d)) || legacySet.has(mid + '|' + d);

        // Date de réinscription par membre (source unique)
        const reinOf = {};
        (membersRes.data || []).forEach(m => reinOf[m.id] = m.start_date || null);
        (regsRes.data || []).forEach(r => {
            if (!reinOf[r.member_id] || r.start_date > reinOf[r.member_id]) reinOf[r.member_id] = r.start_date;
        });
        const startOfMembership = {};
        (gmRes.data || []).forEach(gm => {
            startOfMembership[gm.member_id] = gm.start_date;
        });

        const nameOf = {};
        (membersRes.data || []).forEach(m =>
            nameOf[m.id] = `${m.last_name} ${m.first_name}`);
        memberIds.sort((a, b) => (nameOf[a] || '').localeCompare(nameOf[b] || ''));

        const sessions = planned;
        const headers = ['Adhérent', ...sessions.map(s => fmtDateV2(s.session_date)), 'Présent', 'Absent'];

        const bodyRows = [];
        let html = `<table class="matrix-table"><thead><tr><th class="row-label">Adhérent</th>
            ${sessions.map(s => `<th>${fmtDateV2(s.session_date)}</th>`).join('')}<th>P</th><th>A</th></tr></thead><tbody>`;

        memberIds.forEach(mid => {
            const candidates = [from, reinOf[mid], startOfMembership[mid]].filter(Boolean).sort();
            const effStart = candidates.length ? candidates[candidates.length - 1] : from;
            let pCount = 0;
            const cells = sessions.map(s => {
                if (s.session_date < effStart) return '<td class="cell-extra">·</td>';
                if (presentOn(mid, s.session_date)) {
                    pCount++;
                    return `<td class="cell-p">P</td>`;
                }
                return '<td class="cell-a">A</td>';
            }).join('');
            const absent = sessions.filter(s => s.session_date >= effStart).length - pCount;
            html += `<tr><td class="row-label">${escapeHtmlV2(nameOf[mid] || mid)}</td>${cells}<td><b>${pCount}</b></td><td><b>${absent}</b></td></tr>`;
            bodyRows.push([nameOf[mid] || mid,
                ...sessions.map(s => (s.session_date < effStart) ? '·' : (presentOn(mid, s.session_date) ? 'P' : 'A')),
                pCount, absent]);
        });
        html += '</tbody></table>';

        document.getElementById('groupMatrixResult').innerHTML = `
            <h3 style="color:var(--primary-color)">🥊 ${escapeHtmlV2(groupRes.data?.name || '')}</h3>
            <div class="report-stats">
                <span class="stat-pill">Séances planifiées : <b>${sessions.length}</b></span>
                <span class="stat-pill">Adhérents : <b>${memberIds.length}</b></span>
            </div>
            <p style="color:var(--text-secondary);font-size:.8rem">« · » = avant la réinscription / l'affectation au groupe (non compté).</p>
            <div class="table-responsive">${html}</div>`;

        setLastReport('Rapport de groupe — ' + (groupRes.data?.name || ''), headers, bodyRows,
            [`Groupe : ${groupRes.data?.name || ''}`, `Période : ${fmtDateV2(from)} → ${fmtDateV2(to)}`, `Séances planifiées : ${sessions.length}`],
            [], null);
    } catch (err) {
        showMessage('reportsMessage', err.message, 'danger');
    }
}

/* ================= RAPPORT ABONNEMENTS ================= */

async function runSubscriptionReport() {
    const memberId = document.getElementById('srMember').value;
    const from = document.getElementById('srFrom').value;   // YYYY-MM
    const to = document.getElementById('srTo').value;       // YYYY-MM
    const clubId = v2GetActiveClubId();
    if (!from || !to || from > to) { alert('Période invalide'); return; }

    const months = [];
    let [y, m] = from.split('-').map(Number);
    const [ty, tm] = to.split('-').map(Number);
    while (y < ty || (y === ty && m <= tm)) {
        months.push(`${y}-${String(m).padStart(2, '0')}`);
        m++; if (m > 12) { m = 1; y++; }
        if (months.length > 24) break;
    }
    const monthLabel = (mm) => new Date(Number(mm.slice(0, 4)), Number(mm.slice(5, 7)) - 1, 1)
        .toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' });

    try {
        let members;
        if (memberId) {
            ({ data: members } = await supabase.from('members')
                .select('id, first_name, last_name, start_date, subscription')
                .eq('id', memberId));
        } else {
            ({ data: members } = await supabase.from('members')
                .select('id, first_name, last_name, start_date, subscription')
                .eq('club_id', clubId).order('last_name'));
        }
        members = members || [];

        const { data: pays } = await supabase.from('subscription_payments')
            .select('member_id, period_month, status, paid_on')
            .in('member_id', members.map(x => x.id))
            .in('period_month', months);

        const payMap = {};
        (pays || []).forEach(p => payMap[p.member_id + '|' + p.period_month] = p);

        // Fallback : aucun paiement enregistré → déduire les mois payés de la
        // date de début + durée d'abonnement (ancien système)
        let usedFallback = false;
        if (!pays || !pays.length) {
            usedFallback = true;
            members.forEach(mem => {
                if (!mem.start_date || !mem.subscription) return;
                const dur = { monthly: 1, quarterly: 3, biannual: 6, annual: 12 }[mem.subscription] || 1;
                const d = new Date(mem.start_date + 'T00:00:00');
                d.setDate(1);
                d.setMonth(d.getMonth() + dur - 1);
                const lastPaidMonth = d.toISOString().slice(0, 7);
                const startMonth = mem.start_date.slice(0, 7);
                months.forEach(mm => {
                    if (mm >= startMonth && mm <= lastPaidMonth) {
                        payMap[mem.id + '|' + mm] = {
                            member_id: mem.id, period_month: mm,
                            status: 'PAYE', paid_on: null
                        };
                    }
                });
            });
        }

        /* --- Mode individuel --- */
        if (memberId) {
            const mem = members[0];
            const rows = months.map(mm => {
                const p = payMap[mem.id + '|' + mm];
                return { month: mm, status: p?.status || 'NON PAYE', paidOn: p?.paid_on };
            });
            const paidCount = rows.filter(r => r.status === 'PAYE').length;

            document.getElementById('subscriptionReportResult').innerHTML = `
                <h3 style="color:var(--primary-color)">💳 ${escapeHtmlV2(mem.last_name)} ${escapeHtmlV2(mem.first_name)}</h3>
                ${usedFallback ? '<p style="color:var(--warning-color);font-size:.85rem">ℹ️ Aucun paiement enregistré — mois déduits de la date de début d\'abonnement.</p>' : ''}
                <div class="report-stats">
                    <span class="stat-pill">Mois payés : <b>${paidCount}</b></span>
                    <span class="stat-pill">Mois impayés : <b>${rows.length - paidCount}</b></span>
                </div>
                <table class="matrix-table">
                    <thead><tr><th>Mois</th><th>Statut</th><th>Date paiement</th></tr></thead>
                    <tbody>${rows.map(r => `
                        <tr><td class="row-label">${monthLabel(r.month)}</td>
                        <td class="${r.status === 'PAYE' ? 'cell-p' : 'cell-a'}">${r.status === 'PAYE' ? 'PAYÉ' : 'NON PAYÉ'}</td>
                        <td>${r.paidOn ? fmtDateV2(r.paidOn) : '-'}</td></tr>`).join('')}</tbody>
                </table>`;

            setLastReport('Rapport abonnement — ' + mem.last_name + ' ' + mem.first_name,
                ['Mois', 'Statut', 'Date paiement'],
                rows.map(r => [monthLabel(r.month), r.status === 'PAYE' ? 'PAYE' : 'NON PAYE', r.paidOn || '-']),
                [`Adhérent : ${mem.last_name} ${mem.first_name}`, `Période : ${monthLabel(from)} → ${monthLabel(to)}`],
                [['Mois payés', paidCount], ['Mois impayés', rows.length - paidCount]],
                null);
            return;
        }

        /* --- Mode global (matrice) --- */
        let html = `<table class="matrix-table"><thead><tr><th class="row-label">Adhérent</th>
            ${months.map(monthLabel).map(l => `<th>${l}</th>`).join('')}<th>Payés</th><th>Impayés</th></tr></thead><tbody>`;
        const gRows = [];
        members.forEach(mem => {
            let pc = 0;
            const cells = months.map(mm => {
                const p = payMap[mem.id + '|' + mm];
                const paid = p?.status === 'PAYE';
                if (paid) pc++;
                return `<td class="${paid ? 'cell-p' : 'cell-a'}">${paid ? 'PAYÉ' : '—'}</td>`;
            }).join('');
            html += `<tr><td class="row-label">${escapeHtmlV2(mem.last_name)} ${escapeHtmlV2(mem.first_name)}</td>${cells}<td><b>${pc}</b></td><td><b>${months.length - pc}</b></td></tr>`;
            gRows.push([`${mem.last_name} ${mem.first_name}`,
                ...months.map(mm => payMap[mem.id + '|' + mm]?.status === 'PAYE' ? 'PAYE' : 'NON PAYE'), pc, months.length - pc]);
        });
        html += '</tbody></table>';

        document.getElementById('subscriptionReportResult').innerHTML =
            `${usedFallback ? '<p style="color:var(--warning-color);font-size:.85rem">ℹ️ Aucun paiement enregistré — mois déduits des dates de début d\'abonnement.</p>' : ''}
             <div class="report-stats">
                <span class="stat-pill">Adhérents : <b>${members.length}</b></span>
                <span class="stat-pill">Période : <b>${monthLabel(from)} → ${monthLabel(to)}</b></span>
             </div>
             <div class="table-responsive">${html}</div>`;

        setLastReport('Rapport abonnements global',
            ['Adhérent', ...months.map(monthLabel), 'Payés', 'Impayés'], gRows,
            [`Période : ${monthLabel(from)} → ${monthLabel(to)}`, 'Tous les adhérents'], [], null);
    } catch (err) {
        showMessage('reportsMessage', err.message, 'danger');
    }
}

/* ================= RAPPORT ÉVÉNEMENTS & RECETTES ================= */

async function runEventsReport() {
    const from = document.getElementById('evFrom').value;
    const to = document.getElementById('evTo').value;
    const clubId = v2GetActiveClubId();
    if (!from || !to || from > to) { alert('Période invalide'); return; }

    try {
        // Événements du club actif + tous les événements généraux (inter-clubs).
        let evQ = supabase.from('events')
            .select('id, title, event_date, event_time, lieu, price, type, scope')
            .gte('event_date', from).lte('event_date', to)
            .order('event_date');
        if (clubId) evQ = evQ.or(`club_id.eq.${clubId},scope.eq.general`);
        const evRes = await evQ;
        const [evRes, ] = await Promise.all([
            supabase.from('events')
                .select('*')
                .eq('club_id', clubId)
                .gte('event_date', from).lte('event_date', to)
                .order('event_date')
        ]);

        const events = (evRes.data || []).map(v2NormalizeEvent);
        if (!events.length) {
            document.getElementById('eventsReportResult').innerHTML =
                '<p>Aucun événement sur cette période.</p>';
            return;
        }

        const { data: parts } = await supabase.from('event_participants')
            .select('id, event_id, member_id')
            .in('event_id', events.map(e => e.id));

        // Paiements réels des participants (dernier paiement = statut courant)
        const participantIds = (parts || []).map(p => p.id);
        const { data: payments } = participantIds.length
            ? await supabase.from('event_payments')
                .select('participant_id, status, amount, created_at')
                .in('participant_id', participantIds)
                .order('created_at')
            : { data: [] };

        const lastPay = {};
        (payments || []).forEach(p => { lastPay[p.participant_id] = p; });
        const eventById = {};
        events.forEach(e => eventById[e.id] = e);

        const countByEvent = {};
        const paidByEvent = {};
        const revenueByEvent = {};
        const membersByEvent = {};
        (parts || []).forEach(p => {
            countByEvent[p.event_id] = (countByEvent[p.event_id] || 0) + 1;
            (membersByEvent[p.event_id] = membersByEvent[p.event_id] || []).push({ pid: p.id, mid: p.member_id });
            const pay = lastPay[p.id];
            if (pay?.status === 'PAYE') {
                paidByEvent[p.event_id] = (paidByEvent[p.event_id] || 0) + 1;
                revenueByEvent[p.event_id] = (revenueByEvent[p.event_id] || 0) +
                    Number(pay.amount ?? eventById[p.event_id]?.price ?? 0);
            }
        });

        // Noms des participants
        const allMemberIds = [...new Set((parts || []).map(p => p.member_id))];
        let nameOf = {};
        if (allMemberIds.length) {
            const { data: mems } = await supabase.from('members')
                .select('id, first_name, last_name').in('id', allMemberIds);
            (mems || []).forEach(m => nameOf[m.id] = m.last_name + ' ' + m.first_name);
        }

        const typeLabel = { stage: 'Stage', competition: 'Compétition', exam: 'Examen', other: 'Autre' };
        let totalParticipants = 0;
        let totalPaid = 0;
        let totalRevenue = 0;

        const rows = [];
        let html = `<table class="matrix-table"><thead><tr>
            <th class="row-label">Événement</th><th>Date</th><th>Type</th><th>Lieu</th>
            <th>Prix</th><th>Participants</th><th>Payés</th><th>Recette</th></tr></thead><tbody>`;

        events.forEach(ev => {
            const n = countByEvent[ev.id] || 0;
            const paid = paidByEvent[ev.id] || 0;
            const revenue = revenueByEvent[ev.id] || 0;
            totalParticipants += n;
            totalPaid += paid;
            totalRevenue += revenue;
            html += `<tr><td class="row-label">${escapeHtmlV2(ev.title)}</td>
                <td>${fmtDateV2(ev.event_date)}${ev.event_time ? ' ' + ev.event_time.slice(0,5) : ''}</td>
                <td>${typeLabel[ev.type] || ev.type || '-'}</td>
                <td>${escapeHtmlV2(ev.lieu || '-')}</td>
                <td>${ev.price || 0} DA</td>
                <td><b>${n}</b></td>
                <td><b>${paid}</b></td>
                <td class="cell-p"><b>${revenue.toLocaleString('fr-FR')} DA</b></td></tr>`;
            rows.push([ev.title,
                fmtDateV2(ev.event_date) + (ev.event_time ? ' ' + ev.event_time.slice(0, 5) : ''),
                typeLabel[ev.type] || ev.type || '-', ev.lieu || '-',
                (ev.price || 0) + ' DA', n, paid, revenue.toLocaleString('fr-FR') + ' DA']);
        });
        html += `</tbody></table>
            <div class="report-stats" style="margin-top:10px">
                <span class="stat-pill">Événements : <b>${events.length}</b></span>
                <span class="stat-pill">Participations : <b>${totalParticipants}</b></span>
                <span class="stat-pill">Payés : <b>${totalPaid}</b></span>
                <span class="stat-pill">Recette totale : <b>${totalRevenue.toLocaleString('fr-FR')} DA</b></span>
            </div>`;

        // Détail des participants par événement (pour le PDF)
        const detail = events.map(ev => {
            const names = (membersByEvent[ev.id] || []).map(({ pid, mid }) => {
                const paid = lastPay[pid]?.status === 'PAYE';
                return (nameOf[mid] || mid) + (paid ? ' ✅' : ' ❌');
            }).sort();
            return `<h4 style="margin:10px 0 4px">${escapeHtmlV2(ev.title)} — ${fmtDateV2(ev.event_date)} (${names.length} participant(s))</h4>
                <p style="font-size:12px">${names.length ? escapeHtmlV2(names.join(', ')) : '<i>Aucun participant</i>'}</p>`;
        }).join('');

        document.getElementById('eventsReportResult').innerHTML =
            `<h3 style="color:var(--primary-color)">💰 Période ${fmtDateV2(from)} → ${fmtDateV2(to)}</h3>` + html;

        setLastReport('Rapport événements & recettes',
            ['Événement', 'Date', 'Type', 'Lieu', 'Prix', 'Participants', 'Payés', 'Recette'], rows,
            ['Période : ' + fmtDateV2(from) + ' → ' + fmtDateV2(to)],
            [['Événements', events.length], ['Participations', totalParticipants],
             ['Payés', totalPaid], ['Recette totale', totalRevenue.toLocaleString('fr-FR') + ' DA']],
            detail);
    } catch (err) {
        showMessage('reportsMessage', err.message, 'danger');
    }
}

/* ================= RAPPORT DE PAIEMENT — ÉVÉNEMENTS ================= */

async function runEventPaymentsReport() {
    const from = document.getElementById('payFrom').value;
    const to = document.getElementById('payTo').value;
    const eventFilter = document.getElementById('payEvent')?.value || '';

    const isAdmin = v2IsAdmin();
    const payClubSel = document.getElementById('payClub');
    // Mode global : admin + « Tous les clubs » sélectionné.
    const globalScope = isAdmin && payClubSel && !payClubSel.value;
    const scopeClubId = globalScope ? null
        : (isAdmin ? (payClubSel?.value || v2GetActiveClubId()) : v2GetActiveClubId());

    if (!from || !to || from > to) { alert('Période invalide'); return; }
    if (!globalScope && !scopeClubId) {
        showMessage('reportsMessage', 'Aucun club sélectionné.', 'danger');
        return;
    }

    const scopeLabel = globalScope ? 'Tous les clubs'
        : (isAdmin && payClubSel?.selectedOptions?.[0]
            ? payClubSel.selectedOptions[0].textContent
            : (currentClub?.name || ''));

    try {
        let evQuery = supabase.from('events').select('*').order('event_date');
        if (!globalScope) evQuery = evQuery.eq('club_id', scopeClubId);
        const { data: evData, error: evErr } = await evQuery;
        if (evErr) throw evErr;

        const events = (evData || []).map(v2NormalizeEvent);
        const eventById = {};
        events.forEach(ev => eventById[ev.id] = ev);

        // Noms des clubs (utile en mode global).
        const clubNameOf = {};
        (window.v2AdminClubs || []).forEach(c => clubNameOf[c.id] = c.name);
        const missingClubIds = [...new Set(events.map(ev => ev.club_id))]
            .filter(id => id && !clubNameOf[id]);
        if (missingClubIds.length) {
            const { data: clubs } = await supabase.from('clubs')
                .select('id, name').in('id', missingClubIds);
            (clubs || []).forEach(c => clubNameOf[c.id] = c.name);
        }

        // Participants rattachés aux événements (indépendant de
        // event_participants.club_id qui peut être null sur d'anciennes lignes).
        const eventIds = Object.keys(eventById);
        const { data: partData, error: partsErr } = eventIds.length
            ? await supabase.from('event_participants')
                .select('id, event_id, member_id')
                .in('event_id', eventIds)
            : { data: [], error: null };
        if (partsErr) throw partsErr;

        let parts = partData || [];
        if (eventFilter) parts = parts.filter(p => p.event_id === eventFilter);

        const participantIds = parts.map(p => p.id);
        const { data: payments, error: payErr } = participantIds.length
            ? await supabase.from('event_payments')
                .select('participant_id, status, amount, paid_on, created_at, changed_by')
                .in('participant_id', participantIds)
                .order('created_at')
            : { data: [], error: null };
        if (payErr) throw payErr;

        // Dernier paiement = statut courant du participant.
        const lastPay = {};
        (payments || []).forEach(p => { lastPay[p.participant_id] = p; });

        const paidParts = parts.filter(p => {
            const pay = lastPay[p.id];
            return pay && pay.status === 'PAYE' &&
                pay.paid_on && pay.paid_on >= from && pay.paid_on <= to;
        });

        const memberIds = [...new Set(paidParts.map(p => p.member_id))];
        const nameOf = {};
        if (memberIds.length) {
            const { data: mems } = await supabase.from('members')
                .select('id, first_name, last_name').in('id', memberIds);
            (mems || []).forEach(m => nameOf[m.id] = m.last_name + ' ' + m.first_name);
        }

        const lines = paidParts.map(p => {
            const pay = lastPay[p.id];
            const ev = eventById[p.event_id];
            return {
                paid_on: pay.paid_on,
                event: ev ? ev.title : '—',
                event_date: ev ? ev.event_date : null,
                event_id: p.event_id,
                club_id: ev ? ev.club_id : null,
                club: ev ? (clubNameOf[ev.club_id] || '—') : '—',
                member_id: p.member_id,
                member: nameOf[p.member_id] || p.member_id,
                amount: Number(pay.amount ?? ev?.price ?? 0),
                by: pay.changed_by || '—'
            };
        }).sort((a, b) =>
            (b.paid_on || '').localeCompare(a.paid_on || '') ||
            (globalScope ? a.club.localeCompare(b.club) : 0) ||
            a.member.localeCompare(b.member));

        const totalAmount = lines.reduce((s, l) => s + l.amount, 0);
        const eventsCount = new Set(paidParts.map(p => p.event_id)).size;
        const membersCount = new Set(paidParts.map(p => p.member_id)).size;
        const clubsCount = new Set(lines.map(l => l.club_id).filter(Boolean)).size;

        if (!lines.length) {
            document.getElementById('eventPaymentsResult').innerHTML =
                `<p style="color:var(--text-secondary);margin-top:10px;">
                    Aucun paiement encaissé sur la période sélectionnée${globalScope ? ' (tous les clubs)' : ''}.</p>`;
            return;
        }

        const columns = ['Date paiement'];
        if (globalScope) columns.push('Club');
        columns.push('Événement', 'Adhérent', 'Montant', 'Encaissé par');

        const rows = lines.map(l => {
            const row = [fmtDateV2(l.paid_on)];
            if (globalScope) row.push(l.club);
            row.push(l.event, l.member, l.amount.toLocaleString('fr-FR') + ' DA', l.by);
            return row;
        });

        let html = `<table class="matrix-table"><thead><tr>
            <th>Date paiement</th>${globalScope ? '<th>Club</th>' : ''}
            <th class="row-label">Événement</th><th>Adhérent</th>
            <th>Montant</th><th>Encaissé par</th></tr></thead><tbody>`;
        html += lines.map(l => `<tr>
            <td>${fmtDateV2(l.paid_on)}</td>
            ${globalScope ? `<td>${escapeHtmlV2(l.club)}</td>` : ''}
            <td class="row-label">${escapeHtmlV2(l.event)}</td>
            <td>${escapeHtmlV2(l.member)}</td>
            <td class="cell-p"><b>${l.amount.toLocaleString('fr-FR')} DA</b></td>
            <td>${escapeHtmlV2(l.by)}</td>
        </tr>`).join('');
        html += `</tbody></table>`;

        // Mode global : synthèse par club puis total général.
        if (globalScope) {
            const byClub = {};
            lines.forEach(l => {
                const key = l.club_id || '—';
                const row = byClub[key] = byClub[key] || {
                    club: l.club, payments: 0,
                    members: new Set(), events: new Set(), amount: 0
                };
                row.payments++;
                row.members.add(l.member_id);
                row.events.add(l.event_id);
                row.amount += l.amount;
            });

            html += `<h4 style="margin:16px 0 8px;">🏟️ Totaux par club</h4>
                <table class="matrix-table"><thead><tr>
                    <th class="row-label">Club</th><th>Paiements</th><th>Adhérents</th>
                    <th>Événements</th><th>Total encaissé</th></tr></thead><tbody>`;
            Object.values(byClub)
                .sort((a, b) => b.amount - a.amount)
                .forEach(r => {
                    html += `<tr>
                        <td class="row-label">${escapeHtmlV2(r.club)}</td>
                        <td>${r.payments}</td><td>${r.members.size}</td><td>${r.events.size}</td>
                        <td class="cell-p"><b>${r.amount.toLocaleString('fr-FR')} DA</b></td>
                    </tr>`;
                });
            html += `<tr><td class="row-label"><b>TOTAL GÉNÉRAL</b></td>
                <td><b>${lines.length}</b></td><td><b>${membersCount}</b></td>
                <td><b>${eventsCount}</b></td>
                <td class="cell-p"><b>${totalAmount.toLocaleString('fr-FR')} DA</b></td></tr>
                </tbody></table>`;
        }

        html += `<div class="report-stats" style="margin-top:10px">
                <span class="stat-pill">Paiements : <b>${lines.length}</b></span>
                <span class="stat-pill">Adhérents : <b>${membersCount}</b></span>
                <span class="stat-pill">Événements : <b>${eventsCount}</b></span>
                ${globalScope ? `<span class="stat-pill">Clubs : <b>${clubsCount}</b></span>` : ''}
                <span class="stat-pill">Total encaissé : <b>${totalAmount.toLocaleString('fr-FR')} DA</b></span>
            </div>`;

        document.getElementById('eventPaymentsResult').innerHTML =
            `<h3 style="color:var(--primary-color)">🧾 Paiements — ${escapeHtmlV2(scopeLabel)} — ${fmtDateV2(from)} → ${fmtDateV2(to)}</h3>` + html;

        const stats = [['Paiements', lines.length], ['Adhérents', membersCount],
            ['Événements', eventsCount]];
        if (globalScope) stats.push(['Clubs', clubsCount]);
        stats.push(['Total encaissé', totalAmount.toLocaleString('fr-FR') + ' DA']);

        setLastReport('Rapport de paiement — événements',
            columns, rows,
            ['Période : ' + fmtDateV2(from) + ' → ' + fmtDateV2(to),
             'Portée : ' + scopeLabel,
             eventFilter ? 'Événement : ' + (eventById[eventFilter]?.title || '—') : 'Tous les événements'],
            stats);
    } catch (err) {
        showMessage('reportsMessage', err.message, 'danger');
    }
}

/* Ouvre la section Rapports et génère directement le rapport de paiement. */
function openEventPaymentsReport() {
    const navBtn = [...document.querySelectorAll('#navTabs .nav-tab')]
        .find(b => b.dataset.section === 'reportsSection');
    if (navBtn) navBtn.click();

    Promise.resolve(initReports())
        .then(() => {
            document.getElementById('payFrom')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return runEventPaymentsReport();
        })
        .catch(err => console.error(err));
}

/* ================= RAPPORT ÉTAT DES ADHÉRENTS ================= */

async function runMembersReport() {
    const clubId = v2GetActiveClubId();

    try {
        const [membersRes, groupsRes, statusRes, gmRes] = await Promise.all([
            supabase.from('members')
                .select('id, first_name, last_name, dob, phone_number, start_date, created_at')
                .eq('club_id', clubId).order('last_name'),
            supabase.from('groups').select('id, name').eq('club_id', clubId),
            supabase.from('member_subscription_status')
                .select('member_id, end_effective, is_active, days_left'),
            supabase.from('group_members').select('member_id, group_id').is('end_date', null)
        ]);

        const members = (membersRes.data || []);
        const groupNameOf = {};
        (groupsRes.data || []).forEach(g => groupNameOf[g.id] = g.name);
        const statusOf = {};
        (statusRes.data || []).forEach(s => statusOf[s.member_id] = s);
        const groupOfMember = {};
        (gmRes.data || []).forEach(gm => { groupOfMember[gm.member_id] = gm.group_id; });

        let activeCount = 0, expiredCount = 0;
        const headers = ['ID', 'Nom', 'Prénom', 'Téléphone', 'Groupe', 'Début abonnement', 'Fin effective', 'Statut'];
        const bodyRows = [];

        let html = `<table class="matrix-table"><thead><tr>
            <th>ID</th><th class="row-label">Nom complet</th><th>Téléphone</th><th>Groupe</th>
            <th>Début</th><th>Fin effective</th><th>Statut</th></tr></thead><tbody>`;

        members.forEach(m => {
            const st = statusOf[m.id] || {};
            const active = !!st.is_active;
            if (active) activeCount++; else expiredCount++;
            const grp = groupOfMember[m.id] ? (groupNameOf[groupOfMember[m.id]] || '-') : 'Sans groupe';
            html += `<tr>
                <td>${escapeHtmlV2(m.member_id || m.mid)}</td>
                <td class="row-label">${escapeHtmlV2(m.last_name)} ${escapeHtmlV2(m.first_name)}</td>
                <td>${escapeHtmlV2(m.phone_number || '-')}</td>
                <td>${escapeHtmlV2(grp)}</td>
                <td>${m.start_date ? fmtDateV2(m.start_date) : '-'}</td>
                <td>${st.end_effective ? fmtDateV2(st.end_effective) : '-'}</td>
                <td class="${active ? 'cell-p' : 'cell-a'}"><b>${active ? 'ACTIF' : 'EXPIRÉ'}</b></td>
            </tr>`;
            bodyRows.push([m.member_id || m.mid, m.last_name + ' ' + m.first_name,
                m.phone_number || '-', grp,
                m.start_date ? fmtDateV2(m.start_date) : '-',
                st.end_effective ? fmtDateV2(st.end_effective) : '-',
                active ? 'ACTIF' : 'EXPIRE']);
        });
        html += '</tbody></table>';

        document.getElementById('membersReportResult').innerHTML = `
            <div class="report-stats" style="margin-bottom:10px">
                <span class="stat-pill">Total : <b>${members.length}</b></span>
                <span class="stat-pill">Actifs : <b>${activeCount}</b></span>
                <span class="stat-pill">Expirés : <b>${expiredCount}</b></span>
            </div>
            <div class="table-responsive">${html}</div>`;

        setLastReport("Rapport d'état des adhérents", headers, bodyRows,
            ['Total : ' + members.length, 'Actifs : ' + activeCount, 'Expirés : ' + expiredCount],
            [['Total', members.length], ['Actifs', activeCount], ['Expirés', expiredCount]],
            null);
    } catch (err) {
        showMessage('reportsMessage', err.message, 'danger');
    }
}

/* ================= EXPORTS COMMUNS ================= */

function setLastReport(title, headers, rows, metaLines, summaryRows, detailHtml) {
    v2LastReport = { title, headers, rows, metaLines, summaryRows, detailHtml };
}

function exportReportCSV() {
    if (!v2LastReport) { alert('Générez d\'abord un rapport.'); return; }
    const { title, headers, rows } = v2LastReport;
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [title, '', ...headers.map(esc).join(';')];
    rows.forEach(r => lines.push(r.map(esc).join(';')));
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = title.replace(/[^\w\-À-ÿ ]+/g, '').replace(/\s+/g, '_') + '.csv';
    a.click();
    URL.revokeObjectURL(a.href);
}

function exportReportPDF() {
    if (!v2LastReport) { alert('Générez d\'abord un rapport.'); return; }
    const { title, metaLines, summaryRows } = v2LastReport;

    let area = document.getElementById('printArea');
    if (!area) {
        area = document.createElement('div');
        area.id = 'printArea';
        area.className = 'hidden';
        document.body.appendChild(area);
    }

    const logoUrl = (currentClub && currentClub !== 'admin') ? currentClub.logo : '';
    area.innerHTML = `
        <div style="display:flex;align-items:center;gap:15px;border-bottom:3px solid #c8102e;padding-bottom:12px;margin-bottom:16px">
            ${logoUrl ? `<img src="${logoUrl}" style="height:64px" alt="">` : ''}
            <div>
                <div style="font-size:20px;font-weight:800;color:#c8102e">KYOKUSHIN MANAGER PRO</div>
                <div style="font-size:16px;font-weight:700">${escapeHtmlV2(title)}</div>
                ${currentClub && currentClub !== 'admin' ? `<div>Club : ${escapeHtmlV2(currentClub.name)}</div>` : ''}
            </div>
        </div>
        <div style="margin-bottom:10px;font-size:13px">
            ${metaLines.map(l => escapeHtmlV2(l)).join('<br>')}
        </div>
        <div style="margin-bottom:10px;font-size:12px;color:#555">
            Généré le ${new Date().toLocaleString('fr-FR')} par ${escapeHtmlV2(currentUser || '')}
        </div>
        ${summaryRows && summaryRows.length ? `<div style="margin:10px 0;font-size:14px">
            ${summaryRows.map(([k, v]) => `<b>${escapeHtmlV2(k)} :</b> ${escapeHtmlV2(v)}`).join(' &nbsp;|&nbsp; ')}
        </div>` : ''}
        ${v2LastReport.detailHtml ||
          `<table><thead><tr>${v2LastReport.headers.map(h => `<th>${escapeHtmlV2(h)}</th>`).join('')}</tr></thead>
           <tbody>${v2LastReport.rows.map(r => `<tr>${r.map(c => `<td>${escapeHtmlV2(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`}
        <div style="margin-top:18px;font-size:11px;color:#777;text-align:center;border-top:1px solid #ccc;padding-top:6px">
            Kyokushin Manager Pro — Document généré automatiquement
        </div>`;
    area.classList.remove('hidden');
    window.print();
    setTimeout(() => area.classList.add('hidden'), 400);
}
