/* ==========================================================================
   Tests unitaires — js/upcoming-sessions.js
   Exécution : node --test tests/upcoming-sessions.test.js
   ========================================================================== */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../js/upcoming-sessions.js');
const H = api._internals;

test('normalizeTime accepte les formats Supabase', () => {
  assert.equal(H.normalizeTime('18:30'), '18:30');
  assert.equal(H.normalizeTime('18:30:00'), '18:30');
  assert.equal(H.normalizeTime('8:05'), '08:05');
  assert.equal(H.normalizeTime('24:00'), null);
  assert.equal(H.normalizeTime(''), null);
});

test('parseScheduleValue : chaîne simple, plage et objet', () => {
  assert.deepEqual(H.parseScheduleValue('18:30'), {
    startTime: '18:30', endTime: null, room: null, notes: null, label: null, type: null
  });

  const range = H.parseScheduleValue('18:30 - 20:00');
  assert.equal(range.startTime, '18:30');
  assert.equal(range.endTime, '20:00');

  const obj = H.parseScheduleValue({
    start: '18:30', end: '20:00', room: 'Salle A', notes: 'Stage', type: 'extra'
  });
  assert.equal(obj.startTime, '18:30');
  assert.equal(obj.endTime, '20:00');
  assert.equal(obj.room, 'Salle A');
  assert.equal(obj.notes, 'Stage');
  assert.equal(obj.type, 'extra');

  const dur = H.parseScheduleValue({ start: '18:30', duration: 90 });
  assert.equal(dur.endTime, '20:00');
});

test('addMinutesToTime gère le passage de minuit', () => {
  assert.equal(H.addMinutesToTime('18:30', 90), '20:00');
  assert.equal(H.addMinutesToTime('23:30', 60), '00:30');
});

test('normalizeDayKey : français, accents, majuscules, anglais, numéros', () => {
  assert.equal(H.normalizeDayKey('Vendredi'), 5);
  assert.equal(H.normalizeDayKey('Mardi'), 2);
  assert.equal(H.normalizeDayKey('DIMANCHE'), 7);
  assert.equal(H.normalizeDayKey('friday'), 5);
  assert.equal(H.normalizeDayKey(1), 1);
  assert.equal(H.normalizeDayKey(0), 7);
  assert.equal(H.normalizeDayKey('inconnu'), null);
});

test('extractScheduleEntries lit groups.schedule (JSONB réel)', () => {
  const entries = H.extractScheduleEntries({
    schedule: { mardi: '18:30', vendredi: '18:30', Dimanche: '10:00' }
  });
  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map(e => [e.dow, e.startTime]).sort((a, b) => a[0] - b[0]),
    [[2, '18:30'], [5, '18:30'], [7, '10:00']]
  );
});

test('extractExtras lit groups.extra_sessions (objet et chaîne)', () => {
  const extras = H.extractExtras({
    extra_sessions: [
      { date: '2026-11-21', time: '10:00', notes: 'Stage' },
      '2026-12-05 09:30',
      { date: '2026-12-12', start_time: '14:00:00', end_time: '16:00:00', room: 'Salle B' }
    ]
  });
  assert.equal(extras.length, 3);
  assert.equal(extras[0].date, '2026-11-21');
  assert.equal(extras[0].startTime, '10:00');
  assert.equal(extras[1].date, '2026-12-05');
  assert.equal(extras[1].startTime, '09:30');
  assert.equal(extras[2].endTime, '16:00');
  assert.equal(extras[2].room, 'Salle B');
});

test('generateOccurrences : récurrent + extra, triés', () => {
  const group = {
    id: 'g1',
    name: 'Adultes',
    start_date: '2026-09-01',
    end_date: '2027-08-01',
    schedule: { vendredi: '18:30', dimanche: '18:30' },
    extra_sessions: [{ date: '2026-11-21', time: '10:00', notes: 'Stage' }]
  };

  const out = H.generateOccurrences(group, {
    today: '2026-11-20',
    horizon: '2026-12-20',
    cancelled: H.buildCancelInfo([])
  });

  assert.deepEqual(out.slice(0, 3).map(s => [s.date, s.startTime, s.type]), [
    ['2026-11-20', '18:30', 'recurring'],
    ['2026-11-21', '10:00', 'extra'],
    ['2026-11-22', '18:30', 'recurring']
  ]);
  // 5 vendredis + 5 dimanches + 1 extra sur la période
  assert.equal(out.length, 11);
});

test('generateOccurrences exclut les séances annulées (status=cancelled)', () => {
  const group = {
    id: 'g1',
    name: 'Adultes',
    start_date: '2026-09-01',
    schedule: { vendredi: '18:30', dimanche: '18:30' }
  };
  const cancelled = H.buildCancelInfo([
    { group_id: 'g1', session_date: '2026-11-22', start_time: '18:30:00', status: 'cancelled' }
  ]);

  const out = H.generateOccurrences(group, {
    today: '2026-11-20',
    horizon: '2026-12-20',
    cancelled
  });

  assert.equal(out.some(s => s.date === '2026-11-22'), false);
  assert.equal(out.some(s => s.date === '2026-11-20'), true);
});

