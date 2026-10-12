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

One-off changes: `cancellations` (`course`, `group`, `date`) and `extras`
(`course`, `group`, `date`, `start`, `end`). A group can start late with `"from": "YYYY-MM-DD"`.

## Develop
```
python3 -m http.server 8321      # then open http://localhost:8321
node --test test/
```
