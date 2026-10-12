// Pure scheduling logic: expands weekly slots into dated occurrences and
// decides which lecture/recitation units are already available (happened in any group).
// Works both in the browser (ES module) and in node (tests).

export const TYPE_LABELS = { lecture: 'הרצאה', recitation: 'תרגול', lab: 'מעבדה' };
export const DAY_LABELS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];

export function parseDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function ymd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function at(date, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, m);
}

function inRanges(dateStr, ranges) {
  return (ranges || []).some((r) => dateStr >= r.from && dateStr <= (r.to || r.from));
}

// All occurrences of one group, sorted chronologically.
export function expandGroup(sem, course, group) {
  const occ = [];
  const first = parseDate(group.from || sem.start);
  const last = parseDate(group.to || sem.end);
  const cancelled = (sem.cancellations || []).filter(
    (c) => c.course === course.code && (!c.group || c.group === group.code),
  );
  for (let d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) {
    const ds = ymd(d);
    if (inRanges(ds, sem.noClass)) continue;
    for (const slot of group.slots) {
      if (slot.day !== d.getDay()) continue;
      if (cancelled.some((c) => c.date === ds && (!c.start || c.start === slot.start))) continue;
      occ.push({ start: at(d, slot.start), end: at(d, slot.end), room: slot.room || '' });
    }
  }
  for (const x of sem.extras || []) {
    if (x.course === course.code && x.group === group.code) {
      const d = parseDate(x.date);
      occ.push({ start: at(d, x.start), end: at(d, x.end), room: x.room || '', extra: true });
    }
  }
  return occ.sort((a, b) => a.start - b.start);
}

// For every course and type the user is registered to, returns the list of units
// (#1..#k of the user's group) with the earliest time any comparable group held it.
export function computeUnits(sem, now) {
  return sem.courses.map((course) => {
    const types = Object.entries(course.myGroups || {}).flatMap(([type, myCode]) => {
      const mine = course.groups.find((g) => g.code === myCode && g.type === type);
      if (!mine) return [];
      // Own group first, so it wins ties with groups meeting at the same time.
      const comparable = [mine, ...course.groups.filter(
        (g) => g !== mine && g.type === type && g.slots.length === mine.slots.length,
      )];
      const expanded = comparable.map((g) => ({ group: g, occ: expandGroup(sem, course, g) }));
      const myOcc = expanded.find((e) => e.group === mine).occ;
      const units = myOcc.map((own, i) => {
        let first = null;
        for (const e of expanded) {
          const o = e.occ[i];
          if (o && (!first || o.end < first.end)) first = { ...o, group: e.group };
        }
        return {
          n: i + 1,
          key: `${sem.id}/${course.code}/${type}/${i + 1}`,
          available: first.end <= now,
          first,
          own,
        };
      });
      return [{ type, label: TYPE_LABELS[type] || type, mine, units }];
    });
    return { code: course.code, name: course.name, short: course.short || course.name, types };
  });
}
