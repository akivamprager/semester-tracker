// Pure scheduling logic: expands weekly slots into dated occurrences and
// decides which lecture/recitation units are already available (happened in any group).
// Works both in the browser (ES module) and in node (tests).

export const TYPE_LABELS = { lecture: 'הרצאה', recitation: 'תרגול', lab: 'מעבדה' };
// Used when a course in the semester file has no `color`.
const DEFAULT_COLORS = ['#8b5cf6', '#0d9488', '#d97706', '#16a34a', '#dc2626', '#2563eb', '#db2777'];

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

// For every course and type the user is registered to, returns units #1..#k, where k is
// the most sessions any comparable group has (a group may lose a day to a holiday, but the
// material is still covered). Each unit has the earliest time any comparable group held it,
// the user's own session (if their group has one) and the planned topic (if known).
export function computeUnits(sem, now) {
  return sem.courses.map((course, ci) => {
    const types = Object.entries(course.myGroups || {}).flatMap(([type, myCode]) => {
      const mine = course.groups.find((g) => g.code === myCode && g.type === type);
      if (!mine) return [];
      // Own group first, so it wins ties with groups meeting at the same time.
      const comparable = [mine, ...course.groups.filter(
        (g) => g !== mine && g.type === type && g.slots.length === mine.slots.length,
      )];
      const expanded = comparable.map((g) => ({ group: g, occ: expandGroup(sem, course, g) }));
      const count = Math.max(...expanded.map((e) => e.occ.length));
      const topics = course.topics?.[type] || [];
      const units = Array.from({ length: count }, (_, i) => {
        let first = null;
        let last = null;
        for (const e of expanded) {
          const o = e.occ[i];
          if (!o) continue;
          if (!first || o.end < first.end) first = { ...o, group: e.group };
          if (!last || o.end > last.end) last = { ...o, group: e.group };
        }
        return {
          n: i + 1,
          key: `${sem.id}/${course.code}/${type}/${i + 1}`,
          available: first.end <= now,
          first,
          last,
          own: expanded[0].occ[i] || null,
          topic: topics[i] || '',
        };
      });
      return [{ type, label: TYPE_LABELS[type] || type, mine, units }];
    });
    return {
      code: course.code,
      name: course.name,
      short: course.short || course.name,
      emoji: course.emoji || '📚',
      color: course.color || DEFAULT_COLORS[ci % DEFAULT_COLORS.length],
      url: course.url,
      info: course.info || [],
      types,
    };
  });
}

// Parses "YYYY-MM-DD" (end of that day) or "YYYY-MM-DDTHH:MM".
export function parseDue(due) {
  if (!due) return null;
  const [date, time] = due.split('T');
  const d = parseDate(date);
  if (time) {
    const [h, m] = time.split(':').map(Number);
    d.setHours(h, m);
  } else {
    d.setHours(23, 59);
  }
  return d;
}

// Built-in tasks: the semester's `tasks` list plus tasks generated from sessions
// (e.g. a weekly lab due N days after the last group's recitation #n).
// Rule options: `from` 'last' (default) or 'first' group's session #n as the base time;
// `hiddenUntilHeld` hides task #n until that session has happened (e.g. homework
// published after the lecture).
export function builtinTasks(sem, units) {
  const tasks = (sem.tasks || []).map((t) => ({ ...t }));
  const p = (n) => String(n).padStart(2, '0');
  for (const rule of sem.generatedTasks || []) {
    const course = units.find((c) => c.code === rule.course);
    const type = course?.types.find((t) => t.type === rule.type);
    if (!type) continue;
    type.units.slice(0, rule.count).forEach((u) => {
      const due = new Date((rule.from === 'first' ? u.first : u.last).end);
      due.setDate(due.getDate() + (rule.offsetDays || 0));
      tasks.push({
        id: `${rule.id}-${u.n}`,
        course: rule.course,
        kind: rule.kind || 'hw',
        title: rule.title.replace('{n}', u.n),
        due: `${ymd(due)}T${p(due.getHours())}:${p(due.getMinutes())}`,
        note: rule.note || '',
        estimated: true,
        showFrom: rule.hiddenUntilHeld ? u.first.end : null,
      });
    });
  }
  return tasks;
}

// All tasks for a semester: built-in ones merged with the user's additions/edits from the
// synced progress map (see app.js for the key layout). Tasks with `showFrom` stay hidden
// until then.
export function mergeTasks(sem, courses, progress, now) {
  const prefix = `${sem.id}/taskdata/`;
  const byId = new Map(builtinTasks(sem, courses).map((t) => [t.id, t]));
  for (const [k, v] of Object.entries(progress)) {
    if (!k.startsWith(prefix) || !v.d) continue;
    const id = k.slice(prefix.length);
    const base = byId.get(id) || { id, kind: 'hw', user: true };
    byId.set(id, { ...base, ...v.d, estimated: v.d.due !== undefined ? false : base.estimated });
  }
  return [...byId.values()]
    .map((t) => ({
      ...t,
      dueDate: parseDue(t.due),
      done: progress[`${sem.id}/task/${t.id}`]?.s === 'done',
    }))
    .filter((t) => !t.deleted && (t.done || !t.showFrom || t.showFrom <= now));
}
