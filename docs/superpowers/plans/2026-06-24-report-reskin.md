# PDF Report Re-skin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-skin the PDF advisory report to the revised front-end's formatting while keeping the current backend, advisory content (About / Methodology / contact), curated airport thumbnail, per-airport verdict, and appended one-pager.

**Architecture:** Approach A — drop the revised `templates/report.html` + `static/report.css` onto the **current** `report.py`. The two `report.py` are siblings (same `generate_pdf` contract + SVG builders), so the new template is near-drop-in; only ~4 derived `scenario` fields + per-airport `installedKw` are added. Verification is visual (render a sample PDF and eyeball), gated by `tests/test_report_unit.py` for the `report.py` helpers.

**Tech Stack:** Python, Flask, Jinja2, WeasyPrint (A4 print CSS), inline server-drawn SVG.

## Global Constraints

- **Files in scope (3):** `templates/report.html`, `static/report.css`, `report.py`. Plus a throwaway render harness under `tests/`.
- **Preserve unchanged in `report.py`:** the curated `_airport_photo` pipeline (thumbnail) and the appended NRG2fly one-pager (`_append_onepager`).
- **Trip-type label is "Return"** (not "Retour") — copy convention.
- **Brand palette to verify on eyeball:** app brand is navy `#2b2f5a` / orange `#e57850` / gold `#e6c149`; the revised CSS ships navy `#2f3060` / coral `#f08060` / amber `#f0c070`. Copy the revised CSS as the formatting source, then FLAG the palette delta to the user during the final eyeball (do not silently re-brand).
- **Decisions:** new look + structure; keep "{Airport} as an Energy Hub" cover title; **contained** cover thumbnail fed by the current pipeline; port About / Methodology / CEO-COO contact in the new style; keep per-airport verdict; the per-flight detail table is simply absent in the new template (nothing to remove).
- **Worktree:** `../cns-report` on `feat/report-reskin` (base `origin/main` `dfa8c27`). Run python with the main checkout's interpreter: `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib "/Users/edgar/Documents/NRG2FLY/Charging Network Simulator/venv/bin/python"`.
- **Sources to copy from:** revised template `/Users/edgar/Documents/proefje/cns new front end ideas/templates/report.html`; revised CSS `…/static/report.css`.
- Commit messages end with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: Render harness + baseline reference

**Files:**
- Create: `tests/_render_sample.py` (throwaway render harness)
- Create: `tests/fixtures/report_payload.json` (captured real payload)

**Interfaces:**
- Produces: `tests/_render_sample.py` writes `/tmp/report_sample.pdf` from `report.generate_pdf(payload, css_url, request_root)` using the captured payload; reused by every later task's eyeball step.

- [ ] **Step 1: Capture a real payload.** Temporarily add, at the top of the `/report` (or PDF-export) handler in `app.py`, `import json; open('/tmp/report_payload.json','w').write(json.dumps(request.get_json() or {}))`. Start the app (`PORT=5055 … venv/bin/python app.py`), build the default Lelystad→Frankfurt route, Add to demand calculator, and export the PDF once. Copy `/tmp/report_payload.json` → `tests/fixtures/report_payload.json`. Revert the temporary `app.py` line.

- [ ] **Step 2: Write the harness.**
```python
# tests/_render_sample.py — throwaway: render the report to /tmp/report_sample.pdf
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from flask import Flask
import report
app = Flask(__name__, template_folder='templates', static_folder='static')
with app.app_context():
    payload = json.load(open(os.path.join(os.path.dirname(__file__), 'fixtures', 'report_payload.json')))
    css = 'file://' + os.path.abspath('static/report.css')
    pdf = report.generate_pdf(payload, css, 'file://' + os.path.abspath('.'))
    open('/tmp/report_sample.pdf', 'wb').write(pdf)
    print('wrote /tmp/report_sample.pdf', len(pdf), 'bytes')
```

- [ ] **Step 3: Render the CURRENT report as the baseline.**
Run: `cd ../cns-report && DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib "/Users/edgar/Documents/NRG2FLY/Charging Network Simulator/venv/bin/python" tests/_render_sample.py`
Expected: `wrote /tmp/report_sample.pdf …`. Open/Read the PDF — this is the content reference (About, Methodology, contact, verdict all present).

