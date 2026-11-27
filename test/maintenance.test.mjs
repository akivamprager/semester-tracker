import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maintenanceNotices, activeNotices, noticesToPush, parseGithubExpiry, MAINT_SNOOZE_KEY } from '../maintenance.js';

const sem = { id: '2027A', name: 'סמסטר א׳', start: '2026-10-11', end: '2027-01-15' };
const index = { default: '2027A', semesters: [{ id: '2027A', name: 'סמסטר א׳' }] };
const ids = (list) => list.map((n) => n.id.split('/')[0]);
const at = (d) => new Date(d);

test('nothing to do mid-semester with everything running', () => {
  const now = at('2026-11-26T12:00');
  const progress = {
    'status/moodle': { d: { at: '2026-11-26T10:37:00' } },
    'status/mail': { d: { at: '2026-11-26T09:00:00' } },
    'status/tokens': { d: { job: null, scriptGist: '2027-06-01 00:00:00 UTC' } },
    'status/repo': { d: { lastCommit: '2026-11-20T10:00:00Z' } },
    'status/morning': { d: { devices: 2 } },
  };
  assert.deepEqual(maintenanceNotices(sem, index, progress, now), []);
});

test('next semester: from 3 weeks before classes end, until it is added', () => {
  assert.deepEqual(ids(maintenanceNotices(sem, index, {}, at('2026-12-20T12:00'))), []);
  assert.deepEqual(ids(maintenanceNotices(sem, index, {}, at('2026-12-26T12:00'))), ['next-semester']);
  const withB = { default: '2027A', semesters: [...index.semesters, { id: '2027B', name: 'סמסטר ב׳', start: '2027-03-07' }] };
  assert.deepEqual(ids(maintenanceNotices(sem, withB, {}, at('2026-12-26T12:00'))), []);
  // the new one starts and the default is still the old one
  assert.deepEqual(ids(maintenanceNotices(sem, withB, {}, at('2027-03-05T12:00'))), ['switch-semester']);
  assert.deepEqual(ids(maintenanceNotices(sem, { ...withB, default: '2027B' }, {}, at('2027-03-05T12:00'))), []);
});

test('tokens: warned 3 weeks ahead, and after expiry', () => {
  const p = (exp) => ({ 'status/tokens': { d: { job: exp } } });
  const now = at('2026-11-26T12:00');
  assert.deepEqual(ids(maintenanceNotices(sem, index, p('2027-01-01 00:00:00 UTC'), now)), []);
  const soon = maintenanceNotices(sem, index, p('2026-12-10 08:00:00 UTC'), now);
  assert.deepEqual(ids(soon), ['token']);
  assert.match(soon[0].title, /בעוד 14 ימים/);
  assert.match(maintenanceNotices(sem, index, p('2026-11-20 08:00:00 UTC'), now)[0].title, /פג ב-20\.11/);
  assert.equal(parseGithubExpiry('2027-01-15 08:00:00 UTC').toISOString(), '2027-01-15T08:00:00.000Z');
});

test('stopped job, failing Moodle link, idle repo, expired Panopto, stalled script, no devices', () => {
  const now = at('2026-11-26T12:00');
  assert.deepEqual(ids(maintenanceNotices(sem, index, { 'status/moodle': { d: { at: '2026-11-24T10:00:00' } } }, now)), ['job-stopped']);
  assert.deepEqual(ids(maintenanceNotices(sem, index, { 'status/moodle': { d: { at: '2026-11-26T08:00:00', error: 'failed', errorAt: '2026-11-26T10:00:00' } } }, now)), ['moodle-link']);
  assert.deepEqual(ids(maintenanceNotices(sem, index, { 'status/repo': { d: { lastCommit: '2026-10-01T10:00:00Z' } } }, now)), ['repo-idle']);
  assert.deepEqual(ids(maintenanceNotices(sem, index, { 'status/repo': { d: { lastCommit: '2026-10-20T10:00:00Z' } } }, now)), []);
  assert.deepEqual(ids(maintenanceNotices(sem, index, { 'status/panopto': { d: { at: '2026-11-20T10:00:00', error: 'expired', errorAt: '2026-11-26T10:00:00' } } }, now)), ['panopto-login']);
  assert.deepEqual(ids(maintenanceNotices(sem, index, { 'status/mail': { d: { at: '2026-11-25T08:00:00' } } }, now)), ['script-stopped']);
  assert.deepEqual(ids(maintenanceNotices(sem, index, { 'status/morning': { d: { devices: 0 } } }, now)), ['no-devices']);
});

test('snooze hides a notice for a week; pushes go out once, then weekly', () => {
  const now = at('2026-12-26T12:00');
  const list = maintenanceNotices(sem, index, {}, now);
  const id = list[0].id;
  assert.equal(activeNotices(list, { [MAINT_SNOOZE_KEY]: { d: { [id]: '2027-01-02T12:00:00Z' } } }, now).length, 0);
  assert.equal(activeNotices(list, { [MAINT_SNOOZE_KEY]: { d: { [id]: '2026-12-20T12:00:00Z' } } }, now).length, 1);
  assert.equal(noticesToPush(list, {}, now).length, 1);
  assert.equal(noticesToPush(list, { [id]: '2026-12-24T12:00:00' }, now).length, 0);
  assert.equal(noticesToPush(list, { [id]: '2026-12-19T12:00:00' }, now).length, 1);
});
