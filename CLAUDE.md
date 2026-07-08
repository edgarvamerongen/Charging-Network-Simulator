# CLAUDE.md — Charging Network Simulator (CNS)

Shared conventions for **all** Claude sessions on this project. This file is
version-controlled and loaded by every session/worktree, so it is the single
source of truth for cross-session coordination. Put anything that affects more
than one session **here**, not in per-session memory (memory is keyed per
directory and is NOT shared correctly between worktrees).

## Parallel sessions: one git worktree per role

Multiple Claude sessions work on CNS at once. To stop them colliding in a shared
checkout, **each session works in its own git worktree** — a separate directory
on its own branch, sharing the same `.git` history.

| role | directory | branch | owns |
|------|-----------|--------|------|
| **desktop / backend** | main project dir | `main` (trunk) | `sim.py`, `app.py`, `static/scheduler.js`, `static/report.js`, `static/settings.js`, `static/tour.js`, desktop `templates/index.html`, PDF report, `tests/` |
| **mobile** | `../cns-mobile` | `mobile` | `/m/` route, `templates/index_mobile.html`, `static/mobile.js`, `static/mobile.css` |

```bash
git worktree list                          # see all worktrees
git worktree add -b mobile ../cns-mobile main   # create the mobile worktree
git worktree remove ../cns-mobile          # tear it down later
```

Add more roles the same way (`../cns-<role>` on branch `<role>`). For many
parallel tasks, prefer one orchestrator session dispatching worktree-isolated
subagents over many human-driven sessions.

## Rules of the road

1. **Stay in your lane.** Edit/stage/commit ONLY your role's files. If files
   outside your role show as modified in `git status`, they belong to another
   session — leave them unstaged; never commit or revert them.
2. **Communicate through git, not relayed prose.** Coordinate via branch names,
   commit messages, and PR descriptions. Shared facts go in this file.
3. **Integrate one branch at a time** (ff-merge or PR to `main`/`origin/main`).
   Before a PR, verify `git diff --stat main..HEAD` shows ONLY your role's files
   — a squash that contains another role's commits is how work gets clobbered.
4. **Check conflict direction before resolving.** `git diff <base> <other>` +
   grep for a known marker (e.g. `fleetPowers`) to see which side is newer.
   Never apply keep-ours/keep-theirs blindly.
5. **Snapshot before destructive ops** — `git branch backup/<tip>` before any
   reset/merge.
6. **Re-check state before branch ops** — HEAD/branches move under you in a
   shared repo; run `git status` + `git log --oneline --all --decorate` first.

## Running the app

- Desktop: `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib ./venv/bin/python app.py` → http://127.0.0.1:5055
- Mobile review: `PORT=5056 DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib ./venv/bin/python app.py` → http://127.0.0.1:5056/m/
- Each worktree runs its own server from its own files (no shared-template cache surprises).
- Edits to `static/*.js` need a browser reload; template edits also need a server
  restart (Flask debug is off, so Jinja caches compiled templates).

## Data

- `data/` is gitignored. `planes.json` / `chargers.json` are tracked catalogs.
- **Aircraft catalog is migrating to Notion.** The full, decision-locked
  implementation guide is `NOTION_CATALOG_PLAN.md` (repo root — `docs/` is
  gitignored, don't move it there). Notion becomes the master; a sync writes
  `data/planes.generated.json`; `sim.py` prefers it over `planes.json`; the
  custom-planes overlay and eventually `planes.json` itself get retired.
  Read the plan before touching catalog code. Beware: an older draft plan
  referenced `plane_schema.py` / `measurements[]` / `docs/DATABASE_PLAN.md` —
  those files do not exist in git; the plan file explains.

## Guided tour

The onboarding tour lives in `static/tour.js` (Driver.js). Step content +
side-effects are the `_steps()` array; tour CSS is in `templates/index.html`
(`.cns-tour-*`, `.tour-lead-*`). Each step anchors to a DOM selector, so app
markup changes can silently break it.

- **Step order follows the Create-a-route form, top to bottom.** The demo seeds
  Lelystad → Frankfurt (Beta Alia); the final "Overview" step seeds real,
  backend-routed flights out of Lelystad via `_seedNetworkFlights()`.
- **Detect drift:** `CNSTour.check()` in the browser console lists every step's
  anchor + whether it resolves; the tour also console-warns (`[CNSTour] …`) at
  startup for any missing static anchor. (`#folder …` anchors only resolve
  mid-tour once the demand drawer renders — expected to read missing before then.)
- **Refresh it: run `/update-tour`** (`.claude/commands/update-tour.md`),
  ideally in a fresh, tour-focused session. It reconciles each step's anchor +
  copy with the current UI and re-verifies by replaying the tour in the browser.
  The `.claude/` command is gitignored (local only); this section is the tracked,
  shared source of truth for the process.