- [ ] **Step 4: Commit the harness.**
```bash
git add tests/_render_sample.py tests/fixtures/report_payload.json
git commit -m "test: report render harness + captured payload fixture"
```

---

### Task 2: Drop in the revised template + CSS, wire `report.py` fields

**Files:**
- Modify: `templates/report.html` (replace with revised)
- Modify: `static/report.css` (replace with revised)
- Modify: `report.py` (scenario fields + per-airport `installedKw`)

**Interfaces:**
- Consumes: revised template/CSS sources (Global Constraints).
- Produces: `scenario` dict gains `tariff`, `daily_kwh`, `annual_mwh`, `gross_rev_year`; each `airports[i]` gains `installedKw`.

- [ ] **Step 1: Copy the revised files verbatim.**
```bash
cp "/Users/edgar/Documents/proefje/cns new front end ideas/templates/report.html" templates/report.html
cp "/Users/edgar/Documents/proefje/cns new front end ideas/static/report.css" static/report.css
```

- [ ] **Step 2: Add the derived `scenario` fields in `report.py`.** Locate the `scenario = { … }` construction (the block computing `annual_kwh`, `rev_year_low/high`, `energy_cost_year`, `margin_year_low/high`, `procurement`, `realisation_low/high`). Immediately after it, add:
```python
    scenario['tariff'] = charge_rate
    scenario['daily_kwh'] = daily_kwh
    scenario['annual_mwh'] = (scenario.get('annual_kwh') or 0) / 1000.0
    scenario['gross_rev_year'] = (scenario.get('annual_kwh') or 0) * charge_rate
```

- [ ] **Step 3: Add per-airport `installedKw` in `report.py`.** In the loop that finalises each airport dict (where `a['gantt_svg']` is set), add:
```python
        a.setdefault('installedKw', sum((c.get('count') or 1) * (c.get('power_kw') or 0)
                                        for c in (a.get('chargers') or [])))
```

- [ ] **Step 4: Render + eyeball.**
Run: `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib "/Users/edgar/Documents/NRG2FLY/Charging Network Simulator/venv/bin/python" tests/_render_sample.py`
Expected: renders without error; the PDF now shows the NEW look (cover with 5 KPIs, numbered sections, fleet cards, appendix). Revenue table and per-airport "Installed" column are populated (not "—").

- [ ] **Step 5: Run the `report.py` regression gate.**
Run: `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib "/Users/edgar/Documents/NRG2FLY/Charging Network Simulator/venv/bin/python" -m unittest tests.test_report_unit`
Expected: OK (all helper tests pass; report.py logic untouched except added fields).

- [ ] **Step 6: Commit.**
```bash
git add templates/report.html static/report.css report.py
git commit -m "feat(report): adopt revised PDF formatting + derived scenario/installed fields"
```

---

### Task 3: Cover — Energy-Hub title + contained thumbnail

**Files:**
- Modify: `templates/report.html` (cover section)

- [ ] **Step 1: Replace the revised cover title block.** In the `.cover-titleblock`, swap the generic title for the Energy-Hub framing (and keep the airport line as the subtitle). Replace:
```html
    <div class="cover-titleblock">
      <h1>Charging infrastructure plan</h1>
      <div class="cover-airport">{{ focus_airport
          or (airports[0].name if airports else 'Electric flight network') }}</div>
      <div class="cover-rule"></div>
    </div>
```
with:
```html
    <div class="cover-titleblock">
      <h1>{% if focus_airport %}{{ focus_airport }}<br>as an Energy Hub{% else %}Your Airport<br>as an Energy Hub{% endif %}</h1>
      <div class="cover-airport">{% if focus_airport %}Sizing the charging network for {{ focus_airport }}{% else %}Sizing the charging network for a first electric route{% endif %}</div>
      <div class="cover-rule"></div>
    </div>
```

