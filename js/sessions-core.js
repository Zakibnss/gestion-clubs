// ============================================
// MODULE CENTRAL — SÉANCES PLANIFIÉES
// Lecture seule : aucune date future n'est stockée côté client.
// Présences, rapports et fiche QR passent par getGroupSessions.
// ============================================

(function (global) {
    'use strict';

    // Séances planifiées d'un groupe sur [from, to] ('YYYY-MM-DD').
    // Retourne [{ session_date, start_time, source: 'schedule'|'extra' }]
    // en respectant : saison (septembre), pauses, séances annulées.
    async function getGroupSessions(groupId, from, to) {
        if (!groupId || !from || !to) return [];
        try {
            const { data, error } = await global.supabase
                .rpc('group_planned_sessions', {
                    p_group_id: groupId,
                    p_from: from,
                    p_to: to
                });
            if (error) {
                console.warn('getGroupSessions', error);
                return [];
            }
            return data || [];
        } catch (err) {
            console.warn('getGroupSessions', err);
            return [];
        }
    }

    // Séances planifiées d'un groupe ramenées par date (dictionnaire)
    async function getGroupSessionsByDate(groupId, from, to) {
        const rows = await getGroupSessions(groupId, from, to);
        const byDate = {};
        (rows || []).forEach(s => {
            byDate[s.session_date] = s;
        });
        return byDate;
    }

    // Date de réinscription d'un membre : inscription active la plus
    // récente, sinon members.start_date. Retourne 'YYYY-MM-DD' ou null.
    function reinDate(member, activeRegistrations) {
        if (member && activeRegistrations && activeRegistrations.length) {
            const mine = activeRegistrations
                .filter(r => r.member_id === member.id)
                .sort((a, b) => (a.start_date > b.start_date ? -1 : 1));
            if (mine.length && mine[0].start_date) return mine[0].start_date;
        }
        return (member && member.start_date) ? member.start_date : null;
    }

    global.getGroupSessions = getGroupSessions;
    global.getGroupSessionsByDate = getGroupSessionsByDate;
    global.getMemberReinDate = reinDate;
})(window);