// ============================================
// MODULE RAPPORTS V2
// Présence individuel / matrice groupe / abonnements
// Export CSV (UTF-8 Excel FR) + PDF (impression)
// ============================================

let v2LastReport = null;

async function initReports() {
    if (currentClub === 'admin') await v2PopulateAdminClubSelect('reportsToolbar');
    const clubId = v2GetActiveClubId();
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

        const today = new Date().toISOString().slice(0, 10);
        const firstOfMonth = today.slice(0, 8) + '01';
        document.getElementById('repFrom').value = firstOfMonth;
        document.getElementById('repTo').value = today;
        document.getElementById('srFrom').value = today.slice(0, 4) + '-01';
        document.getElementById('srTo').value = today.slice(0, 7);
        document.getElementById('evFrom').value = firstOfMonth;
        document.getElementById('evTo').value = today;
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
        const [evRes, ] = await Promise.all([
            supabase.from('events')
                .select('id, title, event_date, event_time, lieu, price, type')
                .eq('club_id', clubId)
                .gte('event_date', from).lte('event_date', to)
                .order('event_date')
        ]);

        const events = evRes.data || [];
        if (!events.length) {
            document.getElementById('eventsReportResult').innerHTML =
                '<p>Aucun événement sur cette période.</p>';
            return;
        }

        const { data: parts } = await supabase.from('event_participants')
            .select('event_id, member_id')
            .in('event_id', events.map(e => e.id));

        const countByEvent = {};
        const membersByEvent = {};
        (parts || []).forEach(p => {
            countByEvent[p.event_id] = (countByEvent[p.event_id] || 0) + 1;
            (membersByEvent[p.event_id] = membersByEvent[p.event_id] || []).push(p.member_id);
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
        let totalRevenue = 0;

        const rows = [];
        let html = `<table class="matrix-table"><thead><tr>
            <th class="row-label">Événement</th><th>Date</th><th>Type</th><th>Lieu</th>
            <th>Prix</th><th>Participants</th><th>Recette</th></tr></thead><tbody>`;

        events.forEach(ev => {
            const n = countByEvent[ev.id] || 0;
            const revenue = n * (ev.price || 0);
            totalParticipants += n;
            totalRevenue += revenue;
            html += `<tr><td class="row-label">${escapeHtmlV2(ev.title)}</td>
                <td>${fmtDateV2(ev.event_date)}${ev.event_time ? ' ' + ev.event_time.slice(0,5) : ''}</td>
                <td>${typeLabel[ev.type] || ev.type || '-'}</td>
                <td>${escapeHtmlV2(ev.lieu || '-')}</td>
                <td>${ev.price || 0} DA</td>
                <td><b>${n}</b></td>
                <td class="cell-p"><b>${revenue} DA</b></td></tr>`;
            rows.push([ev.title,
                fmtDateV2(ev.event_date) + (ev.event_time ? ' ' + ev.event_time.slice(0, 5) : ''),
                typeLabel[ev.type] || ev.type || '-', ev.lieu || '-',
                (ev.price || 0) + ' DA', n, revenue + ' DA']);
        });
        html += `</tbody></table>
            <div class="report-stats" style="margin-top:10px">
                <span class="stat-pill">Événements : <b>${events.length}</b></span>
                <span class="stat-pill">Participations : <b>${totalParticipants}</b></span>
                <span class="stat-pill">Recette totale : <b>${totalRevenue} DA</b></span>
            </div>`;

        // Détail des participants par événement (pour le PDF)
        const detail = events.map(ev => {
            const names = (membersByEvent[ev.id] || []).map(id => nameOf[id] || id).sort();
            return `<h4 style="margin:10px 0 4px">${escapeHtmlV2(ev.title)} — ${fmtDateV2(ev.event_date)} (${names.length} participant(s))</h4>
                <p style="font-size:12px">${names.length ? escapeHtmlV2(names.join(', ')) : '<i>Aucun participant</i>'}</p>`;
        }).join('');

        document.getElementById('eventsReportResult').innerHTML =
            `<h3 style="color:var(--primary-color)">💰 Période ${fmtDateV2(from)} → ${fmtDateV2(to)}</h3>` + html;

        setLastReport('Rapport événements & recettes',
            ['Événement', 'Date', 'Type', 'Lieu', 'Prix', 'Participants', 'Recette'], rows,
            ['Période : ' + fmtDateV2(from) + ' → ' + fmtDateV2(to)],
            [['Événements', events.length], ['Participations', totalParticipants], ['Recette totale', totalRevenue + ' DA']],
            detail);
    } catch (err) {
        showMessage('reportsMessage', err.message, 'danger');
    }
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
