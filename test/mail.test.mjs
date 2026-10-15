import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mailCourse, mailBody, mailInboxUpdates } from '../mail.js';

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

test('mailBody: Moodle forum mail → post only, unwrapped, with the post link', () => {
  const text = [
    '83335-מבוא להנדסת חשמל -> פורומים -> Announcements ->',
    'שינוי חדר הרצאה',
    'https://moodle.huji.ac.il/2026-27/mod/forum/discuss.php?d=3296#p4173',
    'על ידי ירדן ישנו בתאריך יום רביעי, 14',
    '-'.repeat(69),
    'שלום,', '',
    'למען נוחיותכם, החל משבוע הבא ההרצאה',
    'תתקיים באולם קפלן.',
    '-'.repeat(69),
    'זהו העתק של הודעה שפורסמה באתר',
  ].join('\n');
  const { body, link } = mailBody({ from: 'noreply@moodle.huji.ac.il', text });
  assert.equal(body, 'שלום,\n\nלמען נוחיותכם, החל משבוע הבא ההרצאה תתקיים באולם קפלן.');
  assert.equal(link, 'https://moodle.huji.ac.il/2026-27/mod/forum/discuss.php?d=3296#p4173');
});

test('mailInboxUpdates: noise hidden, course prefix dropped, outdated entries rebuilt keeping read', () => {
  const m = { messages: [
    { id: 'n', from: 'noreply@moodle.huji.ac.il', subject: 'כניסה חדשה לחשבון אתרי הלמידה', date: '2026-10-15T08:00:00Z', text: 'IP' },
    { id: 'o', from: 'noreply@moodle.huji.ac.il', subject: '80154-אלגברה ליניארית: מתעכב', date: '2026-10-15T08:00:00Z', text: '' },
    { id: 'k', from: 'noreply@moodle.huji.ac.il', subject: '83335-מבוא להנדסת חשמל: שינוי חדר הרצאה', date: '2026-10-15T08:00:00Z', text: '' },
  ] };
  const old = { '2027A/inbox/mail-k': { s: 'set', t: 1, d: { kind: 'mail', text: 'x', read: true } } };
  const { updates, notify } = mailInboxUpdates(sem, m, old, now);
  const d = (id) => updates[`2027A/inbox/mail-${id}`].d;
  assert.equal(d('n').hidden, true);
  assert.equal(d('o').read, true); // last year's course: quiet
  assert.equal(d('k').text, 'שינוי חדר הרצאה');
  assert.equal(d('k').read, true); // was read before the rebuild
  assert.deepEqual(notify, []); // rebuilt ≠ new; o is quiet; n is noise
});