- [ ] **Step 2: Confirm the contained thumbnail binds to the current pipeline.** The revised cover already renders `{% if airport_photo %}<div class="cover-photo"><img src="{{ airport_photo }}">…`. The current `report.py` passes `airport_photo=photo.get('uri')` from the curated `_airport_photo` — no template change needed. Leave the `.cover-photo` (contained) block as-is.

- [ ] **Step 3: Render + eyeball the cover.** Run the harness. Expected: cover reads "{Airport} as an Energy Hub", a contained airport photo appears below the title, 5 KPI cards along the bottom.

- [ ] **Step 4: Commit.**
```bash
git add templates/report.html
git commit -m "feat(report): Energy-Hub cover title over the revised cover"
```

---

### Task 4: Port the "About NRG2fly" page (new card style)

**Files:**
- Modify: `templates/report.html` (insert About section after cover)
- Modify: `static/report.css` (append ported styles)

- [ ] **Step 1: Insert the About section** immediately after the closing `</section>` of the cover, before `01 · Executive summary`:
```html
{# ===================== ABOUT ============================================ #}
<section class="page">
  <div class="section-kicker">NRG2FLY</div>
  <h2>About NRG2fly</h2>
  <p class="lede">NRG2fly is a Dutch company dedicated to the charging infrastructure that electric aviation needs to get off the ground. We help airports across Europe prepare for the first electric aircraft and the rotations that follow.</p>
  <div class="about-cols">
    <div class="about-col"><div class="about-col-h">Consulting</div><p>Electrification strategy, demand modelling, and the roadmap from a single charger to a full energy hub.</p></div>
    <div class="about-col"><div class="about-col-h">Hardware</div><p>Selecting and integrating the right chargers for aircraft, matched to your aircraft mix and grid connection.</p></div>
    <div class="about-col"><div class="about-col-h">CPO &amp; MSP</div><p>Operating the charging points and the mobility-service layer, so charging is reliable from day one.</p></div>
  </div>
  <h3>What this report means for your airport</h3>
  <p>This document translates a concrete flight schedule into the energy and power your airport would need to serve it — kWh per day, peak kW, the number of chargers, and how rotations fill the operating day. The figures are <strong>indicative — a strategic sizing aid, not a procurement specification</strong>. Its real value is as a starting point for a conversation about the airport as an <strong>energy hub</strong>.</p>
</section>
```

- [ ] **Step 2: Append the ported About styles** to `static/report.css` (re-paletted to the revised vars), at the end of the file:
```css
/* ---------- ported: About + advisory framing -------------------------------- */
.about-cols { display: flex; gap: 4mm; margin: 4mm 0 2mm; page-break-inside: avoid; }
.about-col  { flex: 1; background: var(--soft); border: 0.35mm solid var(--line); border-radius: 2mm; padding: 4mm; }
.about-col-h{ color: var(--navy); font-weight: 700; font-size: 11pt; margin-bottom: 2mm; }
.about-col p{ font-size: 9pt; color: var(--body); margin: 0; }
```

- [ ] **Step 3: Render + eyeball.** Run the harness. Expected: an "About NRG2fly" page appears as page 2 with three cards and the framing paragraph, in the new style.

- [ ] **Step 4: Commit.**
```bash
git add templates/report.html static/report.css
git commit -m "feat(report): port About NRG2fly page into the new style"
```

---

### Task 5: Port the CEO/COO contact box

**Files:**
- Modify: `templates/report.html` (append contact box to the About section)
- Modify: `static/report.css` (append ported styles)

- [ ] **Step 1: Add the contact box** just before the About section's closing `</section>`:
```html
  <div class="questions-box">
    <div class="questions-h">Do you have questions?</div>
    <p>Reach out to <strong>Merlijn van Vliet</strong> (CEO) and <strong>Jacco Bink</strong> (COO).</p>
    <p class="questions-foot">nrg2fly.com</p>
  </div>
```

