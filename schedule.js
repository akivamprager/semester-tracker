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
  // Permanent room moves from a date on (latest one wins); earlier sessions keep the old room.
  const moves = (sem.roomChanges || [])
    .filter((r) => r.course === course.code && (!r.group || r.group === group.code))
    .sort((a, b) => (a.from < b.from ? -1 : 1));
  const roomOn = (ds, slot) => moves.filter((r) => r.from <= ds && (!r.start || r.start === slot.start))
    .reduce((room, r) => r.room, slot.room || '');
  for (let d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) {
    const ds = ymd(d);
    if (inRanges(ds, sem.noClass)) continue;
    for (const slot of group.slots) {
      if (slot.day !== d.getDay()) continue;
      if (cancelled.some((c) => c.date === ds && (!c.start || c.start === slot.start))) continue;
      occ.push({ start: at(d, slot.start), end: at(d, slot.end), room: roomOn(ds, slot) });
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
      // `options`: every comparable group's sessions (occurrence i = unit #i+1), for the
      // "which session can I go to" timetable.
      return [{ type, label: TYPE_LABELS[type] || type, mine, units, options: expanded }];
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
    if (rule.weekly) { tasks.push(...weeklyTasks(sem, rule)); continue; }
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
  // a quiz in an in-person session = an exam task at the user's own session
  for (const rule of sem.inPerson || []) {
    if (!rule.examTitle) continue;
    const type = units.find((c) => c.code === rule.course)?.types.find((t) => t.type === rule.type);
    rule.units.forEach((n, i) => {
      const u = type?.units[n - 1];
      if (!u?.own) return;
      const at = u.own.start;
      tasks.push({
        id: `${rule.id}-${i + 1}`,
        course: rule.course,
        kind: 'exam',
        title: rule.examTitle.replace('{n}', i + 1),
        due: `${ymd(at)}T${p(at.getHours())}:${p(at.getMinutes())}`,
        note: [rule.note, rule.notes?.[i]].filter(Boolean).join(' · '),
      });
    });
  }
  return tasks;
}

// Weekly tasks on a fixed calendar pattern, e.g. a lab that opens Sunday 08:00 and is due
// Thursday 23:59 of the following week. Weeks entirely inside a noClass range are skipped.
// rule.weekly = { count, open: {day, time}, due: {weeks, day, time}, confirmed }
function weeklyTasks(sem, rule) {
  const { count, open, due, confirmed = 0 } = rule.weekly;
  const at = (date, hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, m);
  };
  const stamp = (d) => `${ymd(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sunday = parseDate(sem.start);
  sunday.setDate(sunday.getDate() - sunday.getDay());
  const end = parseDate(sem.end);
  const tasks = [];
  for (let week = new Date(sunday); week <= end && tasks.length < count; week.setDate(week.getDate() + 7)) {
    const teachingDays = [0, 1, 2, 3, 4].map((i) => {
      const d = new Date(week); d.setDate(d.getDate() + i); return ymd(d);
    });
    if (teachingDays.every((ds) => inRanges(ds, sem.noClass))) continue;
    const n = tasks.length + 1;
    const opens = new Date(week); opens.setDate(opens.getDate() + open.day);
    const dueDay = new Date(week); dueDay.setDate(dueDay.getDate() + 7 * due.weeks + due.day);
    tasks.push({
      id: `${rule.id}-${n}`,
      course: rule.course,
      kind: rule.kind || 'hw',
      title: rule.title.replace('{n}', n),
      due: stamp(at(dueDay, due.time)),
      note: rule.note || '',
      estimated: n > confirmed,
      showFrom: at(opens, open.time),
    });
  }
  return tasks;
}

// All tasks for a semester: built-in ones merged with the user's additions/edits from the
// synced progress map (see app.js for the key layout). Tasks with `showFrom` stay hidden
// until then.
export function mergeTasks(sem, courses, progress, now, { includeHidden = false } = {}) {
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
    .filter((t) => !t.deleted && (includeHidden || t.done || !t.showFrom || new Date(t.showFrom) <= now));
}

// Sessions of any comparable group between `from` and `to` (ending after `from`), as
// [{ course, type, unit, group, occ, mine }] sorted by start time.
export function sessionsBetween(courses, from, to) {
  const out = [];
  for (const course of courses) {
    for (const type of course.types) {
      for (const { group, occ } of type.options) {
        occ.forEach((o, i) => {
          if (o.end > from && o.start < to) {
            out.push({ course, type, unit: type.units[i], group, occ: o, mine: group === type.mine });
          }
        });
      }
    }
  }
  return out.sort((a, b) => a.occ.start - b.occ.start || (b.mine - a.mine));
}

// The user's own sessions on a date (all courses/types, done or not), sorted by start.
export function ownSessionsOn(courses, date) {
  const day = ymd(date);
  return courses
    .flatMap((c) => c.types.flatMap((t) => t.units.filter((u) => u.own && ymd(u.own.start) === day)
      .map((u) => ({ course: c, type: t, unit: u, start: u.own.start, end: u.own.end }))))
    .sort((a, b) => a.start - b.start);
}

// Free stretches of at least `minMinutes` between the user's own sessions that day.
// The usual 15-minute break between back-to-back classes is not a gap.
// Days the user stays home and watches the recordings instead (synced preference, 0 = Sunday).
// Their classes stay in the schedule and in "to catch up", but get no "go to class" treatment.
export const HOME_PREFS_KEY = 'prefs/home';
export const homeDays = (progress) => progress?.[HOME_PREFS_KEY]?.d?.days || [];
export const atHome = (progress, date) => homeDays(progress).includes(new Date(date).getDay());

// Sessions that must be attended in person (a quiz in the recitation, attendance taken):
//   "inPerson": [{ "id", "course", "type", "units": [3, 6, …], "label", "examTitle", "note", "notes" }]
// by unit number (= the n-th lesson of the user's group), so it follows a change of group.
export const inPersonRule = (sem, code, type, n) =>
  (sem.inPerson || []).find((r) => r.course === code && r.type === type && r.units.includes(n)) || null;
// At home that day, unless this very session has to be attended.
export const homeSession = (sem, progress, code, type, u) =>
  !!u.own && atHome(progress, u.own.start) && !inPersonRule(sem, code, type, u.n);

// Weekly commitments outside the courses (a chavruta…), from the semester file:
//   "personal": [{ "id", "title", "emoji", "day", "start", "end", "place" }]
export const personalItems = (sem) => sem.personal || [];
// Occurrences that overlap [from, to), within the semester: [{ item, start, end, key }].
export function personalBetween(sem, from, to) {
  const items = personalItems(sem);
  if (!items.length) return [];
  const out = [];
  const first = new Date(Math.max(+parseDate(sem.start), +from));
  first.setHours(0, 0, 0, 0);
  const last = new Date(Math.min(+parseDate(sem.end) + 864e5, +to));
  for (const d = first; d < last; d.setDate(d.getDate() + 1)) {
    for (const item of items) {
      if (item.day !== d.getDay()) continue;
      const start = at(d, item.start);
      const end = at(d, item.end);
      if (end > from && start < to) out.push({ item, start, end, key: `${sem.id}/personal/${item.id}/${ymd(d)}` });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
export const personalOn = (sem, date) => {
  const d = new Date(date); d.setHours(0, 0, 0, 0);
  return personalBetween(sem, d, new Date(+d + 864e5));
};

// `extra`: other busy stretches that day ({ start, end }, e.g. personalOn) — not gaps either.
export function gapsOn(courses, date, minMinutes = 30, extra = []) {
  const own = [...ownSessionsOn(courses, date), ...extra].sort((a, b) => a.start - b.start);
  const gaps = [];
  let lastEnd = null;
  for (const s of own) {
    if (lastEnd && (s.start - lastEnd) / 60e3 >= minMinutes) gaps.push({ start: lastEnd, end: s.start });
    if (!lastEnd || s.end > lastEnd) lastEnd = s.end;
  }
  return gaps;
}
