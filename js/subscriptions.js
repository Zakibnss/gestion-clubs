// ============================================
// MODULE ABONNEMENTS MENSUELS — V2
// Règle de continuité : la période commence à la fin
// théorique de la période précédente (gérée par la DB :
// effective_subscription_end / vue member_subscription_status)
// ============================================

let v2SubMembersCache = [];

async function loadSubscriptions() {
    if (currentClub === 'admin') await v2PopulateAdminClubSelect('subsToolbar');
    const clubId = v2GetActiveClubId();
    if (!clubId) return;

    try {
        const [membersRes, statusRes] = await Promise.all([
            supabase.from('members')
                .select('id, first_name, last_name, start_date, subscription')
                .eq('club_id', clubId)
                .order('last_name'),
            supabase.from('member_subscription_status')
                .select('member_id, end_effective, is_active, days_left')
        ]);

        const statusMap = {};
        (statusRes.data || []).forEach(s => statusMap[s.member_id] = s);
        v2SubMembersCache = (membersRes.data || []);

        const list = document.getElementById('subscriptionsList');
        list.innerHTML = v2SubMembersCache.map(m => {
            const st = statusMap[m.id] || {};
            const active = !!st.is_active;
            const daysLeft = st.days_left;
            return `
            <div class="member-sub-row">
                <div class="grow">
                    <b>${escapeHtmlV2(m.last_name)}</b> ${escapeHtmlV2(m.first_name)}
                    <span class="badge ${active ? 'badge-success' : 'badge-danger'}" style="margin-left:8px">
                        ${active ? 'ACTIF' : 'EXPIRÉ'}
                    </span>
                </div>
                <div class="sub-end-date">
                    Fin effective : <b>${st.end_effective ? fmtDateV2(st.end_effective) : '—'}</b>
                    ${typeof daysLeft === 'number' ? ` (${daysLeft} j)` : ''}
                </div>
                <button class="btn btn-primary btn-sm" onclick="openMemberMonths('${m.id}')">💳 Gérer les mois</button>
            </div>`;
        }).join('') || '<p>Aucun adhérent.</p>';
    } catch (err) {
        showMessage('subscriptionsMessage', 'Erreur: ' + err.message, 'danger');
    }
}

async function openMemberMonths(memberId) {
    const member = v2SubMembersCache.find(m => m.id === memberId);
    if (!member) return;

    document.getElementById('monthsModalTitle').textContent =
        `💳 Abonnement — ${member.last_name} ${member.first_name}`;
    document.getElementById('memberMonthsGrid').innerHTML = '<div class="spinner"></div>';
    document.getElementById('monthsSummary').textContent = '';
    openModal('monthsModal');

    const startMonth = (member.start_date || new Date().toISOString().slice(0, 10)).slice(0, 7);
    const nowMonth = new Date().toISOString().slice(0, 7);

    // Fenêtre : du mois de début au mois courant (+11 mois pour prépaiement)
    const months = [];
    let [y, mo] = startMonth.split('-').map(Number);
    const [cy, cm] = nowMonth.split('-').map(Number);
    while (y < cy + 1 || (y === cy + 1 && mo <= cm)) {
        months.push(`${y}-${String(mo).padStart(2, '0')}`);
        mo++; if (mo > 12) { mo = 1; y++; }
        if (months.length > 36) break;
    }

    const { data: payments, error } = await supabase
        .from('subscription_payments')
        .select('period_month, status, paid_on')
        .eq('member_id', memberId)
        .in('period_month', months);
    if (error) { alert(error.message); return; }

    const payMap = {};
    (payments || []).forEach(p => payMap[p.period_month] = p);

    // Fallback : si aucun paiement enregistré (ancien système), un mois est
    // considéré payé s'il est couvert par la période start_date + durée.
    // Après expiration/réactivation, start_date avance (règle de continuité),
    // donc seuls les mois réellement non couverts apparaissent impayés.
    let legacyLast = null;
    if (member.start_date && member.subscription) {
        const dur = { monthly: 1, quarterly: 3, biannual: 6, annual: 12 }[member.subscription] || 1;
        const d = new Date(member.start_date + 'T00:00:00');
        d.setDate(1);
        d.setMonth(d.getMonth() + dur - 1);
        legacyLast = d.toISOString().slice(0, 7);
    }
    const startMonthOfMember = (member.start_date || '').slice(0, 7);

    // Un mois est-il payé ? (paiement enregistré OU couvert par la période)
    function isMonthPaid(m) {
        const p = payMap[m];
        if (p && p.status === 'PAYE') return true;
        return !!(legacyLast && startMonthOfMember &&
                  m >= startMonthOfMember && m <= legacyLast);
    }

    const grid = document.getElementById('memberMonthsGrid');
    grid.className = 'sub-month-grid';
    grid.innerHTML = months.map(m => {
        const p = payMap[m];
        const paid = isMonthPaid(m);
        const legacyOnly = paid && !(p && p.status === 'PAYE');
        const [yy, mm] = m.split('-');
        const label = new Date(Number(yy), Number(mm) - 1, 1)
            .toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
        return `
        <div class="month-cell ${paid ? 'paid' : 'unpaid'}"
             onclick="togglePayment('${memberId}', '${m}', '${paid ? 'PAYE' : 'NON PAYE'}')"
             title="Cliquer pour basculer">
            <span class="month-name">${label}</span>
            <span class="month-state">${paid ? '✔ PAYÉ' : '✘ NON PAYÉ'}</span>
            ${p && p.paid_on ? `<span class="month-paid-on">le ${fmtDateV2(p.paid_on)}</span>`
                : legacyOnly ? '<span class="month-paid-on">période initiale</span>' : ''}
        </div>`;
    }).join('');

    const paidCount = months.filter(isMonthPaid).length;
    document.getElementById('monthsSummary').innerHTML =
        `<span class="stat-pill">Mois payés : <b>${paidCount}</b></span>
         <span class="stat-pill">Mois impayés : <b>${months.length - paidCount}</b></span>`;
}

async function togglePayment(memberId, periodMonth, currentState) {
    const nowPaid = currentState === 'PAYE';
    const payload = {
        club_id: v2GetActiveClubId(),
        member_id: memberId,
        period_month: periodMonth,
        previous_status: currentState,
        changed_by: currentUser || 'system',
        status: nowPaid ? 'NON PAYE' : 'PAYE',
        paid_on: nowPaid ? null : new Date().toISOString().slice(0, 10)
    };

    const { error } = await supabase
        .from('subscription_payments')
        .upsert(payload, { onConflict: 'member_id,period_month' });

    if (error) { alert('Erreur: ' + error.message); return; }
    openMemberMonths(memberId);
}
