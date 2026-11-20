/* ==========================================================================
   Tests unitaires — js/next-sessions.js
   Exécution : node --test tests/next-sessions.test.js
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../js/next-sessions.js');
const H = api._internals;

/* ------------------------------------------------------------------------ */
/* Client Supabase simulé                                                    */
/* ------------------------------------------------------------------------ */
function makeClient(store) {
  const calls = [];
  const client = {
    calls,
    from(table) {
      const filters = {};
      const q = {
        select() { return q; },
        eq(key, value) { filters[key] = value; return q; },
        gte(key, value) { filters[key] = value; return q; },
        neq(key, value) { filters[key] = value; return q; },
        order() { return q; },
        single() {
          calls.push({ table, filters, single: true });
          return Promise.resolve(answer(table, filters, true));
        },
        maybeSingle() {
          calls.push({ table, filters, single: false });
          return Promise.resolve(answer(table, filters, false));
        },
        then(resolve, reject) {
          calls.push({ table, filters, single: false });
          return Promise.resolve(answer(table, filters, false)).then(resolve, reject);
        }
      };
      return q;
    }
  };

  function answer(table, filters, single) {
    const entry = store[table];
    if (entry == null) return { data: single ? null : [], error: null };
    if (typeof entry === 'function') return entry(filters, single);
    if (Object.prototype.hasOwnProperty.call(entry, 'data') ||
        Object.prototype.hasOwnProperty.call(entry, 'error')) return entry;
    return { data: single ? entry : (Array.isArray(entry) ? entry : [entry]), error: null };
  }

  return client;
}

const MEMBER = {
  id: 'KYO001',
  first_name: 'Amine',
  last_name: 'Bouzid',
  current_group_id: 'group-1',
  club_id: 'club-1',
  groups: { id: 'group-1', name: 'Adultes', is_active: true }
};

const SLOTS = [
  { id: 't1', group_type: 'Adultes', day_of_week: 5, start_time: '18:30', end_time: '20:00', coach: 'Coach Karim' },
  { id: 't2', group_type: 'Adultes', day_of_week: 1, start_time: '10:00', end_time: '11:00', coach: null },
  { id: 't3', group_type: 'Adultes', day_of_week: 7, start_time: '09:00', end_time: '10:00', coach: 'Coach Karim' }
];

/* ------------------------------------------------------------------------ */
/* Utilitaires                                                               */
/* ------------------------------------------------------------------------ */
test('todayInTz / minutesInTz utilisent Africa/Algiers (UTC+1)', () => {
  const instant = new Date('2026-11-20T23:30:00Z'); // 00:30 le 21 nov. à Alger
  assert.equal(H.todayInTz(instant), '2026-11-21');
  assert.equal(H.minutesInTz(instant), 30);
});

test('isoDow : 1 = lundi … 7 = dimanche', () => {
  assert.equal(H.isoDow('2026-11-20'), 5); // vendredi
  assert.equal(H.isoDow('2026-11-22'), 7); // dimanche
  assert.equal(H.isoDow('2026-11-23'), 1); // lundi
});

test('parseTime / normalizeTime / formatDateISO', () => {
  assert.deepEqual(H.parseTime('18:30:00'), { h: 18, m: 30 });
  assert.equal(H.normalizeTime('8:05'), '08:05');
  assert.equal(H.normalizeTime('25:00'), null);
  assert.equal(H.formatDateISO('2026-11-20T00:00:00'), '2026-11-20');
  assert.equal(H.addDays('2026-11-30', 1), '2026-12-01');
});

test('formatDayOfWeek et libellés relatifs en français', () => {
  assert.equal(H.formatDayOfWeek('2026-11-22'), 'Dimanche');
  assert.equal(H.relativeDayLabel('2026-11-20', '2026-11-20'), "Aujourd'hui");
  assert.equal(H.relativeDayLabel('2026-11-21', '2026-11-20'), 'Demain');
});

test('compareSessions trie par date puis heure', () => {
  const rows = [
    { date: '2026-11-22', startTime: '10:00', type: 'recurring' },
    { date: '2026-11-20', startTime: '18:30', type: 'recurring' },
    { date: '2026-11-22', startTime: '09:00', type: 'extra' }
  ].sort(H.compareSessions);
  assert.deepEqual(rows.map(r => r.date + '|' + r.startTime), [
    '2026-11-20|18:30',
    '2026-11-22|09:00',
    '2026-11-22|10:00'
  ]);
});

/* ------------------------------------------------------------------------ */
/* Cas limites                                                               */
/* ------------------------------------------------------------------------ */
test('getUpcomingSessions : client absent', async () => {
  const data = await api.getUpcomingSessions('KYO001', 10, { client: null });
  assert.deepEqual(data.sessions, []);
  assert.equal(data.message, 'Connexion à la base impossible.');
  assert.equal(data.reason, 'no_client');
});

test('getUpcomingSessions : adhérent introuvable', async () => {
  const client = makeClient({ members: { data: null, error: { message: 'not found' } } });
  const data = await api.getUpcomingSessions('KYO001', 10, { client });
  assert.equal(data.message, 'Adhérent introuvable');
  assert.equal(data.reason, 'member_not_found');
});

test('getUpcomingSessions : adhérent sans groupe', async () => {
  const member = Object.assign({}, MEMBER, { current_group_id: null, groups: null });
  const client = makeClient({ members: member });
  const data = await api.getUpcomingSessions('KYO001', 10, { client });
  assert.equal(data.message, 'Aucun groupe assigné');
  assert.equal(data.reason, 'no_group');
});

