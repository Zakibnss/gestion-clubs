// ============================================
// SOCLE ABONNEMENTS — calcul de la fin effective
// Partagé par index.html (liste des adhérents),
// adherent.html (page QR) et js/subscriptions.js.
//
// Règle : chaque mois PAYÉ dans subscription_payments
// prolonge l'abonnement d'un mois, à partir du jour du
// début d'abonnement. Exemple : début le 15/09,
// septembre payé → fin le 15/10 ; octobre payé en plus
// → fin le 15/11.
//
// Aucune dépendance DOM / Supabase : ce fichier ne contient
// que des fonctions pures.
// ============================================

const V2_SUB_DURATION_MONTHS = {
    monthly: 1,
    quarterly: 3,
    biannual: 6,
    annual: 12
};

/* Clés de date locales (évite le décalage UTC de toISOString). */
function v2MonthKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function v2DateKey(date) {
    return `${v2MonthKey(date)}-${String(date.getDate()).padStart(2, '0')}`;
}

/* Index de mois absolu (année * 12 + mois 0-11), pratique pour comparer. */
function v2MonthIndex(date) {
    return date.getFullYear() * 12 + date.getMonth();
}

/* Date au `day` du mois d'index donné, ramenée au dernier jour du mois
   si ce jour n'existe pas (ex. 31 → 28/29 février). */
function v2DateInMonth(monthIndex, day) {
    const y = Math.floor(monthIndex / 12);
    const m = monthIndex % 12;
    const lastDay = new Date(y, m + 1, 0).getDate();
    return new Date(y, m, Math.min(Math.max(day || 1, 1), lastDay));
}

/* "2026-10" → index de mois absolu (null si invalide). */
function v2ParseMonthIndex(periodMonth) {
    const match = /^(\d{4})-(\d{2})/.exec(String(periodMonth || ''));
    if (!match) return null;
    return Number(match[1]) * 12 + (Number(match[2]) - 1);
}

function v2SubscriptionStateFromEnd(end) {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const daysLeft = Math.max(0, Math.round((end - today) / 86400000));
    return { end, endKey: v2DateKey(end), isActive: end >= today, daysLeft };
}

/**
 * État réel d'un abonnement d'après ses mois payés.
 * - La période initiale (start_date + durée) reste considérée payée tant
 *   qu'aucune ligne de paiement ne la contredit (compatibilité ancien système).
 * - Un mois explicitement « NON PAYE » coupe cette période initiale.
 * - Le dernier mois payé (initial ou cliqué dans la modale) fixe la fin :
 *   jour du début d'abonnement, le mois suivant.
 * Retourne null si l'adhérent n'a pas de date de début exploitable.
 */
function v2ComputeSubscriptionState(member, paymentRows) {
    if (!member || !member.start_date) return null;

    const start = new Date(member.start_date + 'T00:00:00');
    if (isNaN(start.getTime())) return null;

    const duration = V2_SUB_DURATION_MONTHS[member.subscription] || 1;
    const startIndex = v2MonthIndex(start);
    const startDay = start.getDate();
    const legacyEnd = v2DateInMonth(startIndex + duration, startDay);

    const rows = paymentRows || [];
    if (!rows.length) return v2SubscriptionStateFromEnd(legacyEnd);

    let legacyLastIndex = startIndex + duration - 1;
    let maxPaidIndex = -1;

    rows.forEach(row => {
        const idx = v2ParseMonthIndex(row.period_month);
        if (idx === null || idx < startIndex) return;
        if (row.status === 'PAYE') {
            if (idx > maxPaidIndex) maxPaidIndex = idx;
        } else if (idx <= legacyLastIndex) {
            // Mois de la période initiale décoché : la couverture s'arrête avant.
            legacyLastIndex = Math.min(legacyLastIndex, idx - 1);
        }
    });

    const legacyPaidIndex = legacyLastIndex >= startIndex ? legacyLastIndex : -1;
    const lastPaidIndex = Math.max(legacyPaidIndex, maxPaidIndex);

    // Aucun mois payé : l'abonnement n'a jamais commencé / est terminé.
    if (lastPaidIndex < 0) return v2SubscriptionStateFromEnd(start);

    const end = v2DateInMonth(lastPaidIndex + 1, startDay);
    return v2SubscriptionStateFromEnd(end);
}

/* Regroupe les paiements par adhérent. */
function v2GroupPaymentsByMember(payments) {
    const byMember = {};
    (payments || []).forEach(p => {
        if (!byMember[p.member_id]) byMember[p.member_id] = [];
        byMember[p.member_id].push(p);
    });
    return byMember;
}
