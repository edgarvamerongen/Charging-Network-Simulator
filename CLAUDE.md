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
