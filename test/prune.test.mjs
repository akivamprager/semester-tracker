import test from 'node:test';
import assert from 'node:assert/strict';
import { merge } from '../sync.js';
import { keepPlausible, diffShnaton } from '../shnaton.js';

const day = 864e5;
const NOW = Date.parse('2026-11-09T12:00:00Z');
const inbox = (daysAgo, extra = {}) => ({ s: 'set', t: NOW - daysAgo * day, d: { at: new Date(NOW - daysAgo * day).toISOString(), text: 'x', ...extra } });

test('merge drops cleared notifications after two weeks, keeps everything else', () => {
  const a = {
    '2027A/inbox/old-hidden': inbox(20, { hidden: true, read: true }),
    '2027A/inbox/new-hidden': inbox(3, { hidden: true, read: true }),
    '2027A/inbox/old-unread': inbox(20),
    '2027A/80430/lecture/1': { s: 'done', t: NOW - 60 * day },
  };
  const out = merge(a, {}, NOW);
  assert.deepEqual(Object.keys(out).sort(), ['2027A/80430/lecture/1', '2027A/inbox/new-hidden', '2027A/inbox/old-unread']);
  // another copy that still has it doesn't bring it back
  assert.ok(!('2027A/inbox/old-hidden' in merge(out, a, NOW)));
});

test('Shnaton: a course that comes back without its sessions keeps the old snapshot', () => {
  const group = (slots, dates) => ({ type: 'recitation', teachers: ['א'], slots, dates });
  const prev = {
    67315: { '2-01': group(['2|12:00|13:45|C220'], { '2026-11-10': '', '2026-11-17': '' }) },
    80430: { '1-01': group(['1|10:00|11:45|קפלן'], { '2026-11-09': '' }) },
  };
  const next = {
    67315: { '2-01': { type: 'recitation', teachers: [], slots: [], dates: {} } }, // the glitch
    80430: { '1-01': group(['1|10:00|11:45|ברגמן'], { '2026-11-09': '' }) }, // a real room change
  };
  const { snap, skipped } = keepPlausible(prev, next);
  assert.deepEqual(skipped, ['67315']);
  const changes = diffShnaton(prev, snap, '2026-11-09', { 67315: 'C', 80430: 'הסתברות' });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].course, '80430');
  // first run (no previous snapshot): nothing skipped
  assert.deepEqual(keepPlausible(null, next).skipped, []);
});
