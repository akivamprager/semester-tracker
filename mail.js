// Course emails → the in-app notification center. The Google Apps Script
// (tools/google-apps-script.gs → checkMail) copies new emails from the Moodle / university
// senders into the sync gist file mail.json; tools/morning.mjs turns new ones into inbox
// entries (and a push). Pure: testable in node.
//
// mail.json = { checkedAt, messages: [{ id, from, fromName, subject, date, text }] }
// Inbox entry: <sem>/inbox/mail-<id> = { s: 'set', d: { kind: 'mail', icon, text, body, from, course, at, read } }

export const MAIL_FILE = 'mail.json';
const MOODLE_SENDER = 'noreply@moodle.huji.ac.il';
const PUSH_WITHIN_MS = 24 * 3600e3; // older messages (first run, late job) arrive silently

const SENDER_LABELS = {
  [MOODLE_SENDER]: 'מודל',
  'do_not_reply@savion.huji.ac.il': 'האוניברסיטה',
  'estii@savion.huji.ac.il': 'מזכירות הוראה',
};

// The course an email is about: a course number anywhere, else the course name in the subject.
export function mailCourse(sem, msg) {
  const text = `${msg.subject}\n${msg.text || ''}`;
  const byCode = sem.courses.find((c) => text.includes(c.code));
  if (byCode) return byCode.code;
  const byName = sem.courses.find((c) => msg.subject.includes(c.name) || msg.subject.includes(c.short));
  return byName?.code || '';
}

// New inbox entries for messages not seen yet. Moodle emails and emails about one of the
// courses are "loud" (unread + push); general university emails (lab closures etc.) are
// listed already read, without a push.
export function mailInboxUpdates(sem, mail, progress, now) {
  const updates = {};
  const notify = [];
  for (const m of mail.messages || []) {
    const key = `${sem.id}/inbox/mail-${m.id}`;
    if (progress[key]) continue;
    const course = mailCourse(sem, m);
    const moodle = m.from === MOODLE_SENDER;
    const loud = moodle || !!course;
    const recent = +now - new Date(m.date) < PUSH_WITHIN_MS;
    updates[key] = {
      s: 'set',
      t: +now,
      d: {
        kind: 'mail',
        icon: moodle ? '📢' : '🏛️',
        text: m.subject || '(ללא נושא)',
        body: m.text || '',
        from: SENDER_LABELS[m.from] || m.fromName || m.from,
        course,
        at: m.date,
        read: !loud,
      },
    };
    if (loud && recent) notify.push({ subject: m.subject, course });
  }
  return { updates, notify };
}
