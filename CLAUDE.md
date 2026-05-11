# HHS Campaign Dashboard

A standalone GitHub Pages reporting dashboard. Single-file HTML/JS/CSS, deployed at https://sdanforth.github.io/hhs-dashboard/ from `main` on push.

**Read these before working in this repo:**
- `~/Sites/Claude/Home.md` — the vault index
- `~/Sites/Claude/wiki/projects/hhs-campaign-dashboard.md` — this project's home (architecture, sheet schema, how to add a new service-line dashboard)

## Project shape

The dashboard is the **reporting layer** for paid campaigns. Today it reports on `PMax: HHS Women's Clinics` (Hurley Health Services / OB/GYN). Future versions will report on Hernia Center, Neurological Center, and other service lines.

It is **not** a Google Ads / PMax management project — see `wiki/projects/hurley-google-ads.md` for that work.

## File layout (intentionally minimal)
- `index.html` — everything: shell, CSS, JS, data wiring. Single file so GitHub Pages serves directly.
- Data sources: published Google Sheet CSVs (URLs at top of the `<script>` block in `index.html`).

## Conventions
- **One render pipeline**: `applyDateRange(start, end)` is the single source of truth that updates every card, chart, and table. If you add a new visualization, hook it into `applyDateRange` — don't render once and forget.
- **Per-campaign config lives in the `CAMPAIGN` object** at the top of `<script>`. Theme color, launch date, providers, sheet ID, etc. Future service-line dashboards copy this file and swap the CAMPAIGN object.
- **No new files unless necessary.** GitHub Pages serving from `main` means each new file is one more thing to keep clean.

## Sections that are date-filtered vs. not
- **Date-filtered**: Total Inquiries / Appointment Requests / Phone Calls cards, Inquiries by Week chart, Total Sessions / First-time % / Mobile % cards, Sessions Over Time chart, Traffic Sources chart (approximate — ratio-scaled until per-day channel data is in the sheet).
- **Since-launch / point-in-time** (labeled as such): Paid vs Organic Inquiries doughnut, Provider Demand table.
- **Independent data periods** (self-labeled): Healthgrades Provider Profiles (April 2026), GMB Profile Activity (Dec 2025 - May 2026).
