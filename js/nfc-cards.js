// ============================================================
// MODULE NFC CARDS — gestion des cartes par UID / Serial Number
//
// Objectifs :
//   . Inventaire des cartes NFC (UID unique) — attribution /
//     désattribution à un adhérent, statut, historique.
//   . Scanner de présence : mappe un UID scanné vers un adhérent
//     et enregistre une présence (table attendance) + évènement.
//
// Lecture NFC : TOUTES les lectures passent par le lecteur NFC
// externe via le service partagé « NFCReaderService » (WebUSB).
// Aucune lecture directe navigateur (Web NFC) ni NFC intégré du
// téléphone. Ce module ne communique jamais avec le matériel : il
// délègue à NFCReaderService les fonctions readUID()/startPolling().
// ============================================================

window.NfcCards = (function () {

    /* ---------- Délégation au lecteur NFC externe (service partagé) ---------- */
    const reader = () => window.NFCReaderService;

    function nfcSupported() {
        // Le lecteur externe est portable/matériel, indépendant du navigateur.
        return !!('usb' in navigator);
    }

    function nfcSupportedLabel() {
        return 'Lecteur NFC externe requis (WebUSB). Branchez le lecteur USB puis connectez-le.';
    }

    /* Lecture d'un UID via le lecteur externe (une détection) */
    async function readUid() {
        return reader().readUID();
    }

    /* Lecture continue : onUid(uid) à chaque passage de carte */
    function startPolling(onUid) {
        return reader().startPolling(onUid);
    }
    function stopPolling() {
        return reader().stopPolling();
    }

    /* ---------- Normalisation d'un identifiant de repli (admin) ---------- */
    function buildUidFromText(raw) {
        return String(raw || '').replace(/[\r\n\t]/g, '').trim().toUpperCase().replace(/\s+/g, '');
    }

    /* ---------- API base ---------- */
    async function listCards(filters) {
        filters = filters || {};
        let q = window.supabase.from('nfc_card_status')
            .select('*')
            .order('updated_at', { ascending: false });

        if (filters.status && filters.status !== 'all') q = q.eq('status', filters.status);
        if (filters.member_id) q = q.eq('member_id', filters.member_id);
        if (filters.q) q = q.ilike('uid', '%' + filters.q + '%');

        const { data, error } = await q;
        if (error) throw error;
        return data || [];
    }

    async function listMembers(clubId) {
        let q = window.supabase.from('members')
            .select('id, first_name, last_name, photo_url, club_id')
            .order('last_name');
        if (clubId && clubId !== 'admin') q = q.eq('club_id', clubId);
        const { data, error } = await q;
        if (error) throw error;
        return data || [];
    }

    /* Attribution / réattribution d'une carte à un adhérent */
    async function assignCard(uid, memberId) {
        const { data, error } = await window.supabase
            .rpc('assign_nfc_card', { p_uid: uid, p_member_id: memberId });
        if (error) throw error;
        return data;
    }

    /* Désattribution */
    async function unassignCard(cardId) {
        const { error } = await window.supabase
            .from('nfc_cards')
            .update({
                member_id: null,
                status: 'unassigned',
                assigned_at: null,
                unassigned_at: new Date().toISOString()
            })
            .eq('id', cardId);
        if (error) throw error;
    }

    /* Création d'une carte libre (UID connu saisi manuellement) */
    async function createCard(uid) {
        const { data, error } = await window.supabase
            .from('nfc_cards')
            .insert({ uid, status: 'unassigned' })
            .select()
            .single();
        if (error) throw error;
        return data;
    }

    /* Marquage perdu / retiré */
    async function setCardStatus(cardId, status) {
        const patch = {
            status,
            unassigned_at: status === 'unassigned' || status === 'lost' || status === 'retired'
                ? new Date().toISOString() : null
        };
        if (status !== 'assigned') patch.member_id = null;
        const { error } = await window.supabase
            .from('nfc_cards')
            .update(patch)
            .eq('id', cardId);
        if (error) throw error;
    }

    /* Historique complet d'une carte (évènements de scan) */
    async function listCardHistory(uid) {
        const { data, error } = await window.supabase
            .from('nfc_attendance_events')
            .select('*')
            .eq('uid', uid)
            .order('scan_time', { ascending: false })
            .limit(50);
        if (error) throw error;
        return data || [];
    }

    /* Historique global */
    async function listAllHistory(limit) {
        limit = limit || 100;
        const { data, error } = await window.supabase
            .from('nfc_attendance_events')
            .select('*')
            .order('scan_time', { ascending: false })
            .limit(limit);
        if (error) throw error;
        return data || [];
    }

    /* ---------- Scanner de présence ----------
       Enregistre la présence de l'adhérent associé à un UID, et un
       évènement d'historique. Retourne un objet info pour l'UI. */
    /* Événements disponibles pour le scanner de paiement :
       événements du club actif + TOUS les événements généraux. */
    async function listEventsForScanner(clubId) {
        let q = window.supabase
            .from('events')
            .select('id, title, event_date, price, scope, club_id')
            .order('event_date', { ascending: false });
        if (clubId) q = q.or(`club_id.eq.${clubId},scope.eq.general`);
        else q = q.eq('scope', 'general');   // sans club : seulement les généraux
        let { data, error } = await q;
        if (error) {
            // Repli si la colonne `scope` n'est pas encore migrée (017).
            let fb = window.supabase.from('events')
                .select('id, title, event_date, price, club_id')
                .order('event_date', { ascending: false });
            if (clubId) fb = fb.eq('club_id', clubId);
            const r = await fb;
            if (r.error) throw r.error;
            data = (r.data || []).map(e => ({ ...e, scope: 'local' }));
        }
        return data || [];
    }

    /* Encaisse le paiement d'un événement pour l'adhérent identifié par sa
       carte. La carte est résolue globalement : accepté pour les adhérents
       de TOUS les clubs/groupes (utile pour un événement général).
       Retourne { ok, paid, alreadyPaid, reason, amount, event }. */
    async function payEventForMember(eventId, memberId) {
        const [evRes, partRes] = await Promise.all([
            window.supabase.from('events')
                .select('id, title, price')
                .eq('id', eventId).maybeSingle(),
            window.supabase.from('event_participants')
                .select('id')
                .eq('event_id', eventId)
                .eq('member_id', memberId)
                .maybeSingle()
        ]);
        if (evRes.error) throw evRes.error;
        if (partRes.error) throw partRes.error;

        const ev = evRes.data;
        if (!ev) return { ok: false, reason: 'event_not_found' };

        const part = partRes.data;
        if (!part) return { ok: false, reason: 'not_participant', event: ev };

        const { data: pays, error: payErr } = await window.supabase
            .from('event_payments')
            .select('id, status')
            .eq('participant_id', part.id)
            .order('created_at', { ascending: false })
            .limit(1);
        if (payErr) throw payErr;

        const last = (pays || [])[0];
        if (last && last.status === 'PAYE') {
            return { ok: true, alreadyPaid: true, amount: Number(ev.price || 0), event: ev };
        }

        const { error } = await window.supabase.from('event_payments').insert({
            participant_id: part.id,
            amount: Number(ev.price || 0),
            status: 'PAYE',
            previous_status: last ? last.status : 'NON PAYE',
            paid_on: new Date().toISOString().slice(0, 10),
            changed_by: 'NFC'
        });
        if (error) throw error;
        return { ok: true, paid: true, amount: Number(ev.price || 0), event: ev };
    }

    /* ---------- Scanner de présence ----------*
       Enregistre la présence de l'adhérent associé à un UID, et un
       évènement d'historique. Retourne un objet info pour l'UI.
       opts.eventId : encaisse aussi le paiement de l'événement choisi. */
    async function scanPresence(uid, clubId, opts) {
        opts = opts || {};
        const method = opts.method || 'NFC';
        const uidClean = buildUidFromText(uid);
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10);
        const timeStr = now.toTimeString().slice(0, 8);
        const month = now.toISOString().slice(0, 7);

        // Carte connue ?
        const { data: card, error: cardErr } = await window.supabase
            .from('nfc_cards')
            .select('uid, member_id, status')
            .eq('uid', uidClean)
            .maybeSingle();
        if (cardErr) throw cardErr;

        if (!card) {
            await insertEvent({ club_id: clubId, uid: uidClean, member_id: null,
                scan_date: dateStr, scan_result: 'unknown', method });
            return { ok: false, uid: uidClean, result: 'unknown', label: 'Carte non attribuée',
                detail: 'Cette carte n\'est associée à aucun adhérent.', member: null };
        }

        if (card.status !== 'assigned' || !card.member_id) {
            await insertEvent({ club_id: clubId, uid: uidClean, member_id: null,
                scan_date: dateStr, scan_result: 'unassigned', method });
            return { ok: false, uid: uidClean, result: 'unassigned', label: 'Carte libre',
                detail: 'Cette carte n\'est attribuée à aucun adhérent.', member: null };
        }

        // Adhérent + groupe courant (une seule requête via join REST)
        const { data: member, error: memberErr } = await window.supabase
            .from('members')
            .select(`
                id, first_name, last_name, photo_url, current_group_id, club_id,
                groups:current_group_id ( name )
            `)
            .eq('id', card.member_id)
            .maybeSingle();
        if (memberErr) throw memberErr;
        if (!member) {
            await insertEvent({ club_id: clubId, uid: uidClean, member_id: card.member_id,
                scan_date: dateStr, scan_result: 'unknown', method });
            return { ok: false, uid: uidClean, result: 'unknown', label: 'Adhérent introuvable',
                detail: 'La carte est attribuée à un adhérent absent.', member: null };
        }

        const groupName = (member.groups && member.groups.name) || null;

        // Abonnement + présence existante du jour : requêtes PARALLÈLES
        // (au lieu de 3 requêtes séquentielles -> réponse plus rapide).
        const [stRes, dupRes] = await Promise.all([
            window.supabase
                .from('member_subscription_status')
                .select('is_active, end_effective')
                .eq('member_id', card.member_id)
                .maybeSingle(),
            opts.allowDuplicate ? Promise.resolve({ data: null }) :
                (() => {
                    let q = window.supabase
                        .from('attendance')
                        .select('id, attendance_time')
                        .eq('member_id', card.member_id)
                        .eq('attendance_date', dateStr);
                    if (clubId) q = q.eq('club_id', clubId);
                    return q.limit(1);
                })()
        ]);

        const st = stRes.data;
        const existing = dupRes.data;
        const fullName = `${member.last_name} ${member.first_name}`;

        // LA PRÉSENCE EST ENREGISTRÉE MÊME SI L'ABONNEMENT EST EXPIRÉ :
        // la carte a bien été lue et l'adhérent identifié. La seule
        // différence visible est le statut « expired » remonté à l'UI.
        const expired = !st || !st.is_active;

        // Paiement d'événement par carte (optionnel). La carte est résolue
        // globalement : fonctionne pour les adhérents de tous les clubs/groupes.
        let payment = null;
        if (opts.eventId) {
            try {
                payment = await payEventForMember(opts.eventId, card.member_id);
            } catch (e) {
                console.warn('payEventForMember', e);
                payment = { ok: false, reason: 'error', message: e.message };
            }
        }

        // Vérif : présence déjà enregistrée aujourd'hui ? (anti-doublon)
        if (!opts.allowDuplicate) {
            if (existing && existing.length) {
                insertEvent({ club_id: clubId, uid: uidClean, member_id: card.member_id,
                    scan_date: dateStr, scan_result: expired ? 'expired' : 'present', method, duplicate: true });
                return { ok: true, duplicate: true, result: 'present', uid: uidClean,
                    label: 'Présence déjà enregistrée',
                    detail: `${fullName} a validé sa présence à ${existing[0].attendance_time}.`,
                    member, groupName, firstTime: existing[0].attendance_time, expired, payment };
            }
        }

        // Insert présence + évènement : exécutés EN PARALLÈLE (non bloquant).
        // L'UI affiche immédiatement le résultat, les écritures DB suivent.
        const writes = [];
        if (clubId) {
            writes.push(window.supabase.from('attendance').insert({
                member_id: card.member_id,
                club_id: clubId,
                attendance_date: dateStr,
                attendance_time: timeStr,
                month
            }).then(({ error }) => { if (error) throw error; }));
        }
        writes.push(insertEvent({ club_id: clubId, uid: uidClean, member_id: card.member_id,
            scan_date: dateStr, scan_result: expired ? 'expired' : 'present', method }));
        await Promise.all(writes);

        if (expired) {
            return { ok: true, expired: true, uid: uidClean, result: 'expired',
                label: 'Présence enregistrée (abonnement expiré)',
                detail: `${fullName} · ${timeStr} — présence validée malgré l'abonnement expiré.`,
                member, groupName, time: timeStr, date: dateStr };
        }
        return { ok: true, result: 'present', uid: uidClean, label: 'Présence enregistrée',
            detail: `${fullName} · ${timeStr}`, member, groupName, time: timeStr, date: dateStr, payment };
    }

    async function insertEvent(ev) {
        const { error } = await window.supabase.from('nfc_attendance_events').insert({
            club_id: ev.club_id || null,
            uid: ev.uid,
            member_id: ev.member_id || null,
            scan_time: new Date().toISOString(),
            scan_date: ev.scan_date,
            scan_result: ev.scan_result,
            method: ev.method || 'NFC'
        });
        if (error) console.warn('insertEvent', error);
    }

    return {
        nfcSupported,
        nfcSupportedLabel,
        readUid,
        startPolling,
        stopPolling,
        buildUidFromText,
        listCards,
        listMembers,
        assignCard,
        unassignCard,
        createCard,
        setCardStatus,
        listCardHistory,
        listAllHistory,
        listEventsForScanner,
        payEventForMember,
        scanPresence
    };
})();
