/* ==========================================================================
   js/upcoming-sessions.js
   Prochaines séances d'un adhérent — Kyokushin Manager Pro
   --------------------------------------------------------------------------
   Source de vérité réelle (schéma constaté sur Supabase) :
     . members.current_group_id  -> groups.id
       (repli : group_members où end_date IS NULL)
     . groups.start_date / end_date / pause_start_date / pause_end_date
     . training_sessions (group_type, day_of_week, start_time, end_time,
       is_active) -> créneaux récurrents actifs
     . sessions (group_id, session_date, start_time, end_time, status,
       group_type) -> séances ponctuelles + annulations
       status = 'cancelled'  -> séance annulée (exclue)

   Aucune dépendance externe : le client Supabase est injecté via init()
   (ou récupéré depuis window.__supabaseClient).

   API publique :
     UpcomingSessions.init({ supabase, memberId, limit })
     UpcomingSessions.refresh()
     UpcomingSessions.getUpcomingSessions(memberId, limit)   // -> Array
     UpcomingSessions.getUpcomingSessionsData(memberId, limit) // -> objet détaillé
     UpcomingSessions.renderNextSession(session, meta)
     UpcomingSessions.renderUpcomingList(sessions, meta)
     UpcomingSessions.setListExpanded(bool)
     window.getUpcomingSessions(memberId, limit)             // test console
   ========================================================================== */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.UpcomingSessions = api;
})(typeof window !== 'undefined' ? window : globalThis, function (global) {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* 1. CONSTANTES                                                       */
  /* ------------------------------------------------------------------ */
  const CLUB_TZ = 'Africa/Algiers';
  const DAY_KEYS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
  const DEFAULT_LIMIT = 20;
  const HORIZON_DAYS = 180;              // même horizon que l'ancienne RPC SQL
  const REFRESH_MS = 5 * 60 * 1000;      // auto-refresh 5 min

  /* ------------------------------------------------------------------ */
  /* 2. ÉTAT INTERNE                                                     */
  /* ------------------------------------------------------------------ */
  const state = {
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
  /* 3. OUTILS DATE / HEURE (timezone du club : Africa/Algiers)          */
  /* ------------------------------------------------------------------ */
  const TZ_DATE_FMT = new Intl.DateTimeFormat('en-US', {
    timeZone: CLUB_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  const TZ_TIME_FMT = new Intl.DateTimeFormat('en-GB', {
    timeZone: CLUB_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  /** Date du jour (YYYY-MM-DD) dans le fuseau du club. */
  function todayInTz(date) {
    const parts = TZ_DATE_FMT.formatToParts(date || new Date());
    let y = '', m = '', d = '';
    for (const p of parts) {
      if (p.type === 'year') y = p.value;
      else if (p.type === 'month') m = p.value;
      else if (p.type === 'day') d = p.value;
    }
    return y + '-' + m + '-' + d;
  }

  /** Minutes depuis minuit dans le fuseau du club. */
  function timeInTz(date) {
    const parts = TZ_TIME_FMT.formatToParts(date || new Date());
    let h = 0, m = 0;
    for (const p of parts) {
      if (p.type === 'hour') h = parseInt(p.value, 10) || 0;
      else if (p.type === 'minute') m = parseInt(p.value, 10) || 0;
    }
    return (h % 24) * 60 + m;
  }

  /** Parse strict d'une date calendaire YYYY-MM-DD -> Date UTC. */
  function parseYmd(ymd) {
    const s = String(ymd == null ? '' : ymd).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const parts = s.split('-').map(Number);
    const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
    if (dt.getUTCFullYear() !== parts[0] ||
        dt.getUTCMonth() !== parts[1] - 1 ||
        dt.getUTCDate() !== parts[2]) return null;
    return dt;
  }

  function ymdOf(date) {
    return date.getUTCFullYear() + '-' +
      pad2(date.getUTCMonth() + 1) + '-' +
      pad2(date.getUTCDate());
  }

  function addDaysYmd(ymd, n) {
    const d = parseYmd(ymd);
    if (!d) return ymd;
    d.setUTCDate(d.getUTCDate() + Number(n || 0));
    return ymdOf(d);
  }

  function diffDays(a, b) {
    const da = parseYmd(a);
    const db = parseYmd(b);
    if (!da || !db) return null;
    return Math.round((da.getTime() - db.getTime()) / 86400000);
  }

  /** Numéro de jour ISO : 1 = lundi … 7 = dimanche. */
  function isoDow(ymd) {
    const d = parseYmd(ymd);
    if (!d) return null;
    const dow = d.getUTCDay();
    return dow === 0 ? 7 : dow;
  }

  /** Normalise une heure "8:5", "18:30:00" -> "08:05" / "18:30". */
  function normalizeTime(value) {
    if (value == null) return null;
    const m = String(value).trim().match(/^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?/);
    if (!m) return null;
    const h = parseInt(m[1], 10);
    const mi = parseInt(m[2], 10);
    if (h > 23 || mi > 59) return null;
    return pad2(h) + ':' + pad2(mi);
  }

  function parseTimeToMinutes(hhmm) {
    const t = normalizeTime(hhmm);
    if (!t) return null;
    const p = t.split(':');
    return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
  }

  function addMinutesToTime(hhmm, minutes) {
    const t = normalizeTime(hhmm);
    const n = Number(minutes);
    if (!t || !isFinite(n)) return null;
    const p = t.split(':');
    const total = ((parseInt(p[0], 10) * 60 + parseInt(p[1], 10) + Math.round(n)) % 1440 + 1440) % 1440;
    return pad2(Math.floor(total / 60)) + ':' + pad2(total % 60);
  }

  function normalizeDate(value) {
    if (!value) return null;
    const s = String(value).slice(0, 10);
    return parseYmd(s) ? s : null;
  }

  function capitalize(str) {
    const s = String(str || '');
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  /* ------------------------------------------------------------------ */
  /* 4. LECTURE DU PLANNING (training_sessions + repli schedule)         */
  /* ------------------------------------------------------------------ */
  const DAY_ALIASES = {
    lundi: 1, lun: 1, monday: 1, mon: 1,
    mardi: 2, mar: 2, tuesday: 2, tue: 2,
    mercredi: 3, mer: 3, wednesday: 3, wed: 3,
    jeudi: 4, jeu: 4, thursday: 4, thu: 4,
    vendredi: 5, ven: 5, friday: 5, fri: 5,
    samedi: 6, sam: 6, saturday: 6, sat: 6,
    dimanche: 7, dim: 7, sunday: 7, sun: 7,
    '0': 7, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7
  };

  function normalizeDayKey(key) {
    if (key == null) return null;
    const s = String(key)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '')
      .trim();
    return DAY_ALIASES[s] || null;
  }

  /** Valeurs possibles de `group_type` pour un groupe. */
  function groupTypeCandidates(group) {
    if (!group) return [];
    return unique([group.group_type, group.name, group.label]
      .map(function (v) { return v == null ? '' : String(v).trim(); })
      .filter(Boolean));
  }

  /** Un créneau training_sessions appartient-il à ce groupe ? */
  function trainingMatchesGroup(row, group) {
    if (!row) return false;
    const candidates = groupTypeCandidates(group);
    if (!candidates.length) return true;
    const rowType = row.group_type == null ? '' : String(row.group_type).trim();
    return !rowType || candidates.indexOf(rowType) !== -1;
  }

  function isActiveTrainingRow(row) {
    if (!row) return false;
    if (row.is_active === false || row.is_active === 0) return false;
    if (row.is_active === 'false' || row.is_active === '0') return false;
    return true;
  }

  /**
   * Normalise une valeur de créneau.
   * Accepte : "18:30", "18:30-20:00", { start, end, room, notes, label, type },
   *           ["18:30", "20:00"].
   */
  function parseScheduleValue(value) {
    if (value == null) return null;

    if (typeof value === 'string') {
      const raw = value.trim();
      if (!raw) return null;
      const parts = raw.split(/\s*(?:[-–—]|à|\/)\s*/i);
      const startTime = normalizeTime(parts[0]);
      if (!startTime) return null;
      return {
        startTime: startTime,
        endTime: parts[1] ? normalizeTime(parts[1]) : null,
        room: null,
        notes: null,
        label: null,
        type: null
      };
    }

    if (Array.isArray(value)) {
      const startTime = normalizeTime(value[0]);
      if (!startTime) return null;
      return {
        startTime: startTime,
        endTime: value[1] ? normalizeTime(value[1]) : null,
        room: null,
        notes: null,
        label: null,
        type: null
      };
    }

    if (typeof value === 'object') {
      const startTime = normalizeTime(
        value.start != null ? value.start :
        value.start_time != null ? value.start_time :
        value.startTime != null ? value.startTime :
        value.time != null ? value.time :
        value.horaire != null ? value.horaire : null
      );
      if (!startTime) return null;

      let endTime = normalizeTime(
        value.end != null ? value.end :
        value.end_time != null ? value.end_time :
        value.endTime != null ? value.endTime :
        value.fin != null ? value.fin : null
      );
      if (!endTime && value.duration != null) {
        endTime = addMinutesToTime(startTime, value.duration);
      }

      return {
        startTime: startTime,
        endTime: endTime || null,
        room: value.room || value.salle || value.lieu || value.location || null,
        notes: value.notes || value.note || value.description || value.comment || null,
        label: value.label || value.title || value.titre || null,
        type: value.type || value.kind || null
      };
    }

    return null;
  }

  /**
   * Créneaux récurrents d'un groupe -> [{ dow, startTime, endTime, ... }].
   * Source principale : training_sessions (filtrée par group_type).
   * Repli toléré : groups.schedule pour les anciennes données.
   */
  function extractScheduleEntries(group, trainingRows) {
    const entries = [];

    (Array.isArray(trainingRows) ? trainingRows : []).forEach(function (row) {
      if (!isActiveTrainingRow(row) || !trainingMatchesGroup(row, group)) return;
      const dow = normalizeDayKey(row.day_of_week);
      if (!dow) return;
      const parsed = parseScheduleValue({
        start_time: row.start_time,
        end_time: row.end_time
      });
      if (!parsed) return;

      const item = Object.assign({ dow: dow }, parsed);
      item.type = 'recurring';
      item.groupType = row.group_type || null;
      item.label = item.label || row.group_type || null;
      entries.push(item);
    });

    if (entries.length) return entries;

    const schedule = group && group.schedule;
    if (!schedule) return entries;

    if (Array.isArray(schedule)) {
      schedule.forEach(function (item) {
        if (!item) return;
        let dow = null;
        if (item.day_of_week != null) dow = normalizeDayKey(item.day_of_week);
        else if (item.day != null) dow = normalizeDayKey(item.day);
        else if (item.jour != null) dow = normalizeDayKey(item.jour);
        else if (item.weekday != null) dow = normalizeDayKey(item.weekday);
        if (!dow) return;
        const parsed = parseScheduleValue(item);
        if (parsed) entries.push(Object.assign({ dow: dow }, parsed));
      });
      return entries;
    }

    if (typeof schedule === 'object') {
      Object.keys(schedule).forEach(function (key) {
        const dow = normalizeDayKey(key);
        if (!dow) return;
        const parsed = parseScheduleValue(schedule[key]);
        if (parsed) entries.push(Object.assign({ dow: dow }, parsed));
      });
    }
    return entries;
  }

  /** Séances ponctuelles : lignes de `sessions` (group_id + session_date). */
  function extractExtras(rows) {
    const extras = [];

    (Array.isArray(rows) ? rows : []).forEach(function (row) {
      if (!row || !row.group_id) return;
      const date = normalizeDate(row.session_date);
      const startTime = normalizeTime(row.start_time);
      if (!date || !startTime) return;

      extras.push({
        id: row.id || null,
        date: date,
        startTime: startTime,
        endTime: normalizeTime(row.end_time) || null,
        room: row.room || row.salle || row.lieu || null,
        notes: row.notes || row.note || null,
        label: row.label || row.title || null,
        type: 'extra',
        groupType: row.group_type || null,
        status: row.status || null
      });
    });

    return extras;
  }

  /* ------------------------------------------------------------------ */
  /* 5. CLASSIFICATION / BADGES                                          */
  /* ------------------------------------------------------------------ */
  function classifySession(session) {
    const s = session || {};
    const hay = [s.notes, s.label, s.groupType, s.group_type, s.type]
      .filter(Boolean).join(' ').toLowerCase();

    if (/stage/.test(hay)) {
      return { label: 'Stage', badgeClass: 'badge--stage', kind: 'stage' };
    }
    if (/comp[ée]tition|competition|tournoi|championnat/.test(hay)) {
      return { label: 'Compétition', badgeClass: 'badge--stage', kind: 'competition' };
    }
    if (String(s.type || '').toLowerCase() === 'extra') {
      return { label: 'Séance supplémentaire', badgeClass: 'badge--extra', kind: 'extra' };
    }
    return { label: 'Entraînement', badgeClass: 'badge--recurring', kind: 'recurring' };
  }

  function isFinishedStatus(status) {
    return ['ended', 'completed', 'finished', 'done', 'cancelled']
      .indexOf(String(status || '').toLowerCase()) !== -1;
  }

  /* ------------------------------------------------------------------ */
  /* 6. ANNULATIONS (table sessions)                                     */
  /* ------------------------------------------------------------------ */
  function buildCancelInfo(rows) {
    const exact = new Set();
    const dates = new Set();
    const byKey = new Map();

    (rows || []).forEach(function (row) {
      const gid = row && row.group_id;
      const date = normalizeDate(row && row.session_date);
      if (!gid || !date) return;

      const time = normalizeTime(row.start_time);
      byKey.set(gid + '|' + date + '|' + (time || ''), row);

      const cancelled = String(row.status || '').toLowerCase() === 'cancelled' ||
        row.is_cancelled === true;
      if (cancelled) {
        if (time) exact.add(gid + '|' + date + '|' + time);
        else dates.add(gid + '|' + date);
      }
    });

    return { exact: exact, dates: dates, byKey: byKey };
  }

  function isCancelled(info, gid, date, time) {
    if (!info) return false;
    if (time && info.exact.has(gid + '|' + date + '|' + time)) return true;
    return info.dates.has(gid + '|' + date);
  }

  function getSessionRow(info, gid, date, time) {
    if (!info || !info.byKey) return null;
    return info.byKey.get(gid + '|' + date + '|' + (time || '')) || null;
  }

  /* ------------------------------------------------------------------ */
  /* 7. GÉNÉRATION DES OCCURRENCES                                       */
  /* ------------------------------------------------------------------ */
  function makeSession(o) {
    const cls = classifySession({
      type: o.type,
      notes: o.notes,
      label: o.label,
      groupType: o.groupType
    });
    return {
      id: o.group.id + '|' + o.date + '|' + o.startTime,
      date: o.date,
      dayOfWeek: dayNameFr(o.date),
      startTime: o.startTime,
      endTime: o.endTime || null,
      room: o.room || null,
      type: o.type,
      label: cls.label,
      kind: cls.kind,
      badgeClass: cls.badgeClass,
      notes: o.notes || null,
      groupId: o.group.id,
      groupName: o.group.name || null,
      status: o.status || null
    };
  }

  /**
   * Génère les occurrences d'un groupe entre aujourd'hui et l'horizon.
   * Respecte : start_date / end_date, pauses, annulations, séances ponctuelles.
   */
  function generateOccurrences(group, opts) {
    opts = opts || {};
    const today = opts.today || todayInTz();
    const horizon = opts.horizon || addDaysYmd(today, HORIZON_DAYS);
    const cancelled = opts.cancelled || buildCancelInfo([]);
    const gid = group && group.id;
    if (!gid) return [];

    let from = today;
    const groupStart = normalizeDate(group.start_date);
    if (groupStart && groupStart > from) from = groupStart;

    let to = horizon;
    const groupEnd = normalizeDate(group.end_date);
    if (groupEnd && groupEnd < to) to = groupEnd;
    if (from > to) return [];

    const pauseStart = normalizeDate(group.pause_start_date);
    const pauseEnd = normalizeDate(group.pause_end_date);
    const inPause = function (d) {
      return !!(pauseStart && pauseEnd && d >= pauseStart && d <= pauseEnd);
    };

    const out = [];
    const seen = new Map();

    function push(session) {
      const key = session.date + '|' + session.startTime;
      const prev = seen.get(key);
      if (prev) {
        // Une séance supplémentaire explicite prime sur le créneau récurrent.
        if (prev.type !== 'extra' && session.type === 'extra') {
          const idx = out.indexOf(prev);
          if (idx >= 0) out[idx] = session;
          seen.set(key, session);
        }
        return;
      }
      seen.set(key, session);
      out.push(session);
    }

    // 7.a — Créneaux récurrents (training_sessions, filtrés par group_type)
    const trainingRows = (opts.trainingSessions || []).filter(function (row) {
      return trainingMatchesGroup(row, group);
    });
    const entries = extractScheduleEntries(group, trainingRows);
    for (let d = from; d <= to; d = addDaysYmd(d, 1)) {
      if (inPause(d)) continue;
      const dow = isoDow(d);
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.dow !== dow) continue;
        if (isCancelled(cancelled, gid, d, entry.startTime)) continue;

        const row = getSessionRow(cancelled, gid, d, entry.startTime);
        if (row && isFinishedStatus(row.status) && d <= today) continue;

        push(makeSession({
          group: group,
          date: d,
          startTime: entry.startTime,
          endTime: entry.endTime || (row && normalizeTime(row.end_time)) || null,
          room: entry.room || (row && (row.room || row.salle)) || null,
          type: 'recurring',
          notes: entry.notes,
          label: entry.label,
          groupType: entry.groupType ||
            (row && row.group_type) ||
            (group && group.group_type) ||
            (group && group.name) || null,
          status: row && row.status
        }));
      }
    }

    // 7.b — Séances ponctuelles (table sessions : group_id + session_date)
    extractExtras(opts.extraSessions || []).forEach(function (extra) {
      const d = extra.date;
      if (!d || d < from || d > to) return;
      if (inPause(d)) return;
      if (isCancelled(cancelled, gid, d, extra.startTime)) return;

      const row = getSessionRow(cancelled, gid, d, extra.startTime);
      if (row && isFinishedStatus(row.status) && d <= today) return;

      push(makeSession({
        group: group,
        date: d,
        startTime: extra.startTime,
        endTime: extra.endTime || (row && normalizeTime(row.end_time)) || null,
        room: extra.room || (row && (row.room || row.salle)) || null,
        type: 'extra',
        notes: extra.notes,
        label: extra.label,
        groupType: extra.groupType ||
          (row && row.group_type) ||
          (group && group.group_type) || null,
        status: extra.status || (row && row.status)
      }));
    });

    out.sort(compareSessions);
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* 8. TRI / FILTRAGE / FORMATAGE                                       */
  /* ------------------------------------------------------------------ */
  function dayNameFr(ymd) {
    const d = parseYmd(ymd);
    if (!d) return '';
    return capitalize(new Intl.DateTimeFormat('fr-FR', {
      weekday: 'long',
      timeZone: 'UTC'
    }).format(d));
  }

  function formatLongDateFr(ymd) {
    const d = parseYmd(ymd);
    if (!d) return '';
    return capitalize(new Intl.DateTimeFormat('fr-FR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC'
    }).format(d));
  }

  function formatShortDateFr(ymd) {
    const d = parseYmd(ymd);
    if (!d) return '';
    return capitalize(new Intl.DateTimeFormat('fr-FR', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC'
    }).format(d));
  }

  function relativeDayLabel(ymd, today) {
    const diff = diffDays(ymd, today || todayInTz());
    if (diff == null) return '';
    if (diff === 0) return "Aujourd'hui";
    if (diff === 1) return 'Demain';
    if (diff > 1) return 'Dans ' + diff + ' jours';
    return '';
  }

  function formatTimeRange(session) {
    if (!session || !session.startTime) return '';
    return session.endTime
      ? session.startTime + ' – ' + session.endTime
      : session.startTime;
  }

  function compareSessions(a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.startTime !== b.startTime) return a.startTime < b.startTime ? -1 : 1;
    return String(a.groupName || '').localeCompare(String(b.groupName || ''), 'fr');
  }

  /**
   * Exclut les séances passées :
   *  - une séance d'aujourd'hui dont l'heure de début est passée est ignorée ;
   *  - si une heure de fin existe et que la séance est en cours, elle est gardée.
   */
  function filterUpcoming(sessions, opts) {
    opts = opts || {};
    const today = opts.today || todayInTz();
    const nowMinutes = opts.nowMinutes != null ? opts.nowMinutes : timeInTz();

    return (sessions || []).filter(function (s) {
      if (!s || !s.date) return false;
      if (s.date < today) return false;
      if (s.date > today) return true;

      const start = parseTimeToMinutes(s.startTime);
      if (start == null) return false;
      const end = parseTimeToMinutes(s.endTime);
      if (end != null) return nowMinutes < end;
      return start > nowMinutes;
    });
  }

  function unique(list) {
    const out = [];
    const seen = new Set();
    (list || []).forEach(function (item) {
      if (item == null || seen.has(item)) return;
      seen.add(item);
      out.push(item);
    });
    return out;
  }

  function clamp(value, min, max) {
    const n = Number(value);
    if (!isFinite(n)) return min;
    return Math.min(max, Math.max(min, Math.trunc(n)));
  }

  function escapeHtml(value) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return map[c];
    });
  }

  /* ------------------------------------------------------------------ */
  /* 9. ACCÈS SUPABASE                                                   */
  /* ------------------------------------------------------------------ */
  function resolveClient() {
    if (state.client && typeof state.client.from === 'function') return state.client;
    const cand = (typeof window !== 'undefined')
      ? (window.__supabaseClient || window.supabase)
      : null;
    if (cand && typeof cand.from === 'function') return cand;
    return null;
  }

  async function resolveGroupIds(client, member) {
    const ids = [];
    if (member && member.current_group_id) ids.push(member.current_group_id);
    if (ids.length) return unique(ids);

    try {
      const res = await client
        .from('group_members')
        .select('group_id, start_date, end_date')
        .eq('member_id', member.id)
        .is('end_date', null)
        .order('start_date', { ascending: false });
      if (!res.error && Array.isArray(res.data)) {
        res.data.forEach(function (row) {
          if (row && row.group_id) ids.push(row.group_id);
        });
      }
    } catch (err) {
      console.warn('[upcoming-sessions] group_members', err);
    }
    return unique(ids);
  }

  async function fetchGroups(client, groupIds) {
    if (!groupIds.length) return [];
    try {
      const res = await client.from('groups').select('*').in('id', groupIds);
      if (res.error) throw res.error;
      const rows = res.data || [];
      // Conserver l'ordre de groupIds
      rows.sort(function (a, b) {
        return groupIds.indexOf(a.id) - groupIds.indexOf(b.id);
      });
      return rows;
    } catch (err) {
      console.warn('[upcoming-sessions] groups', err);
      return [];
    }
  }

  async function fetchSessionRows(client, groupIds, from, to) {
    if (!groupIds.length) return [];
    try {
      // select('*') évite toute erreur si is_cancelled / room n'existent pas.
      const res = await client
        .from('sessions')
        .select('*')
        .in('group_id', groupIds)
        .gte('session_date', from)
        .lte('session_date', to);
      if (res.error) throw res.error;
      return res.data || [];
    } catch (err) {
      console.warn('[upcoming-sessions] sessions', err);
      return [];
    }
  }

  /** Créneaux récurrents actifs, indexés par group_type. */
  async function fetchTrainingSessions(client, groupTypes) {
    if (!groupTypes.length) return [];
    try {
      const res = await client
        .from('training_sessions')
        .select('*')
        .in('group_type', groupTypes);
      if (res.error) throw res.error;
      return (res.data || []).filter(isActiveTrainingRow);
    } catch (err) {
      console.warn('[upcoming-sessions] training_sessions', err);
      return [];
    }
  }

  /* ------------------------------------------------------------------ */
  /* 10. FONCTION PRINCIPALE                                             */
  /* ------------------------------------------------------------------ */
  async function getUpcomingSessionsData(memberId, limit, options) {
    options = options || {};
    const client = options.client || resolveClient();
    const id = memberId || state.memberId;
    const max = clamp(limit == null ? state.limit : limit, 1, 100);
    const today = options.today || todayInTz();
    const nowMinutes = options.nowMinutes != null ? options.nowMinutes : timeInTz();
    const horizon = addDaysYmd(today, HORIZON_DAYS);

    if (!client) {
      return { sessions: [], all: [], reason: 'no_client', member: null, groups: [], groupName: null, today: today };
    }
    if (!id) {
      return { sessions: [], all: [], reason: 'no_member', member: null, groups: [], groupName: null, today: today };
    }

    let member = null;
    try {
      const res = await client
        .from('members')
        .select('id, first_name, last_name, current_group_id, club_id')
        .eq('id', id)
        .maybeSingle();
      if (res.error) throw res.error;
      member = res.data;
    } catch (err) {
      console.warn('[upcoming-sessions] members', err);
      return { sessions: [], all: [], reason: 'load_error', member: null, groups: [], groupName: null, today: today };
    }

    if (!member) {
      return { sessions: [], all: [], reason: 'member_not_found', member: null, groups: [], groupName: null, today: today };
    }

    const groupIds = await resolveGroupIds(client, member);
    if (!groupIds.length) {
      return { sessions: [], all: [], reason: 'no_group', member: member, groups: [], groupName: null, today: today };
    }

    const groups = await fetchGroups(client, groupIds);
    if (!groups.length) {
      return { sessions: [], all: [], reason: 'no_group', member: member, groups: [], groupName: null, today: today };
    }

    const groupTypes = unique(groups.reduce(function (acc, group) {
      return acc.concat(groupTypeCandidates(group));
    }, []));

    const [rows, trainingRows] = await Promise.all([
      fetchSessionRows(client, groupIds, today, horizon),
      fetchTrainingSessions(client, groupTypes)
    ]);
    const cancelled = buildCancelInfo(rows);

    let all = [];
    groups.forEach(function (group) {
      all = all.concat(generateOccurrences(group, {
        today: today,
        horizon: horizon,
        cancelled: cancelled,
        extraSessions: rows,
        trainingSessions: trainingRows
      }));
    });

    all = filterUpcoming(all, { today: today, nowMinutes: nowMinutes });
    all.sort(compareSessions);

    // Dédoublonnage final (date + heure + groupe)
    const seen = new Set();
    const deduped = [];
    all.forEach(function (s) {
      const key = s.date + '|' + s.startTime + '|' + s.groupId;
      if (seen.has(key)) return;
      seen.add(key);
      deduped.push(s);
    });

    const groupName = groups.map(function (g) { return g.name; })
      .filter(Boolean).join(' / ') || null;

    return {
      sessions: deduped.slice(0, max),
      all: deduped,
      reason: null,
      member: member,
      groups: groups,
      groupName: groupName,
      today: today
    };
  }

  /** API console : retourne uniquement le tableau des séances. */
  async function getUpcomingSessions(memberId, limit) {
    const data = await getUpcomingSessionsData(memberId, limit);
    if (typeof window !== 'undefined') window.__lastUpcomingSessions = data;
    return data.sessions;
  }

  /* ------------------------------------------------------------------ */
  /* 11. RENDU HTML                                                      */
  /* ------------------------------------------------------------------ */
  function getEl(id) {
    return (typeof document !== 'undefined') ? document.getElementById(id) : null;
  }

  function emptyStateHtml(meta, where) {
    const reason = meta && meta.reason;
    let msg = 'Aucune séance à venir.';

    if (reason === 'no_group') msg = 'Aucun groupe assigné à cet adhérent.';
    else if (reason === 'no_member') msg = 'Aucun identifiant adhérent fourni.';
    else if (reason === 'member_not_found') msg = 'Adhérent introuvable.';
    else if (reason === 'no_client') msg = 'Connexion à la base impossible.';
    else if (reason === 'load_error') msg = 'Erreur de chargement, réessayez.';
    else if (meta && meta.groupName) msg = 'Aucune séance à venir pour le groupe ' + meta.groupName + '.';

    const isError = reason === 'load_error' || reason === 'no_client';
    return '<div class="session-empty' + (isError ? ' session-error' : '') + '" role="status">' +
      '<span class="session-empty__icon" aria-hidden="true">' + (isError ? '⚠️' : '📭') + '</span>' +
      '<p>' + escapeHtml(msg) + '</p>' +
      (isError ? '<button type="button" class="session-retry" data-session-retry>Réessayer</button>' : '') +
      '</div>';
  }

  function renderBadges(session, today) {
    const cls = classifySession(session);
    const parts = ['<span class="badge ' + cls.badgeClass + '">' + escapeHtml(cls.label) + '</span>'];
    const rel = relativeDayLabel(session.date, today);

    if (rel === "Aujourd'hui") {
      parts.push('<span class="badge badge--today">Aujourd\'hui</span>');
    } else if (rel === 'Demain') {
      parts.push('<span class="badge badge--tomorrow">Demain</span>');
    }
    if (String(session.status || '').toLowerCase() === 'cancelled') {
      parts.push('<span class="badge badge--today">Annulée</span>');
    }
    return parts.join('');
  }

  function renderNextSession(session, meta) {
    const body = getEl('nextSessionBody');
    if (!body) return;
    body.setAttribute('aria-busy', 'false');

    const today = (meta && meta.today) || (state.lastData && state.lastData.today) || todayInTz();

    if (!session) {
      body.innerHTML = emptyStateHtml(meta, 'next');
      return;
    }

    const d = parseYmd(session.date);
    if (!d) {
      body.innerHTML = emptyStateHtml(meta, 'next');
      return;
    }

    const weekday = dayNameFr(session.date);
    const dayNum = String(d.getUTCDate());
    const monthYear = capitalize(new Intl.DateTimeFormat('fr-FR', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC'
    }).format(d));
    const rel = relativeDayLabel(session.date, today);
    const isToday = rel === "Aujourd'hui";

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
          (session.room ? '<p class="session-next__room">📍 ' + escapeHtml(session.room) + '</p>' : '') +
          (rel ? '<p class="session-next__countdown">' + escapeHtml(rel) + '</p>' : '') +
        '</div>' +
      '</div>';
  }

  function renderUpcomingList(sessions, meta) {
    const list = getEl('upcomingList');
    if (!list) return;

    const today = (meta && meta.today) || (state.lastData && state.lastData.today) || todayInTz();
    const rows = sessions || [];

    if (!rows.length) {
      list.innerHTML = emptyStateHtml(meta, 'list');
      return;
    }

    const showGroup = !!(meta && meta.groups && meta.groups.length > 1);

    list.innerHTML = '<ul class="session-list" role="list">' + rows.map(function (s) {
      const cls = classifySession(s);
      const rel = relativeDayLabel(s.date, today);
      return '<li class="session-item' + (cls.kind === 'extra' ? ' session-item--extra' : '') +
          '" data-date="' + escapeHtml(s.date) + '" data-type="' + escapeHtml(s.type) + '">' +
        '<div class="session-item__date">' +
          '<strong>' + escapeHtml(formatShortDateFr(s.date)) + '</strong>' +
          (rel ? '<span>' + escapeHtml(rel) + '</span>' : '') +
        '</div>' +
        '<div class="session-item__main">' +
          '<div class="session-item__time">' + escapeHtml(formatTimeRange(s)) + '</div>' +
          (s.room ? '<div class="session-item__room">📍 ' + escapeHtml(s.room) + '</div>' : '') +
          '<div class="session-item__badges">' + renderBadges(s, today) + '</div>' +
        '</div>' +
        (showGroup && s.groupName
          ? '<div class="session-item__group">' + escapeHtml(s.groupName) + '</div>'
          : '') +
      '</li>';
    }).join('') + '</ul>';
  }

  function setListExpanded(expanded) {
    const list = getEl('upcomingList');
    const btn = getEl('toggleUpcomingBtn');
    if (!list || !btn) return;

    list.hidden = !expanded;
    btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    btn.setAttribute('aria-label', expanded
      ? 'Masquer les prochaines séances'
      : 'Voir toutes les prochaines séances');
    btn.textContent = expanded ? 'Masquer' : 'Voir tout';
  }

  function render(data) {
    data = data || { sessions: [], all: [], reason: 'load_error', groups: [], groupName: null };

    const groupEl = getEl('nextSessionGroup');
    if (groupEl) groupEl.textContent = data.groupName || '';

    const memberGroupEl = getEl('memberGroup');
    if (memberGroupEl) {
      memberGroupEl.textContent = data.groupName ||
        (data.reason === 'no_group' ? 'Aucun groupe' : '—');
    }

    renderNextSession((data.sessions && data.sessions[0]) || null, data);
    renderUpcomingList(data.sessions || [], data);

    const nextBody = getEl('nextSessionBody');
    if (nextBody) nextBody.setAttribute('aria-busy', 'false');
  }

  function setLoading() {
    const next = getEl('nextSessionBody');
    const list = getEl('upcomingList');
    if (next) {
      next.setAttribute('aria-busy', 'true');
      next.innerHTML = '<div class="session-skeleton">Chargement…</div>';
    }
    if (list) list.innerHTML = '<div class="session-skeleton">Chargement…</div>';
  }

  /* ------------------------------------------------------------------ */
  /* 12. ÉVÉNEMENTS / CHARGEMENT                                         */
  /* ------------------------------------------------------------------ */
  function bindToggle() {
    if (state.toggleBound || typeof document === 'undefined') return;

    const btn = getEl('toggleUpcomingBtn');
    const list = getEl('upcomingList');
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

    // Délégation : bouton "Réessayer"
    document.addEventListener('click', function (e) {
      const target = e.target;
      if (target && typeof target.closest === 'function' && target.closest('[data-session-retry]')) {
        refresh({ initial: true });
      }
    });

    state.toggleBound = true;
  }

  async function refresh(opts) {
    opts = opts || {};
    if (!state.memberId) {
      render({ sessions: [], all: [], reason: 'no_member', groups: [], groupName: null });
      return;
    }
    if (state.loading) return;

    state.loading = true;
    if (opts.initial) setLoading();

    try {
      const data = await getUpcomingSessionsData(state.memberId, state.limit, {
        client: state.client
      });
      state.lastData = data;
      state.lastLoadedAt = Date.now();
      render(data);
    } catch (err) {
      console.error('[upcoming-sessions] refresh', err);
      render({ sessions: [], all: [], reason: 'load_error', groups: [], groupName: null });
    } finally {
      state.loading = false;
      const body = getEl('nextSessionBody');
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
    const client = options.supabase || options.client || resolveClient();

    if (!client) {
      render({ sessions: [], all: [], reason: 'no_client', groups: [], groupName: null });
      return;
    }

    state.client = client;
    state.memberId = options.memberId || state.memberId || null;
    state.limit = clamp(options.limit == null ? DEFAULT_LIMIT : options.limit, 1, 100);

    bindToggle();
    await refresh({ initial: true });
    startAutoRefresh();
  }

  /* ------------------------------------------------------------------ */
  /* 13. EXPORTS / INTERNALS (tests)                                     */
  /* ------------------------------------------------------------------ */
  const _internals = {
    CLUB_TZ: CLUB_TZ,
    DAY_KEYS: DAY_KEYS,
    DEFAULT_LIMIT: DEFAULT_LIMIT,
    HORIZON_DAYS: HORIZON_DAYS,
    pad2: pad2,
    normalizeTime: normalizeTime,
    parseScheduleValue: parseScheduleValue,
    addMinutesToTime: addMinutesToTime,
    normalizeDayKey: normalizeDayKey,
    isoDow: isoDow,
    parseYmd: parseYmd,
    ymdOf: ymdOf,
    addDaysYmd: addDaysYmd,
    diffDays: diffDays,
    todayInTz: todayInTz,
    timeInTz: timeInTz,
    parseTimeToMinutes: parseTimeToMinutes,
    groupTypeCandidates: groupTypeCandidates,
    trainingMatchesGroup: trainingMatchesGroup,
    isActiveTrainingRow: isActiveTrainingRow,
    extractScheduleEntries: extractScheduleEntries,
    extractExtras: extractExtras,
    generateOccurrences: generateOccurrences,
    buildCancelInfo: buildCancelInfo,
    isCancelled: isCancelled,
    getSessionRow: getSessionRow,
    filterUpcoming: filterUpcoming,
    compareSessions: compareSessions,
    classifySession: classifySession,
    dayNameFr: dayNameFr,
    formatLongDateFr: formatLongDateFr,
    formatShortDateFr: formatShortDateFr,
    relativeDayLabel: relativeDayLabel,
    formatTimeRange: formatTimeRange,
    escapeHtml: escapeHtml,
    clamp: clamp,
    unique: unique
  };

  const api = {
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

  // Alias globaux pratiques (console F12)
  if (global) {
    global.getUpcomingSessions = getUpcomingSessions;
    global.getUpcomingSessionsData = getUpcomingSessionsData;
    global.renderNextSession = renderNextSession;
    global.renderUpcomingList = renderUpcomingList;
  }

  return api;
});
