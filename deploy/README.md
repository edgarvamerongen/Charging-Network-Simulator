# CNS deploy assets

## Nightly Notion → catalog sync (`cns-sync.service` + `cns-sync.timer`)

Pulls the aircraft catalog from Notion into `data/planes.generated.json` once a
night. On-demand syncs also run from the app (**Model settings → Aircraft catalog
→ Sync from Notion**) and from the CLI (`./venv/bin/python notion_sync.py`). See
`NOTION_CATALOG_PLAN.md` for the full design.

### Prerequisites
- `/etc/cns.env` has `CNS_NOTION_TOKEN`, `CNS_NOTION_AIRCRAFT_DB`,
  `CNS_NOTION_PROFILES_DB` (and `CNS_SYNC_TOKEN` for the HTTP trigger).
- The venv has `requests`: `./venv/bin/pip install -r requirements.txt`.

### Install
1. **Align the paths** with your running app — the units ship with placeholder
   paths:
   ```bash
   systemctl cat cns     # note User=, WorkingDirectory=, and the venv python in ExecStart
   ```
   Edit `cns-sync.service` so `User`, `WorkingDirectory`, and the `ExecStart`
   python path match `cns`.
2. Install + enable the timer:
   ```bash
   sudo cp deploy/cns-sync.service deploy/cns-sync.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now cns-sync.timer
   ```

### Verify / operate
```bash
systemctl list-timers cns-sync.timer               # next scheduled run
sudo systemctl start cns-sync.service              # run once, now
journalctl -u cns-sync.service -n 50 --no-pager    # last sync report (JSON) + result
```

### Notes
- A run exits non-zero and **leaves the last-good catalog untouched** if Notion is
  unreachable or the result is suspicious (empty / <50% of the previous catalog).
  Failures surface in `journalctl` and `systemctl list-timers`.
- **No `cns` restart needed** after a sync — the app hot-reloads
  `data/planes.generated.json` by mtime on the next request.
- Every successful sync is snapshotted under `data/snapshots/` (newest 30 kept);
  restore one by copying it over `data/planes.generated.json`.
