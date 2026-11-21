/* ==========================================================================
   js/next-sessions.js
   Prochaines séances d'un adhérent — Kyokushin Manager Pro
   --------------------------------------------------------------------------
   Calcul À LA VOLÉE, sans aucune date future stockée.

   Sources de vérité (schéma Supabase réel) :
     . members.current_group_id        -> groups.id
     . training_sessions (group_id, day_of_week 1..7, start_time, end_time,
       coach, is_active)               -> planning récurrent
     . sessions (group_id, session_date, start_time, end_time, status,
       group_type)                     -> séances ponctuelles réelles uniquement
                                          (ajoutées manuellement par le coach)

   Aucun appel à une RPC de génération, aucune écriture, aucune table
   d'occurrences pré-calculées, aucun champ JSON de planning sur groups.

   API publique (noms conservés) :
     getUpcomingSessions(memberId, limit = 10, options) -> { sessions, message }
     getUpcomingSessionsData(...)                       -> objet détaillé
     UpcomingSessions.init / refresh / render...        -> compatibilité
   ========================================================================== */

(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.NextSessions = api;
    root.UpcomingSessions = api; // alias de compatibilité (ancien module)
  }
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* 1. CONSTANTES                                                       */
  /* ------------------------------------------------------------------ */
  var CLUB_TZ = 'Africa/Algiers';
  var DEFAULT_LIMIT = 10;
  var MAX_LIMIT = 100;
  var HORIZON_DAYS = 56;            // 8 semaines de planning récurrent
  var REFRESH_MS = 5 * 60 * 1000;   // rafraîchissement automatique

  /* ------------------------------------------------------------------ */
  /* 2. ÉTAT INTERNE                                                     */
  /* ------------------------------------------------------------------ */
  var state = {
    client: null,
    memberId: null,
    limit: DEFAULT_LIMIT,
    lastData: null,
    lastLoadedAt: 0,
    loading: false,
    toggleBound: false,
    refreshTimer: null,
    visibilityHandler: null
  };

  /* ------------------------------------------------------------------ */
  /* 3. UTILITAIRES DATE / HEURE (fuseau du club)                        */
  /* ------------------------------------------------------------------ */
  var TZ_DATE_FMT = new Intl.DateTimeFormat('en-US', {
    timeZone: CLUB_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  var TZ_TIME_FMT = new Intl.DateTimeFormat('en-GB', {
    timeZone: CLUB_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  /** Date du jour (YYYY-MM-DD) dans le fuseau Africa/Algiers. */
  function todayInTz(date) {
    var parts = TZ_DATE_FMT.formatToParts(date || new Date());
    var y = '', m = '', d = '';
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].type === 'year') y = parts[i].value;
      else if (parts[i].type === 'month') m = parts[i].value;
      else if (parts[i].type === 'day') d = parts[i].value;
    }
    return y + '-' + m + '-' + d;
  }

  /** Minutes depuis minuit dans le fuseau Africa/Algiers. */
  function minutesInTz(date) {
    var parts = TZ_TIME_FMT.formatToParts(date || new Date());
    var h = 0, m = 0;
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].type === 'hour') h = parseInt(parts[i].value, 10) || 0;
      else if (parts[i].type === 'minute') m = parseInt(parts[i].value, 10) || 0;
    }
    return (h % 24) * 60 + m;
  }

  /** Date calendaire stricte YYYY-MM-DD -> Date UTC (indépendante du TZ local). */
  function parseYmd(ymd) {
    var s = String(ymd == null ? '' : ymd).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    var p = s.split('-').map(Number);
    var dt = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    if (dt.getUTCFullYear() !== p[0] ||
        dt.getUTCMonth() !== p[1] - 1 ||
        dt.getUTCDate() !== p[2]) return null;
    return dt;
  }

  function ymdOf(date) {
    return date.getUTCFullYear() + '-' +
      pad2(date.getUTCMonth() + 1) + '-' +
      pad2(date.getUTCDate());
  }

  /** formatDateISO : normalise une date en 'YYYY-MM-DD'. */
  function formatDateISO(value) {
    if (value instanceof Date) {
      return value.getUTCFullYear() + '-' +
        pad2(value.getUTCMonth() + 1) + '-' +
        pad2(value.getUTCDate());
    }
    var d = parseYmd(value);
    return d ? ymdOf(d) : null;
  }

  function normalizeDate(value) {
    return formatDateISO(value);
  }

  function addDays(ymd, days) {
    var d = parseYmd(ymd);
    if (!d) return ymd;
    d.setUTCDate(d.getUTCDate() + Number(days || 0));
    return ymdOf(d);
  }

  function diffDays(a, b) {
    var da = parseYmd(a);
    var db = parseYmd(b);
    if (!da || !db) return null;
    return Math.round((da.getTime() - db.getTime()) / 86400000);
  }

  /** Jour ISO : 1 = lundi … 7 = dimanche. */
  function isoDow(ymd) {
    var d = parseYmd(ymd);
    if (!d) return null;
    var dow = d.getUTCDay();
    return dow === 0 ? 7 : dow;
  }

  /** Heure "8:5" / "18:30:00" -> "08:05" / "18:30". */
  function normalizeTime(value) {
    if (value == null) return null;
    var m = String(value).trim().match(/^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?/);
    if (!m) return null;
    var h = parseInt(m[1], 10);
    var mi = parseInt(m[2], 10);
    if (h > 23 || mi > 59) return null;
    return pad2(h) + ':' + pad2(mi);
  }

  /** Conforme à la signature fournie : parseTime('18:30') -> { h, m }. */
  function parseTime(value) {
    var t = normalizeTime(value);
    if (!t) return null;
    var p = t.split(':');
    return { h: parseInt(p[0], 10), m: parseInt(p[1], 10) };
  }

  function minutesOfTime(value) {
    var t = parseTime(value);
    return t ? t.h * 60 + t.m : null;
  }

  function capitalize(str) {
    var s = String(str || '');
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  function clamp(value, min, max) {
    var n = Number(value);
    if (!isFinite(n)) return min;
    return Math.min(max, Math.max(min, Math.trunc(n)));
  }

  function escapeHtml(value) {
    var map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return map[c];
    });
  }

  /* ------------------------------------------------------------------ */
  /* 4. FORMATAGE AFFICHAGE                                              */
  /* ------------------------------------------------------------------ */
  function formatDayOfWeek(ymd) {
    var d = parseYmd(ymd);
    if (!d) return '';
    return capitalize(new Intl.DateTimeFormat('fr-FR', {
      weekday: 'long', timeZone: 'UTC'
    }).format(d));
  }

  function formatLongDateFr(ymd) {
    var d = parseYmd(ymd);
    if (!d) return '';
    return capitalize(new Intl.DateTimeFormat('fr-FR', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'
    }).format(d));
  }

  function formatShortDateFr(ymd) {
    var d = parseYmd(ymd);
    if (!d) return '';
    return capitalize(new Intl.DateTimeFormat('fr-FR', {
      weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC'
    }).format(d));
  }

  function relativeDayLabel(ymd, today) {
    var diff = diffDays(ymd, today || todayInTz());
    if (diff == null) return '';
    if (diff === 0) return "Aujourd'hui";
    if (diff === 1) return 'Demain';
    if (diff > 1) return 'Dans ' + diff + ' jours';
    return '';
  }

  function formatTimeRange(session) {
    if (!session || !session.startTime) return '';
    return session.endTime ? session.startTime + ' – ' + session.endTime : session.startTime;
  }

  function compareSessions(a, b) {
    var c = String(a.date || '').localeCompare(String(b.date || ''));
    if (c) return c;
    c = String(a.startTime || '').localeCompare(String(b.startTime || ''));
    if (c) return c;
    if (a.type !== b.type) return a.type === 'extra' ? -1 : 1;
    return 0;
  }

  /* ------------------------------------------------------------------ */
  /* 5. ACCÈS SUPABASE                                                   */
  /* ------------------------------------------------------------------ */
  function resolveClient(options) {
    if (options && options.client && typeof options.client.from === 'function') {
      return options.client;
    }
    if (state.client && typeof state.client.from === 'function') return state.client;
    if (global && typeof global.__supabaseClient !== 'undefined') {
      var c = global.__supabaseClient;
      if (c && typeof c.from === 'function') return c;
    }
    return null;
  }

  /** Résultat standardisé pour les erreurs / cas limites. */
  function emptyResult(message, reason, meta) {
    var out = {
      sessions: [],
      message: message,
      reason: reason || null,
      all: [],
      groups: [],
      groupName: (meta && meta.groupName) || null,
      member: (meta && meta.member) || null,
      today: (meta && meta.today) || todayInTz()
    };
    return out;
  }

  /**
   * Identifiants possibles d'un groupe pour rapprocher les créneaux.
   * Selon les déploiements, training_sessions est rattachée par `group_id`
   * (uuid) ou par `group_type` (libellé). On accepte les deux formes.
   */
  function groupCandidates(group, member) {
    var values = [];
    if (group) {
      values = values.concat([group.id, group.group_type, group.name, group.label, group.code]);
    }
    if (member && member.current_group_id) values.push(member.current_group_id);
    var out = [];
    values.forEach(function (v) {
      if (v == null) return;
      var s = String(v).trim().toLowerCase();
      if (s && out.indexOf(s) === -1) out.push(s);
    });
    return out;
  }

  /** Une ligne appartient au groupe par `group_id` OU par `group_type`. */
  function belongsToGroup(row, candidates) {
    if (!row) return false;
    var id = row.group_id == null ? '' : String(row.group_id).trim().toLowerCase();
    var type = row.group_type == null ? '' : String(row.group_type).trim().toLowerCase();
    if (!id && !type) return false;
    return (!!id && candidates.indexOf(id) !== -1) ||
           (!!type && candidates.indexOf(type) !== -1);
  }

  /** Filtre les créneaux récurrents appartenant au groupe de l'adhérent. */
  function matchingTrainingRows(rows, group, member) {
    var candidates = groupCandidates(group, member);
    return (rows || []).filter(function (row) {
      // is_active est déjà filtré côté SQL ; on garde un garde-fou local.
      if (row && (row.is_active === false || row.is_active === 0)) return false;
      return belongsToGroup(row, candidates);
    });
  }

  /** Filtre les séances ponctuelles appartenant au groupe de l'adhérent. */
  function matchingSessionRows(rows, group, member) {
    var candidates = groupCandidates(group, member);
    return (rows || []).filter(function (row) {
      return belongsToGroup(row, candidates);
    });
  }

  /** Groupe embedde par PostgREST, ou lecture directe en repli. */
  async function resolveGroup(client, member) {
    var raw = member && member.groups;
    var group = Array.isArray(raw) ? raw[0] : raw;
    if (group && group.id) return group;
    if (!member || !member.current_group_id) return null;
    try {
      var res = await client
        .from('groups')
        .select('id, name, is_active')
        .eq('id', member.current_group_id)
        .maybeSingle();
      if (!res.error && res.data) return res.data;
    } catch (err) {
      console.warn('[next-sessions] groups', err);
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* 6. FONCTION PRINCIPALE                                              */
  /* ------------------------------------------------------------------ */
  /**
   * Calcule les N prochaines occurrences du planning récurrent d'un groupe,
   * enrichies des séances ponctuelles déjà présentes dans `sessions`.
   *
   * @param {string} memberId - ID de l'adhérent
   * @param {number} limit - Nombre d'occurrences (défaut 10)
   * @param {object} options - { client, now } (injection pour les tests)
   * @returns {Promise<{sessions: Array, message: string|null}>}
   */
  async function getUpcomingSessions(memberId, limit, options) {
    options = options || {};
    var max = clamp(limit == null ? DEFAULT_LIMIT : limit, 1, MAX_LIMIT);
    var now = options.now ? new Date(options.now) : new Date();
    var today = todayInTz(now);
    var nowMinutes = minutesInTz(now);
    var client = resolveClient(options);

    if (!client) {
      return emptyResult('Connexion à la base impossible.', 'no_client', { today: today });
    }
    if (!memberId) {
      return emptyResult('Aucun identifiant adhérent fourni.', 'no_member', { today: today });
    }

    /* 1. Adhérent + groupe ------------------------------------------- */
    var member = null;
    try {
      var resMember = await client
        .from('members')
        .select('id, first_name, last_name, current_group_id, club_id, groups!current_group_id(id, name, is_active)')
        .eq('id', memberId)
        .single();
      if (resMember.error) throw resMember.error;
      member = resMember.data || null;
    } catch (err) {
      console.warn('[next-sessions] members', err);
      return emptyResult('Adhérent introuvable', 'member_not_found', { today: today });
    }
    if (!member) {
      return emptyResult('Adhérent introuvable', 'member_not_found', { today: today });
    }
    if (!member.current_group_id) {
      return emptyResult('Aucun groupe assigné', 'no_group', { today: today, member: member });
    }

    var group = await resolveGroup(client, member);
    var groupName = (group && group.name) || null;
    var meta = { today: today, member: member, groupName: groupName };

    if (group && group.is_active === false) {
      return emptyResult('Groupe inactif', 'inactive_group', meta);
    }

    /* 2. Planning récurrent (UNIQUEMENT training_sessions) ----------- */
    // select('*') + filtrage local : compatible avec les schémas où le
    // rattachement se fait par `group_id` ET ceux où il se fait par
    // `group_type` (aucune colonne absente référencée dans la requête).
    // Pas de filtre SQL sur `club_id` : selon les bases cette colonne est
    // absente ou différente de members.club_id ; c'est le groupe qui fait foi.
    var recurring = [];
    try {
      var resSlots = await client
        .from('training_sessions')
        .select('*')
        .eq('is_active', true);
      if (resSlots.error) throw resSlots.error;
      recurring = matchingTrainingRows(resSlots.data || [], group, member);
    } catch (err) {
      console.warn('[next-sessions] training_sessions', err);
      return emptyResult('Erreur planning', 'planning_error', meta);
    }

    /* 3. Occurrences calculées sur 8 semaines ------------------------ */
    var occurrences = [];
    var byDow = {};
    recurring.forEach(function (slot) {
      var dow = Number(slot && slot.day_of_week);
      if (!dow || dow < 1 || dow > 7) return;
      if (!byDow[dow]) byDow[dow] = [];
      byDow[dow].push(slot);
    });
    Object.keys(byDow).forEach(function (k) {
      byDow[k].sort(function (a, b) {
        return String(normalizeTime(a.start_time) || '').localeCompare(
          String(normalizeTime(b.start_time) || ''));
      });
    });

    for (var offset = 0; offset <= HORIZON_DAYS && occurrences.length < max; offset++) {
      var date = addDays(today, offset);
      var slots = byDow[isoDow(date)] || [];
      for (var i = 0; i < slots.length && occurrences.length < max; i++) {
        var slot = slots[i];
        var startTime = normalizeTime(slot.start_time);
        if (!startTime) continue;

        var endTime = normalizeTime(slot.end_time) || null;
        var endMinutes = minutesOfTime(endTime || startTime);

        // Créneau déjà terminé aujourd'hui : on l'ignore.
        if (offset === 0 && endMinutes != null && endMinutes <= nowMinutes) continue;

        occurrences.push({
          id: slot.id,
          date: date,
          dayOfWeek: formatDayOfWeek(date),
          startTime: startTime,
          endTime: endTime,
          coach: slot.coach || null,
          type: 'recurring',
          kind: 'recurring',
          label: 'Entraînement',
          groupId: member.current_group_id,
          groupName: groupName
        });
      }
    }

    /* 4. Séances ponctuelles réelles (jamais générées) --------------- */
    // Même logique que training_sessions : on ne filtre pas en SQL sur
    // `group_id`, sinon les séances rattachées uniquement par `group_type`
    // (libellé du groupe) disparaissent. Le filtrage local accepte les deux.
    var extras = [];
    try {
      var resExtra = await client
        .from('sessions')
        .select('id, session_date, start_time, end_time, status, group_id, group_type')
        .gte('session_date', today)
        .neq('status', 'cancelled')
        .order('session_date', { ascending: true })
        .order('start_time', { ascending: true });
      if (!resExtra.error) extras = matchingSessionRows(resExtra.data || [], group, member);
    } catch (err) {
      // Les séances ponctuelles sont optionnelles : un échec ne bloque pas le planning.
      console.warn('[next-sessions] sessions', err);
    }

    extras.forEach(function (s) {
      var date = normalizeDate(s.session_date);
      var startTime = normalizeTime(s.start_time);
      if (!date || !startTime || date < today) return;

      var endTime = normalizeTime(s.end_time) || null;
      var endMinutes = minutesOfTime(endTime || startTime);
      if (date === today && endMinutes != null && endMinutes <= nowMinutes) return;

      var item = {
        id: s.id,
        date: date,
        dayOfWeek: formatDayOfWeek(date),
        startTime: startTime,
        endTime: endTime,
        coach: null,
        type: 'extra',
        kind: 'extra',
        label: 'Séance supplémentaire',
        notes: s.group_type || null,
        status: s.status || null,
        groupId: member.current_group_id,
        groupName: groupName
      };

      // Une séance saisie manuellement est prioritaire sur un créneau identique.
      var key = date + '|' + startTime;
      var idx = -1;
      for (var j = 0; j < occurrences.length; j++) {
        if ((occurrences[j].date + '|' + occurrences[j].startTime) === key) {
          idx = j;
          break;
        }
      }
      if (idx >= 0) occurrences[idx] = item;
      else occurrences.push(item);
    });

    /* 5. Tri, limite, message ---------------------------------------- */
    occurrences.sort(compareSessions);
    var sessions = occurrences.slice(0, max);

    var message = null;
    var reason = null;
    if (!sessions.length) {
      if (!recurring.length) {
        message = 'Aucun créneau défini pour ce groupe';
        reason = 'no_slots';
      } else {
        message = groupName
          ? 'Aucune séance à venir pour le groupe ' + groupName
          : 'Aucune séance à venir pour ce groupe';
        reason = 'none';
      }
    }

    var data = {
      sessions: sessions,
      message: message,
      reason: reason,
      all: occurrences,
      groups: group ? [group] : [],
      groupName: groupName,
      member: member,
      today: today
    };

    if (global) global.__lastUpcomingSessions = data;
    return data;
  }

  /** Alias historique : objet détaillé (groupes, reason, …). */
  async function getUpcomingSessionsData(memberId, limit, options) {
    return getUpcomingSessions(memberId, limit, options);
  }

  /* ------------------------------------------------------------------ */
  /* 7. RENDU HTML                                                       */
  /* ------------------------------------------------------------------ */
  function getEl(id) {
    return (typeof document !== 'undefined') ? document.getElementById(id) : null;
  }

  function emptyStateHtml(data, where) {
    var reason = data && data.reason;
    var msg = (data && data.message) || 'Aucune séance à venir.';

    if (reason === 'no_group') msg = 'Aucun groupe assigné à cet adhérent.';
    else if (reason === 'no_member') msg = 'Aucun identifiant adhérent fourni.';
    else if (reason === 'member_not_found') msg = 'Adhérent introuvable.';
    else if (reason === 'no_client') msg = 'Connexion à la base impossible.';
    else if (reason === 'planning_error' || reason === 'load_error') msg = 'Erreur de chargement, réessayez.';

    var isError = reason === 'load_error' || reason === 'no_client' || reason === 'planning_error';
    var isList = where === 'list';
    if (isList && (!reason || reason === 'none' || reason === 'no_slots')) {
      msg = 'Aucune autre séance à venir.';
    }

    return '<div class="session-empty' + (isError ? ' session-error' : '') + '" role="status">' +
      '<span class="session-empty__icon" aria-hidden="true">' + (isError ? '⚠️' : '📭') + '</span>' +
      '<p>' + escapeHtml(msg) + '</p>' +
      (isError ? '<button type="button" class="session-retry" data-session-retry>Réessayer</button>' : '') +
      '</div>';
  }

  function renderBadges(session, today) {
    var cls = (session && session.type === 'extra')
      ? { label: 'Séance supplémentaire', badgeClass: 'badge--extra' }
      : { label: 'Entraînement', badgeClass: 'badge--recurring' };
    var parts = ['<span class="badge ' + cls.badgeClass + '">' + escapeHtml(cls.label) + '</span>'];
    var rel = relativeDayLabel(session.date, today);

    if (rel === "Aujourd'hui") {
      parts.push('<span class="badge badge--today">Aujourd\'hui</span>');
    } else if (rel === 'Demain') {
      parts.push('<span class="badge badge--tomorrow">Demain</span>');
    }
    return parts.join('');
  }

  function renderNextSession(session, meta) {
    var body = getEl('nextSessionBody');
    if (!body) return;
    body.setAttribute('aria-busy', 'false');

    var today = (meta && meta.today) || (state.lastData && state.lastData.today) || todayInTz();

    if (!session || !parseYmd(session.date)) {
      body.innerHTML = emptyStateHtml(meta, 'next');
      return;
    }

    var d = parseYmd(session.date);
    var weekday = formatDayOfWeek(session.date);
    var dayNum = String(d.getUTCDate());
    var monthYear = capitalize(new Intl.DateTimeFormat('fr-FR', {
      month: 'long', year: 'numeric', timeZone: 'UTC'
    }).format(d));
    var rel = relativeDayLabel(session.date, today);
    var isToday = rel === "Aujourd'hui";

    body.innerHTML =
      '<div class="session-next' + (isToday ? ' session-next--today' : '') + '">' +
        '<div class="session-next__date" aria-hidden="true">' +
          '<span class="session-next__weekday">' + escapeHtml(weekday) + '</span>' +
          '<span class="session-next__daynum">' + escapeHtml(dayNum) + '</span>' +
          '<span class="session-next__month">' + escapeHtml(monthYear) + '</span>' +
        '</div>' +
        '<div class="session-next__details">' +
          '<p class="session-next__full-date">' + escapeHtml(formatLongDateFr(session.date)) + '</p>' +
          '<p class="session-next__time">' + escapeHtml(formatTimeRange(session)) + '</p>' +
          '<div class="session-next__badges">' + renderBadges(session, today) + '</div>' +
          (session.coach ? '<p class="session-next__coach">🥋 ' + escapeHtml(session.coach) + '</p>' : '') +
          (rel ? '<p class="session-next__countdown">' + escapeHtml(rel) + '</p>' : '') +
        '</div>' +
      '</div>';
  }

  function renderUpcomingList(sessions, meta) {
    var list = getEl('upcomingList');
    if (!list) return;

    var today = (meta && meta.today) || (state.lastData && state.lastData.today) || todayInTz();
    var rows = sessions || [];

    if (!rows.length) {
      list.innerHTML = emptyStateHtml(meta, 'list');
      return;
    }

    list.innerHTML = '<ul class="session-list" role="list">' + rows.map(function (s) {
      var isExtra = s.type === 'extra';
      var rel = relativeDayLabel(s.date, today);
      return '<li class="session-item' + (isExtra ? ' session-item--extra' : '') +
          '" data-date="' + escapeHtml(s.date) + '" data-type="' + escapeHtml(s.type) + '">' +
        '<div class="session-item__date">' +
          '<strong>' + escapeHtml(formatShortDateFr(s.date)) + '</strong>' +
          (rel ? '<span>' + escapeHtml(rel) + '</span>' : '') +
        '</div>' +
        '<div class="session-item__main">' +
          '<div class="session-item__time">' + escapeHtml(formatTimeRange(s)) + '</div>' +
          (s.coach ? '<div class="session-item__coach">🥋 ' + escapeHtml(s.coach) + '</div>' : '') +
          '<div class="session-item__badges">' + renderBadges(s, today) + '</div>' +
        '</div>' +
      '</li>';
    }).join('') + '</ul>';
  }

  function setListExpanded(expanded) {
    var list = getEl('upcomingList');
    var btn = getEl('toggleUpcomingBtn');
    if (!list || !btn) return;

    list.hidden = !expanded;
    btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    btn.setAttribute('aria-label', expanded
      ? 'Masquer les prochaines séances'
      : 'Voir toutes les prochaines séances');
    btn.textContent = expanded ? 'Masquer' : 'Voir tout';
  }

  function render(data) {
    data = data || emptyResult('Erreur de chargement, réessayez.', 'load_error');

    var groupEl = getEl('nextSessionGroup');
    if (groupEl) groupEl.textContent = data.groupName || '';

    var memberGroupEl = getEl('memberGroup');
    if (memberGroupEl) {
      memberGroupEl.textContent = data.groupName ||
        (data.reason === 'no_group' ? 'Aucun groupe' : '—');
    }

    var all = data.sessions || [];
    renderNextSession(all[0] || null, data);
    // sessions[1..N] dans la liste dépliante (la carte affiche déjà [0]).
    renderUpcomingList(all.slice(1), data);

    var nextBody = getEl('nextSessionBody');
    if (nextBody) nextBody.setAttribute('aria-busy', 'false');
  }

  function setLoading() {
    var next = getEl('nextSessionBody');
    var list = getEl('upcomingList');
    if (next) {
      next.setAttribute('aria-busy', 'true');
      next.innerHTML = '<div class="session-skeleton">Chargement…</div>';
    }
    if (list) list.innerHTML = '<div class="session-skeleton">Chargement…</div>';
  }

  /* ------------------------------------------------------------------ */
  /* 8. ÉVÉNEMENTS / CHARGEMENT                                          */
  /* ------------------------------------------------------------------ */
  function bindToggle() {
    if (state.toggleBound || typeof document === 'undefined') return;

    var btn = getEl('toggleUpcomingBtn');
    var list = getEl('upcomingList');
    if (!btn || !list) return;

    btn.addEventListener('click', function () {
      setListExpanded(list.hidden);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !list.hidden) {
        setListExpanded(false);
        btn.focus();
      }
    });

    document.addEventListener('click', function (e) {
      var target = e.target;
      if (target && typeof target.closest === 'function' && target.closest('[data-session-retry]')) {
        refresh({ initial: true });
      }
    });

    state.toggleBound = true;
  }

  async function refresh(opts) {
    opts = opts || {};
    if (!state.memberId) {
      render(emptyResult('Aucun identifiant adhérent fourni.', 'no_member'));
      return;
    }
    if (state.loading) return;

    state.loading = true;
    if (opts.initial) setLoading();

    try {
      var data = await getUpcomingSessions(state.memberId, state.limit, {
        client: state.client
      });
      state.lastData = data;
      state.lastLoadedAt = Date.now();
      render(data);
    } catch (err) {
      console.error('[next-sessions] refresh', err);
      render(emptyResult('Erreur de chargement, réessayez.', 'load_error'));
    } finally {
      state.loading = false;
      var body = getEl('nextSessionBody');
      if (body) body.setAttribute('aria-busy', 'false');
    }
  }

  function stopAutoRefresh() {
    if (state.refreshTimer) {
      clearInterval(state.refreshTimer);
      state.refreshTimer = null;
    }
    if (state.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', state.visibilityHandler);
      state.visibilityHandler = null;
    }
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    state.refreshTimer = window.setInterval(function () {
      if (document.hidden) return;
      if (Date.now() - state.lastLoadedAt < REFRESH_MS - 1000) return;
      refresh({ silent: true });
    }, REFRESH_MS);

    state.visibilityHandler = function () {
      if (!document.hidden && Date.now() - state.lastLoadedAt > REFRESH_MS) {
        refresh({ silent: true });
      }
    };
    document.addEventListener('visibilitychange', state.visibilityHandler);
  }

  async function init(options) {
    options = options || {};
    var client = options.supabase || options.client || resolveClient(options);

    if (!client) {
      render(emptyResult('Connexion à la base impossible.', 'no_client'));
      return;
    }

    state.client = client;
    state.memberId = options.memberId || state.memberId || null;
    state.limit = clamp(options.limit == null ? DEFAULT_LIMIT : options.limit, 1, MAX_LIMIT);

    bindToggle();
    await refresh({ initial: true });
    startAutoRefresh();
  }

  /* ------------------------------------------------------------------ */
  /* 9. EXPORTS                                                          */
  /* ------------------------------------------------------------------ */
  var _internals = {
    CLUB_TZ: CLUB_TZ,
    DEFAULT_LIMIT: DEFAULT_LIMIT,
    HORIZON_DAYS: HORIZON_DAYS,
    todayInTz: todayInTz,
    minutesInTz: minutesInTz,
    parseYmd: parseYmd,
    ymdOf: ymdOf,
    formatDateISO: formatDateISO,
    normalizeDate: normalizeDate,
    addDays: addDays,
    diffDays: diffDays,
    isoDow: isoDow,
    parseTime: parseTime,
    minutesOfTime: minutesOfTime,
    normalizeTime: normalizeTime,
    groupCandidates: groupCandidates,
    matchingTrainingRows: matchingTrainingRows,
    matchingSessionRows: matchingSessionRows,
    formatDayOfWeek: formatDayOfWeek,
    formatLongDateFr: formatLongDateFr,
    formatShortDateFr: formatShortDateFr,
    relativeDayLabel: relativeDayLabel,
    formatTimeRange: formatTimeRange,
    compareSessions: compareSessions,
    clamp: clamp,
    escapeHtml: escapeHtml
  };

  var api = {
    init: init,
    refresh: refresh,
    stopAutoRefresh: stopAutoRefresh,
    getUpcomingSessions: getUpcomingSessions,
    getUpcomingSessionsData: getUpcomingSessionsData,
    renderNextSession: renderNextSession,
    renderUpcomingList: renderUpcomingList,
    setListExpanded: setListExpanded,
    getState: function () {
      return {
        memberId: state.memberId,
        limit: state.limit,
        lastData: state.lastData,
        lastLoadedAt: state.lastLoadedAt,
        loading: state.loading
      };
    },
    _internals: _internals
  };

  // Alias globaux pour les tests console (F12).
  if (global) {
    global.getUpcomingSessions = getUpcomingSessions;
    global.getUpcomingSessionsData = getUpcomingSessionsData;
    global.renderNextSession = renderNextSession;
    global.renderUpcomingList = renderUpcomingList;
  }

  return api;
});