- [ ] **Step 2: Append the ported contact styles** to `static/report.css` (re-paletted; navy→deep-navy gradient, cream text):
```css
/* ---------- ported: contact / questions box --------------------------------- */
.questions-box { margin-top: 8mm; background: linear-gradient(135deg, var(--navy) 0%, var(--navy-deep) 100%); color: var(--cream); border-radius: 2.5mm; padding: 6mm 7mm; page-break-inside: avoid; }
.questions-h   { font-size: 14pt; font-weight: 800; margin-bottom: 2mm; }
.questions-box p { color: rgba(253,249,242,.92); margin: 1mm 0; }
.questions-foot{ font-size: 9pt; opacity: .8; }
```

- [ ] **Step 3: Render + eyeball.** Run the harness. Expected: a navy contact box with the CEO/COO names sits at the bottom of the About page.

- [ ] **Step 4: Commit.**
```bash
git add templates/report.html static/report.css
git commit -m "feat(report): port CEO/COO contact box"
```

---

### Task 6: Methodology section + merge with the appendix

**Files:**
- Modify: `templates/report.html` (add Methodology to the Appendix section; dedup)
- Modify: `static/report.css` (append ported styles)

- [ ] **Step 1: Add a Methodology block** inside the existing `A · Appendix` section, before its existing cards (keep the appendix's settings/economics/charger-catalogue tables; they are the data view, the prose is complementary):
```html
  <h3>Battery model</h3>
  <p class="meth">Per-leg energy is <code>battery × distance / range</code>. Every aircraft charges to a global charge target (default 80%), which an airport can override; with no target, the model recharges only the round-trip deficit <code>max(0, 2 × leg − battery)</code> unless Recharge-to-full tops to 100%.</p>
  <h3>Multi-leg routing</h3>
  <p class="meth">When one battery can't reach the destination, an A* planner inserts charging stops minimising total distance (optionally biased to a preferred airport size); each stop charges to the target but never below the next leg plus reserve.</p>
  <h3>Rotation scheduler</h3>
  <p class="meth">A rotation is one aircraft cycle (depart → charge → return → recharge). One aircraft can't fly two rotations at once and each charger serves one aircraft at a time; contention queues and propagates the wait.</p>
  <h3>Disclaimer</h3>
  <p class="meth">Indicative figures. Real energy use varies with payload, weather, wind, taxi time, reserves, charger efficiency and grid losses — none modelled here. A strategic sizing aid, not a procurement specification.</p>
```

- [ ] **Step 2: Remove the duplicated appendix prose, if any.** Scan the Appendix's existing footnote (`Demand profiles are computed by the NRG2FLY rotation scheduler…`). Keep ONE disclaimer — the Methodology "Disclaimer" supersedes the trailing footnote's caveat; trim the footnote to just the "Generated {{ generated_at }}" line.

- [ ] **Step 3: Append the Methodology prose style** to `static/report.css`:
```css
/* ---------- ported: methodology prose --------------------------------------- */
p.meth { font-size: 9pt; color: var(--body); margin: 1mm 0 3mm; }
p.meth code { background: var(--soft); padding: 0.3mm 1.5mm; border-radius: 1mm; font-size: 8.5pt; color: var(--ink); }
```

- [ ] **Step 4: Render + eyeball.** Run the harness. Expected: the appendix page leads with the four Methodology subsections, then the settings/economics/charger tables, with a single disclaimer.

- [ ] **Step 5: Commit.**
```bash
git add templates/report.html static/report.css
git commit -m "feat(report): merge Methodology prose into the appendix"
```

---

### Task 7: Per-airport verdict (ported into the new airport page)

**Files:**
- Modify: `templates/report.html` (airport `{% for a in airports %}` section)
- Modify: `static/report.css` (append ported styles)

- [ ] **Step 1: Add the verdict block** at the end of the per-airport `<section>`, after the gantt card and before `</section>`:
```html
  <div class="verdict verdict-{{ 'warn' if a.overflow else 'ok' }}">
    {% if a.overflow %}
      With {{ a.chargerCount|default(0, true) }} charger{{ '' if a.chargerCount == 1 else 's' }}
      ({{ a.installedKw|default(none)|fmt_power or '—' }}) the rotations don't all fit before 23:00 —
      the last finishes {{ a.latestEndClock|default('—', true) }}. Add chargers or reduce flights.
    {% else %}
      {{ a.chargerCount|default(0, true) }} charger{{ '' if a.chargerCount == 1 else 's' }}
      ({{ a.installedKw|default(none)|fmt_power or '—' }}) handle the day —
      peak draw {{ a.peakKw|default(none)|fmt_power or '—' }}, last rotation ends {{ a.latestEndClock|default('—', true) }}.
    {% endif %}
  </div>
```

- [ ] **Step 2: Append the ported verdict styles** to `static/report.css`:
```css
/* ---------- ported: per-airport verdict ------------------------------------- */
.verdict      { margin-top: 4mm; padding: 3mm 4mm; border-radius: 1.5mm; font-size: 9.5pt; page-break-inside: avoid; }
.verdict-ok   { background: #ecfdf5; border-left: 0.8mm solid #10b981; color: #065f46; }
.verdict-warn { background: #fff7ed; border-left: 0.8mm solid #f59e0b; color: #9a3412; }
```

- [ ] **Step 3: Render + eyeball.** Run the harness. Expected: each airport page ends with a green "handle the day" verdict (or amber overflow warning).

- [ ] **Step 4: Commit.**
```bash
git add templates/report.html static/report.css
git commit -m "feat(report): keep per-airport verdict in the new airport page"
```

---

### Task 8: Final gate — full render, regression, brand flag, cleanup

**Files:**
- Modify: (none expected; fixes only if the eyeball finds issues)

- [ ] **Step 1: Full render + section-by-section eyeball.** Run the harness; open `/tmp/report_sample.pdf`. Confirm in order: cover (Energy-Hub title + contained thumbnail + 5 KPIs) → About + contact → 01 Exec (load curve, donut, revenue table populated) → 02 Network (map + table) → 03 Airport detail (KPI row + equipment + gantt + verdict) → 04 Fleet cards → Methodology+appendix → **NRG2fly one-pager appended** at the end.

- [ ] **Step 2: `report.py` regression gate.**
Run: `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib "/Users/edgar/Documents/NRG2FLY/Charging Network Simulator/venv/bin/python" -m unittest tests.test_report_unit`
Expected: OK.

- [ ] **Step 3: Brand flag.** Compare the rendered palette (navy `#2f3060`/coral `#f08060`/amber `#f0c070`) against app brand (`#2b2f5a`/`#e57850`/`#e6c149`). Capture a cover screenshot and surface the delta to the user: keep the revised palette, or re-point `static/report.css` `:root` to the app brand? (One-line change set; do NOT decide silently.)

- [ ] **Step 4: Remove the throwaway harness** (keep the fixture if useful, else drop both):
```bash
git rm tests/_render_sample.py tests/fixtures/report_payload.json
git commit -m "chore(report): drop the throwaway render harness"
```
(If the fixture is worth keeping for future report tests, keep it and only remove `_render_sample.py`.)

- [ ] **Step 5: Open the PR.** Push `feat/report-reskin`; open a PR to `main` summarising the re-skin, the kept/dropped content, and the brand-palette question. Attach a rendered-PDF screenshot.

---

## Self-Review

**Spec coverage:** cover (Task 3) · About (4) · contact (5) · exec/network/fleet/appendix base + scenario fields (2) · methodology merge (6) · verdict (7) · thumbnail preserved (3 step 2) · one-pager preserved (Global Constraints, verified Task 8) · per-flight table absent by construction (noted) · brand flag (Task 8). All spec sections map to a task.

**Placeholder scan:** none — every modification step carries the exact HTML/CSS/Python; verbatim copies reference exact source paths.

**Type/name consistency:** `scenario.tariff/daily_kwh/annual_mwh/gross_rev_year` and `a.installedKw` are produced in Task 2 and consumed by the revised template's revenue table + airport table + Task 7 verdict. `fmt_power`/`fmt_energy`/`fmt_money` filters already registered in `report.py`. CSS vars (`--navy`,`--navy-deep`,`--soft`,`--line`,`--body`,`--ink`,`--cream`) all exist in the revised `:root`.
