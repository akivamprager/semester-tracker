# מעקב שיעורים — lecture/recitation tracker

Static PWA (no build step). Shows every lecture/recitation that already happened in *any*
group of your courses and that you haven't checked off yet.

- **Equivalence:** running count — lecture #N of any group (with the same number of weekly
  meetings as yours) = your lecture #N. It becomes available as soon as the first group finishes it.
- **Progress:** stored in the browser (localStorage) and synced to a private GitHub Gist
  (Settings → paste a token with only the `gist` scope). Export/Import for manual backups.
- **Test a date:** append `?now=2026-11-20T12:00` to the URL.

## New semester
1. Copy `semesters/2027A.json` to e.g. `semesters/2027B.json`, update `id`, `name`, `start`,
   `end`, `noClass` (from the HUJI academic calendar) and `courses` (from the Shnaton:
   each group's `code`, `type` (`lecture`/`recitation`), `lecturer`, `slots` with
   `day` 0=Sunday … 4=Thursday). Set `myGroups` to your registered groups.
2. Add it to `semesters/index.json` and make it the `default`.
3. Push. Old semesters' progress stays (keys are prefixed by semester id).

Optional per course: `info` (list of rules/notes shown in the Courses tab) and `topics`
(`{"lecture": [...], "recitation": [...]}`, topic of unit #1, #2, …). Semester-level `tasks`
(`id`, `course`, `kind` `hw`/`exam`, `title`, `due` `YYYY-MM-DD[THH:MM]`, `note`) and
`generatedTasks` (e.g. a weekly lab due `offsetDays` after the last group's recitation #n).
Tasks the user adds or edits in the app are stored with the progress (synced).

One-off changes: `cancellations` (`course`, `group`, `date`) and `extras`
(`course`, `group`, `date`, `start`, `end`). A group can start late with `"from": "YYYY-MM-DD"`.

## Develop
```
python3 -m http.server 8321      # then open http://localhost:8321
node --test test/
```

## Morning notification
A GitHub Action (`.github/workflows/morning.yml`, runs `tools/morning.mjs`) sends a Web Push
each morning (~07:00 Israel time) with today's sessions, lessons to catch up on, and
upcoming homework/exams (`summary.js`, same logic as the app's "הצג דוגמה" button).
It reads progress and device subscriptions (`push.json`) from the sync gist.

One-time setup (from this folder):
```
node tools/setup-push.mjs   # VAPID keys: secret VAPID_PRIVATE_KEY + push-config.json
gh secret set GIST_TOKEN    # paste the same gist token used in the app
git add -A && git commit -m "Set up push" && git push
```
Then in the app (opened from the home screen): Settings → הפעל התראת בוקר.
Test right away: `gh workflow run morning.yml` (sends regardless of the hour).

Note: GitHub pauses scheduled workflows in a repo with no commits for 60 days.