test('generateOccurrences respecte les pauses du groupe', () => {
  const group = {
    id: 'g1',
    name: 'Adultes',
    start_date: '2026-09-01',
    pause_start_date: '2026-11-22',
    pause_end_date: '2026-11-24',
    schedule: { dimanche: '18:30' }
  };

  const out = H.generateOccurrences(group, {
    today: '2026-11-20',
    horizon: '2026-12-20',
    cancelled: H.buildCancelInfo([])
  });

  assert.equal(out.some(s => s.date === '2026-11-22'), false);
  assert.equal(out.some(s => s.date === '2026-11-29'), true);
});

test('generateOccurrences : extra prioritaire si même date + heure', () => {
  const group = {
    id: 'g1',
    name: 'Adultes',
    start_date: '2026-09-01',
    schedule: { vendredi: '18:30' },
    extra_sessions: [{ date: '2026-11-20', time: '18:30', notes: 'Séance spéciale' }]
  };

  const out = H.generateOccurrences(group, {
    today: '2026-11-20',
    horizon: '2026-11-21',
    cancelled: H.buildCancelInfo([])
  });

  const same = out.filter(s => s.date === '2026-11-20');
  assert.equal(same.length, 1);
  assert.equal(same[0].type, 'extra');
});

test('generateOccurrences : deux séances le même jour si heures différentes', () => {
  const group = {
    id: 'g1',
    name: 'Adultes',
    start_date: '2026-09-01',
    schedule: { vendredi: '18:30' },
    extra_sessions: [{ date: '2026-11-20', time: '10:00' }]
  };

  const out = H.generateOccurrences(group, {
    today: '2026-11-20',
    horizon: '2026-11-20',
    cancelled: H.buildCancelInfo([])
  });

  assert.equal(out.length, 2);
  assert.deepEqual(out.map(s => s.startTime).sort(), ['10:00', '18:30']);
});

test('generateOccurrences respecte start_date / end_date', () => {
  const group = {
    id: 'g1',
    name: 'Adultes',
    start_date: '2026-12-01',
    end_date: '2026-12-10',
    schedule: { vendredi: '18:30' }
  };

  const out = H.generateOccurrences(group, {
    today: '2026-11-20',
    horizon: '2027-01-31',
    cancelled: H.buildCancelInfo([])
  });

  assert.deepEqual(out.map(s => s.date), ['2026-12-04', '2026-12-11'].filter(d => d <= '2026-12-10'));
});

test('filterUpcoming exclut les séances déjà passées aujourd’hui', () => {
  const sessions = [
    { date: '2026-11-20', startTime: '18:30', endTime: null },
    { date: '2026-11-22', startTime: '18:30', endTime: null }
  ];

  const after = H.filterUpcoming(sessions, { today: '2026-11-20', nowMinutes: 19 * 60 });
  assert.deepEqual(after.map(s => s.date), ['2026-11-22']);

  const before = H.filterUpcoming(sessions, { today: '2026-11-20', nowMinutes: 18 * 60 });
  assert.deepEqual(before.map(s => s.date), ['2026-11-20', '2026-11-22']);
});

test('filterUpcoming garde une séance en cours si end_time est connue', () => {
  const sessions = [
    { date: '2026-11-20', startTime: '18:30', endTime: '20:00' }
  ];
  const out = H.filterUpcoming(sessions, { today: '2026-11-20', nowMinutes: 19 * 60 });
  assert.equal(out.length, 1);
});

test('timezone Africa/Algiers (UTC+1)', () => {
  assert.equal(H.todayInTz(new Date('2026-11-20T23:30:00Z')), '2026-11-21');
  assert.equal(H.timeInTz(new Date('2026-11-20T17:30:00Z')), 18 * 60 + 30);
});

test('formatage français des dates', () => {
  assert.equal(H.formatLongDateFr('2026-11-21'), 'Samedi 21 novembre 2026');
  assert.equal(H.dayNameFr('2026-11-21'), 'Samedi');
  assert.equal(H.relativeDayLabel('2026-11-20', '2026-11-20'), "Aujourd'hui");
  assert.equal(H.relativeDayLabel('2026-11-21', '2026-11-20'), 'Demain');
  assert.equal(H.relativeDayLabel('2026-11-22', '2026-11-20'), 'Dans 2 jours');
});

test('classifySession : badges entraînement / extra / stage / compétition', () => {
  assert.equal(H.classifySession({ type: 'recurring' }).label, 'Entraînement');
  assert.equal(H.classifySession({ type: 'extra' }).label, 'Séance supplémentaire');
  assert.equal(H.classifySession({ type: 'extra' }).badgeClass, 'badge--extra');
  assert.equal(H.classifySession({ type: 'extra', notes: 'Stage technique' }).label, 'Stage');
  assert.equal(H.classifySession({ type: 'extra', notes: 'Compétition inter-clubs' }).label, 'Compétition');
});

test('escapeHtml neutralise les balises', () => {
  assert.equal(H.escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
});
