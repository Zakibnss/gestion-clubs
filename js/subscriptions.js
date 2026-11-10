// ============================================
// MODULE ABONNEMENTS MENSUELS — V2
//
// La fin effective est calculée à partir des MOIS PAYÉS
// (subscription_payments) via js/subscription-core.js :
// chaque mois payé prolonge l'abonnement d'un mois, à
// partir du jour du début d'abonnement.
//
// La vue SQL member_subscription_status applique la même
// règle (migration 016). Le calcul client rend la section
// Abonnements correcte même si la migration n'a pas encore
// été exécutée.
// ============================================

let v2SubMembersCache = [];

async function loadSubscriptions() {
    if (currentClub === 'admin') await v2PopulateAdminClubSelect('subsToolbar');
    const clubId = v2GetActiveClubId();
    if (!clubId) return;

    try {
        const [membersRes, statusRes, paymentsRes] = await Promise.all([
            supabase.from('members')
                .select('id, first_name, last_name, start_date, subscription')
                .eq('club_id', clubId)
                .order('last_name'),
            supabase.from('member_subscription_status')
                .select('member_id, end_effective, is_active, days_left'),
            supabase.from('subscription_payments')
                .select('member_id, period_month, status')
                .eq('club_id', clubId)
        ]);

        if (membersRes.error) throw membersRes.error;

        const statusMap = {};
        (statusRes.data || []).forEach(s => statusMap[s.member_id] = s);
        // Si la table des paiements est inaccessible, on retombe simplement
        // sur les valeurs de la vue SQL (pas de blocage de la liste).
        const paymentsByMember = paymentsRes.error
            ? {}
            : v2GroupPaymentsByMember(paymentsRes.data);
        v2SubMembersCache = (membersRes.data || []);

        const list = document.getElementById('subscriptionsList');
        list.innerHTML = v2SubMembersCache.map(m => {
            const st = statusMap[m.id] || {};
            const memberPayments = paymentsByMember[m.id] || [];
            // Dès qu'un paiement existe, le calcul à partir des mois payés est
            // prioritaire : il reflète immédiatement les mois cochés dans la
            // modale. Sinon on garde les valeurs de la vue SQL (qui tient
            // compte d'une éventuelle fin d'inscription explicite).
            const computed = v2ComputeSubscriptionState(m, memberPayments);
            const useComputed = memberPayments.length > 0 && computed;
            const endKey = useComputed ? computed.endKey : st.end_effective;
            const active = useComputed ? computed.isActive : !!st.is_active;
            const daysLeft = useComputed ? computed.daysLeft : st.days_left;
            return `
            <div class="member-sub-row">
                <div class="grow">
                    <b>${escapeHtmlV2(m.last_name)}</b> ${escapeHtmlV2(m.first_name)}
                    <span class="badge ${active ? 'badge-success' : 'badge-danger'}" style="margin-left:8px">
                        ${active ? 'ACTIF' : 'EXPIRÉ'}
                    </span>
                </div>
                <div class="sub-end-date">
                    Fin effective : <b>${endKey ? fmtDateV2(endKey) : '—'}</b>
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

    const today = new Date();
    const startMonth = (member.start_date ||
        v2DateKey(new Date(today.getFullYear(), today.getMonth(), 1))).slice(0, 7);

    // Fenêtre : du début de la SAISON (septembre) au mois courant + 11 mois
    // pour le prépaiement. Les mois antérieurs à la date de début d'abonnement
    // ne sont affichés que s'ils existent comme PAYÉ dans la base
    // (règle : renouvellement → septembre jusqu'au mois du renouvellement).
    let [sy, sm] = startMonth.split('-').map(Number);
    let start = new Date(sm >= 9 ? sy : sy - 1, 8, 1); // 1er septembre de la saison

    // Ne pas afficher un historique démesuré (36 mois maxi) et gérer un
    // adhérent dont la date de début serait postérieure à la saison en cours.
    const minHistory = new Date(today.getFullYear(), today.getMonth() - 23, 1);
    if (start < minHistory) start = minHistory;
    const memberStart = new Date(sy, sm - 1, 1);
    if (memberStart > start) start = memberStart;

    let end = new Date(today.getFullYear(), today.getMonth() + 11, 1);
    const startPlus11 = new Date(start.getFullYear(), start.getMonth() + 11, 1);
    if (startPlus11 > end) end = startPlus11;

    const months = [];
    let y = start.getFullYear();
    let mo = start.getMonth() + 1;
    while (y < end.getFullYear() || (y === end.getFullYear() && mo <= end.getMonth() + 1)) {
        months.push(`${y}-${String(mo).padStart(2, '0')}`);
        mo++; if (mo > 12) { mo = 1; y++; }
        if (months.length > 48) break;
    }

    // Tous les paiements de l'adhérent : nécessaire pour calculer la fin
    // effective sur l'ensemble des mois, pas seulement la fenêtre affichée.
    const { data: payments, error } = await supabase
        .from('subscription_payments')
        .select('period_month, status, paid_on')
        .eq('member_id', memberId);
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
        legacyLast = v2MonthKey(d);
    }
    const startMonthOfMember = (member.start_date || '').slice(0, 7);

    // Mois réellement affichés : tout mois >= début d'abonnement, plus les
    // mois de début de saison confirmés comme PAYÉ en base (renouvellement).
    const visibleMonths = months.filter(m => m >= startMonthOfMember ||
        ((payMap[m] || {}).status === 'PAYE'));

    // Un mois est-il payé ?
    // IMPORTANT : un paiement explicitement enregistré en base est
    // prioritaire sur l'ancienne période (start_date + durée). Sinon un mois
    // volontairement remis en « NON PAYE » continuerait d'apparaître payé et
    // la mise à jour semblerait ne pas fonctionner.
    function isMonthPaid(m) {
        const p = payMap[m];
        if (p) return p.status === 'PAYE';
        return !!(legacyLast && startMonthOfMember &&
                  m >= startMonthOfMember && m <= legacyLast);
    }

    const grid = document.getElementById('memberMonthsGrid');
    grid.className = 'sub-month-grid';
    grid.innerHTML = visibleMonths.map(m => {
        const p = payMap[m];
        const paid = isMonthPaid(m);
        const legacyOnly = paid && !p;
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

    const paidCount = visibleMonths.filter(isMonthPaid).length;
    const state = v2ComputeSubscriptionState(member, payments);
    const statePill = state
        ? `<span class="stat-pill">Fin effective : <b>${fmtDateV2(state.endKey)}</b>
               ${state.isActive ? `(${state.daysLeft} j)` : '(expiré)'}</span>
           <span class="stat-pill">Statut : <b>${state.isActive ? 'ACTIF' : 'EXPIRÉ'}</b></span>`
        : '';
    document.getElementById('monthsSummary').innerHTML =
        `<span class="stat-pill">Mois payés : <b>${paidCount}</b></span>
         <span class="stat-pill">Mois impayés : <b>${visibleMonths.length - paidCount}</b></span>
         ${statePill}
         <div style="margin-top:8px;font-size:.85rem;opacity:.75;">
             Chaque mois payé prolonge la fin effective d'un mois (au jour du début d'abonnement).
         </div>`;
}

let v2PaymentToggleBusy = false;

async function togglePayment(memberId, periodMonth, currentState) {
    if (v2PaymentToggleBusy) return;
    v2PaymentToggleBusy = true;

    const grid = document.getElementById('memberMonthsGrid');
    if (grid) grid.style.pointerEvents = 'none';

    const nowPaid = currentState === 'PAYE';
    const payload = {
        club_id: v2GetActiveClubId(),
        member_id: memberId,
        period_month: periodMonth,
        previous_status: currentState,
        changed_by: currentUser || 'system',
        status: nowPaid ? 'NON PAYE' : 'PAYE',
        paid_on: nowPaid ? null : v2DateKey(new Date())
    };

    try {
        const { error } = await supabase
            .from('subscription_payments')
            .upsert(payload, { onConflict: 'member_id,period_month' });
        if (error) throw error;

        // Recharge les mois puis la liste (statut / cache adhérents).
        await openMemberMonths(memberId);
        loadSubscriptions();
    } catch (err) {
        alert('Erreur: ' + err.message);
        // En cas d'échec, on réaffiche l'état réel en base.
        openMemberMonths(memberId);
    } finally {
        if (grid) grid.style.pointerEvents = '';
        v2PaymentToggleBusy = false;
    }
}