test('getUpcomingSessions : groupe inactif', async () => {
  const member = Object.assign({}, MEMBER, {
    groups: { id: 'group-1', name: 'Adultes', is_active: false }
  });
  const client = makeClient({ members: member });
  const data = await api.getUpcomingSessions('KYO001', 10, { client });
  assert.equal(data.message, 'Groupe inactif');
  assert.equal(data.reason, 'inactive_group');
});

test('getUpcomingSessions : planning vide et aucune séance ponctuelle', async () => {
  const client = makeClient({ members: MEMBER, training_sessions: [], sessions: [] });
  const data = await api.getUpcomingSessions('KYO001', 10, { client });
  assert.deepEqual(data.sessions, []);
  assert.equal(data.message, 'Aucun créneau défini pour ce groupe');
  assert.equal(data.reason, 'no_slots');
});

test('getUpcomingSessions : planning vide mais séance ponctuelle existante', async () => {
  const client = makeClient({
    members: MEMBER,
    training_sessions: [],
    sessions: [{
      id: 's1', session_date: '2026-11-21', start_time: '10:00:00',
      end_time: '12:00:00', status: 'waiting', group_type: 'Stage'
    }]
  });
  const data = await api.getUpcomingSessions('KYO001', 10, { client });
  assert.equal(data.message, null);
  assert.equal(data.sessions.length, 1);
  assert.equal(data.sessions[0].type, 'extra');
  assert.equal(data.sessions[0].startTime, '10:00');
  assert.equal(data.sessions[0].notes, 'Stage');
});

/* ------------------------------------------------------------------------ */
/* Calcul à la volée                                                         */
/* ------------------------------------------------------------------------ */
test('getUpcomingSessions : occurrences récurrentes, créneau terminé ignoré', async () => {
  const client = makeClient({
    members: MEMBER,
    training_sessions: SLOTS,
    sessions: []
  });
  // 20:30 à Alger : le créneau vendredi 18:30–20:00 est terminé.
  const now = new Date('2026-11-20T19:30:00Z');
  const data = await api.getUpcomingSessions('KYO001', 10, { client, now });

  assert.equal(data.message, null);
  assert.equal(data.sessions.length, 10);
  assert.equal(data.sessions[0].date, '2026-11-22');
  assert.equal(data.sessions[0].dayOfWeek, 'Dimanche');
  assert.equal(data.sessions[0].coach, 'Coach Karim');
  assert.equal(data.sessions[0].type, 'recurring');
  assert.ok(!data.sessions.some(s => s.date === '2026-11-20'));
  assert.ok(data.sessions.some(s => s.date === '2026-11-27'));

  const calls = client.calls.map(c => c.table);
  assert.deepEqual([...new Set(calls)].sort(), ['members', 'sessions', 'training_sessions']);
});

test('matchingTrainingRows accepte group_id ou group_type selon le schéma', () => {
  const group = { id: 'group-1', name: 'Adultes', is_active: true };
  const rows = [
    { id: 'a', group_id: 'group-1' },
    { id: 'b', group_type: 'Adultes' },
    { id: 'c', group_id: 'group-2' },
    { id: 'd', group_type: 'Enfants' },
    { id: 'e', group_type: 'Adultes', is_active: false }
  ];
  assert.deepEqual(H.matchingTrainingRows(rows, group, MEMBER).map(r => r.id), ['a', 'b']);
});

test('getUpcomingSessions : séances ponctuelles triées et dédupliquées', async () => {
  const client = makeClient({
    members: MEMBER,
    training_sessions: [
      { id: 't7', group_type: 'Adultes', day_of_week: 7, start_time: '09:00', end_time: '10:00', coach: null }
    ],
    sessions: [
      {
        id: 's1', session_date: '2026-11-21', start_time: '10:00:00',
        end_time: null, status: 'waiting', group_type: null
      },
      {
        id: 's2', session_date: '2026-11-22', start_time: '09:00:00',
        end_time: null, status: 'waiting', group_type: null
      }
    ]
  });
  const now = new Date('2026-11-20T19:30:00Z');
  const data = await api.getUpcomingSessions('KYO001', 4, { client, now });

  assert.equal(data.sessions.length, 4);
  assert.equal(data.sessions[0].date, '2026-11-21');
  assert.equal(data.sessions[0].type, 'extra');
  assert.equal(data.sessions[1].date, '2026-11-22');
  assert.equal(data.sessions[1].type, 'extra'); // manuelle prioritaire
  assert.ok(!data.sessions.some(s => s.date === '2026-11-22' && s.type === 'recurring'));
});

test('getUpcomingSessions : erreur de planning', async () => {
  const client = makeClient({
    members: MEMBER,
    training_sessions: { data: null, error: { message: 'RPC manquante' } }
  });
  const data = await api.getUpcomingSessions('KYO001', 10, { client });
  assert.equal(data.message, 'Erreur planning');
  assert.equal(data.reason, 'planning_error');
});

/* ------------------------------------------------------------------------ */
/* Compatibilité                                                             */
/* ------------------------------------------------------------------------ */
test('API publique conservée (alias UpcomingSessions et globals)', () => {
  assert.equal(typeof api.getUpcomingSessions, 'function');
  assert.equal(typeof api.getUpcomingSessionsData, 'function');
  assert.equal(typeof api.init, 'function');
  assert.equal(typeof api.refresh, 'function');
  assert.equal(typeof api.renderNextSession, 'function');
  assert.equal(typeof api.renderUpcomingList, 'function');
  assert.equal(typeof api.setListExpanded, 'function');
  assert.equal(global.getUpcomingSessions, api.getUpcomingSessions);
  assert.equal(global.UpcomingSessions, api);
});

test('escapeHtml neutralise le HTML', () => {
  assert.equal(H.escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
});
