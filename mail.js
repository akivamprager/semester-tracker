// Course emails → the in-app notification center. The Google Apps Script
// (tools/google-apps-script.gs → checkMail) copies new emails from the Moodle / university
// senders into the sync gist file mail.json; tools/morning.mjs turns new ones into inbox
// entries (and a push). Pure: testable in node.
//
// mail.json = { checkedAt, messages: [{ id, from, fromName, subject, date, text }] }
// Inbox entry: <sem>/inbox/mail-<id> = { s: 'set', d: { kind: 'mail', v, icon, text, body, link, from, course, at, read } }

export const MAIL_FILE = 'mail.json';
const MOODLE_SENDER = 'noreply@moodle.huji.ac.il';
const PUSH_WITHIN_MS = 24 * 3600e3; // older messages (first run, late job) arrive silently
// Bump when the way entries are built changes: existing entries are rebuilt (read/hidden kept).
const MAIL_FORMAT = 2;

const SENDER_LABELS = {
  [MOODLE_SENDER]: 'מודל',
  'do_not_reply@savion.huji.ac.il': 'האוניברסיטה',
  'estii@savion.huji.ac.il': 'מזכירות הוראה',
};

// Automatic Moodle mails that are never course news (and may hold an IP address).
const NOISE = /כניסה חדשה לחשבון|new sign-?in|מועד הפעילויות הבאות מתקרב|upcoming activities/i;
export const isNoise = (m) => NOISE.test(m.subject || '');

// The course an email is about: a course number anywhere, else the course name in the subject.
export function mailCourse(sem, msg) {
  const text = `${msg.subject}\n${msg.text || ''}`;
  const byCode = sem.courses.find((c) => text.includes(c.code));
  if (byCode) return byCode.code;
  const byName = sem.courses.find((c) => msg.subject.includes(c.name) || msg.subject.includes(c.short));
  return byName?.code || '';
}

// Moodle wraps plain text at ~40 Hebrew characters; join those lines back into paragraphs.
function unwrap(text) {
  const lines = text.split('\n');
  const out = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    const startsItem = /^\s*([*•\-–]|\d+[.)]|[א-ת][.)'׳])\s?/.test(line);
    if (prev && prev.trim().length >= 28 && line.trim() && !startsItem && !/[:]$/.test(prev.trim())) {
      out[out.length - 1] = `${prev.trimEnd()} ${line.trim()}`;
    } else {
      out.push(line);
    }
  }
  return out.join('\n');
}

// The readable part of an email + a link to the post (Moodle forum mails).
export function mailBody(m) {
  let text = (m.text || '').replace(/\r/g, '');
  let link = '';
  const parts = text.split(/^-{20,}\s*$/m);
  if (m.from === MOODLE_SENDER && parts.length >= 2) {
    // forum mail: header (course -> forum -> subject, link, author) | post | footer
    link = parts[0].match(/https:\/\/moodle\.huji\.ac\.il\/\S*discuss\.php\S*/)?.[0] || '';
    text = parts[1];
  } else {
    // assignment mails etc.: "Links:\n------\n[1] url" at the end
    const [body, links] = text.split(/^Links:\s*$/m);
    link = links?.match(/https:\/\/\S+/)?.[0] || '';
    text = body;
  }
  text = text
    .replace(/\*([^*\n]+)\*/g, '$1') // *bold* markers
    .replace(/^[ \t ]+$/gm, '')
    .replace(/[ \t]+$/gm, '');
  text = unwrap(text).replace(/\n{3,}/g, '\n\n').trim();
  return { body: text, link };
}

// New (or outdated) inbox entries. Emails about one of the courses are "loud" (unread +
// push if recent); everything else (general university mail, last year's courses) is
// listed already read, without a push. Noise is hidden.
export function mailInboxUpdates(sem, mail, progress, now) {
  const updates = {};
  const notify = [];
  for (const m of mail.messages || []) {
    const key = `${sem.id}/inbox/mail-${m.id}`;
    const prev = progress[key]?.d;
    if (prev && prev.v === MAIL_FORMAT) continue;
    const course = mailCourse(sem, m);
    const moodle = m.from === MOODLE_SENDER;
    const noise = isNoise(m);
    const loud = !!course && !noise;
    const { body, link } = mailBody(m);
    updates[key] = {
      s: 'set',
      t: +now,
      d: {
        kind: 'mail',
        v: MAIL_FORMAT,
        icon: moodle ? '📢' : '🏛️',
        text: (m.subject || '(ללא נושא)').replace(/^\d{5}(_\d+)?-[^:]*:\s*/, ''), // course prefix → tag
        body,
        link,
        from: SENDER_LABELS[m.from] || m.fromName || m.from,
        course,
        at: m.date,
        read: !!prev?.read || !loud,
        ...(noise || prev?.hidden ? { hidden: true } : {}),
      },
    };
    if (!prev && loud && +now - new Date(m.date) < PUSH_WITHIN_MS) notify.push({ subject: updates[key].d.text, course });
  }
  return { updates, notify };
}
