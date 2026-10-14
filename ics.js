// Moodle calendar export (.ics) → task changes. Pure, so it's testable in node.
//
// Each event becomes a task with id `ics-<moodle event id>`, unless a semester `icsRules`
// entry says otherwise:
//   { "match": "regex", "ignore": true }                         skip the event
//   { "match": "regex", "task": "67315-lab-{1}", "field": "due" } set a field of an
//      existing task ({1} = first regex group); field is "due" or "showFrom"
// Without a rule, only deadline events are imported: "X is due" / "X closes", or Moodle's
// Hebrew "יש להגיש את 'X'" / "X נסגר". With { now }, upcoming `ics-` tasks that are no longer
// in the export (deleted in Moodle) are removed.

const p2 = (n) => String(n).padStart(2, '0');
const localStamp = (d) =>
  `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;

function parseIcsDate(value) {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h = '23', mi = '59', s = '00', z] = m;
  return z
    ? new Date(Date.UTC(+y, mo - 1, +d, +h, +mi, +s))
    : new Date(+y, mo - 1, +d, +h, +mi, +s);
}

const unescapeText = (s) => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');

export function parseIcs(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const events = [];
  let ev = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') ev = {};
    else if (line === 'END:VEVENT') { if (ev) events.push(ev); ev = null; }
    else if (ev) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const name = line.slice(0, i).split(';')[0];
      const value = line.slice(i + 1);
      if (name === 'UID') ev.uid = value;
      if (name === 'SUMMARY') ev.summary = unescapeText(value).trim();
      if (name === 'CATEGORIES') ev.category = unescapeText(value);
      if (name === 'DTSTART') ev.start = parseIcsDate(value);
    }
  }
  return events.filter((e) => e.uid && e.summary && e.start);
}

// The assignment name from a Moodle deadline event, or null if it isn't one.
export function deadlineTitle(summary) {
  const m = summary.match(/^(.+?)\s+(?:is due|closes)$/i)
    || summary.match(/^יש להגיש את\s+['"׳״‘’“”](.+?)['"׳״‘’“”]\s*$/)
    || summary.match(/^(.+?)\s+נסגר(?:ת)?$/);
  return m ? m[1].trim() : null;
}

export const cleanTitle = (summary) =>
  (deadlineTitle(summary) ?? summary)
    .replace(/\s+\d{4}-\d{2}\b/g, '')
    .trim();

// Returns [{ id, d }] — task data to merge into `<sem>/taskdata/<id>`:
// for new tasks the full task, for existing tasks only the changed date field.
export function icsTaskChanges(sem, events, existingTasks, { now } = {}) {
  const courseCodes = new Set(sem.courses.map((c) => c.code));
  const byId = new Map(existingTasks.map((t) => [t.id, t]));
  const changes = [];
  for (const ev of events) {
    const rule = (sem.icsRules || []).find((r) => new RegExp(r.match).test(ev.summary));
    if (rule?.ignore) continue;
    const stamp = localStamp(ev.start);
    if (rule?.task) {
      const groups = ev.summary.match(new RegExp(rule.match));
      const id = rule.task.replace(/\{(\d)\}/g, (_, n) => groups[n]);
      const current = byId.get(id)?.[rule.field];
      const currentStamp = current instanceof Date ? localStamp(current) : current;
      if (byId.has(id) && currentStamp !== stamp) {
        changes.push({ id, d: { [rule.field]: stamp } });
      }
      continue;
    }
    if (deadlineTitle(ev.summary) === null) continue;
    const course = ev.category?.match(/^(\d{5})/)?.[1];
    if (!courseCodes.has(course)) continue;
    const id = 'ics-' + ev.uid.split('@')[0];
    const existing = byId.get(id);
    if (!existing) {
      changes.push({ id, d: { course, title: cleanTitle(ev.summary), kind: 'hw', due: stamp, note: 'מהמודל' } });
    } else if (existing.due !== stamp) {
      changes.push({ id, d: { due: stamp } });
    }
  }
  // Deleted in Moodle: an upcoming `ics-` task inside the export's time window that the export
  // no longer contains. (Past ones are kept — the export only reaches a few days back.)
  if (now) {
    const inFeed = new Set(events.map((ev) => 'ics-' + ev.uid.split('@')[0]));
    const windowEnd = Math.max(...events.map((ev) => +ev.start));
    for (const t of existingTasks) {
      if (t.id.startsWith('ics-') && !t.deleted && !inFeed.has(t.id)
        && t.dueDate && t.dueDate > now && +t.dueDate <= windowEnd) {
        changes.push({ id: t.id, d: { deleted: true } });
      }
    }
  }
  return changes;
}
