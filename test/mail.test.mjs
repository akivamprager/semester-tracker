import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mailCourse, mailInboxUpdates } from '../mail.js';

const sem = JSON.parse(readFileSync(new URL('../semesters/2027A.json', import.meta.url)));
const now = new Date('2026-10-15T12:00:00Z');
const mail = { messages: [
  { id: 'a', from: 'noreply@moodle.huji.ac.il', subject: '83335 מבוא להנדסת חשמל: שינוי חדר הרצאה', date: '2026-10-15T08:00:00Z', text: 'באולם קפלן' },
  { id: 'b', from: 'do_not_reply@savion.huji.ac.il', subject: 'חוות המחשבים סגורה', date: '2026-10-15T09:00:00Z', text: 'בשל בחינה' },
  { id: 'c', from: 'estii@savion.huji.ac.il', subject: 'עדכון לגבי מבני נתונים', date: '2026-10-10T09:00:00Z', text: '' },
] };

test('mailCourse: by course number, else by name in the subject', () => {
  assert.equal(mailCourse(sem, mail.messages[0]), '83335');
  assert.equal(mailCourse(sem, mail.messages[1]), '');
  assert.equal(mailCourse(sem, mail.messages[2]), '67109');
});

test('mailInboxUpdates: Moodle/course mail is unread + push (if recent); general mail quiet; no repeats', () => {
  const { updates, notify } = mailInboxUpdates(sem, mail, {}, now);
  const d = (id) => updates[`2027A/inbox/mail-${id}`].d;
  assert.equal(d('a').read, false);
  assert.equal(d('a').icon, '📢');
  assert.equal(d('b').read, true);
  assert.equal(d('c').read, false);
  assert.deepEqual(notify.map((n) => n.course), ['83335']); // c is 5 days old: listed, no push
  const again = mailInboxUpdates(sem, mail, updates, now);
  assert.equal(Object.keys(again.updates).length, 0);
});
