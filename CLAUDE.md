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
- **Date-filtered**: Total Inquiries / Appointment Requests / Phone Calls cards, Inquiries by Week chart, Total Sessions / First-time % / Mobile % cards, Sessions Over Time chart, Traffic Sources chart, Paid vs Organic Inquiries chart (stacked appt + phone per channel from GA4_Events).
- **Independent data periods** (self-labeled): Healthgrades Provider Profiles (April 2026 snapshot — no API).

---

## RULES FOR FUTURE SESSIONS — read this before changing anything data-driven

These rules exist because the same failures kept happening across sessions
and computers. Steve was rightly furious. If you bypass these, you're
guaranteed to make the same mistakes.

### Rule A — No silent fallbacks. Every data-driven element must show its freshness.

If a component reads from a sheet CSV and the sheet isn't published yet (or
the gid is null, or the fetch failed), DO NOT silently fall back to a
hardcoded value that looks fine. That's how Steve ends up showing a stale
dashboard to his boss without knowing.

**Required pattern for any new data-driven section:**
1. Initialize the DOM element with `—` or "Loading…" — never with a real-looking
   stale number.
2. The `apply*(range)` function MUST run on every `applyDateRange()` call, even
   when its data source is empty. If empty, render an "Awaiting sync" banner
   inside the section's container so staleness is obvious in the UI.
3. The sync-status pill in the header reflects when ANY sheet last updated.
   Don't introduce per-section freshness logic that hides issues.

### Rule B — The sync-status pill is the truth. Never hardcode a "last refreshed" date in source.

The pill text is set by `renderSyncPill({ syncedIso, loadedIso, status, source })`.
Source priority: Sync_Log tab → newest GA4_Daily date → now. If you find
yourself wanting to update a `DATA_REFRESHED_AT` constant, stop and wire the
data into the existing pipeline instead.

### Rule C — Every chart must call `update()` on every `applyDateRange`, even with empty data.

The bug pattern: chart initialised with hardcoded sample values like
`[146, 171, 190, 814, 82]` for "Apr 7, Apr 14, …". If the data-load function
returns early when filtered is empty, those sample values stay visible and
look like real data. The user can't tell. Fix: charts initialise with
empty arrays; their `apply*` function always writes labels + data (even if
empty arrays), then calls `update()`. No early returns that leave stale state.

### Rule D — When a data source is pending, the section says so. Loudly.

GBP_Daily, Alchemer_Responses, Sync_Log all have `gids` that can be null.
When null, the corresponding section shows a yellow "Awaiting sync" banner
with a concrete next step (e.g., "Steve needs to publish the tab and paste
the gid into CAMPAIGN.sheet.gids.gbpDaily"). The banner hides itself when
live data flows.

### Rule E — Update the wiki entry whenever you make a structural change.

`~/Sites/Claude/Claude/wiki/projects/hhs-campaign-dashboard.md` is the long-term
memory across sessions and computers. Append a dated entry every time you
land a non-trivial change. If the next Claude session starts cold, that file
is what saves it (and Steve) from repeating the same mistakes.

### Rule F — The Apps Script is split: Code.gs (v4 fetchers) + Extensions.gs (safe-write infra + new fetchers).

Don't blindly overwrite Code.gs — it owns `fetchGA4Daily`, `fetchGA4Channels`,
`fetchGA4Pages`, `fetchShortIoClicks`, plus the `GA4_PROPERTY_ID` constant.
Extensions.gs owns `safeReplaceSheet`, `logSync`, `doGet` (the `/update`
web-app endpoint), `setupTriggers`, `fetchAll`, and the new safe fetchers
for `GA4_Events`, `GBP_Daily`, `Alchemer_Responses`. `fetchAll` chains
`fetchAllData()` (from Code.gs) so the nightly trigger covers everything.

### Rule G — Date picker has 4 options. Don't add more without asking.

`Since launch (default) / Last week / Last month / Custom range`. That's it.
"Last 7 days" / "Last 30 days" / "Last 90 days" are deliberately gone.

### Rule H — Provider Demand stays a clean table. No donut, no service-type mix.

That experiment was rejected. Provider Demand is a single full-width
(or max-width-bounded) table with photo + name + bar + count + "requests".
Count and label must align right-edge — use the `.prov-num-cell` class on
the td so width is consistent across rows.

### Rule I — Tabs are 2: Overview + Full Report. Don't re-add "Channels" or "Detail".

Old slugs `#channels` and `#detail` still route to `#full` via `SLUG_TAB`
for bookmark compatibility, but the UI is two tabs.

---

## On-demand refresh

`https://sdanforth.github.io/hhs-dashboard/?update&token=YOUR_TOKEN` reveals
a "Refresh now" button in the header. Token is the `UPDATE_TOKEN` set in the
Apps Script project's Script Properties. The button calls the deployed web-app
`/exec?action=update&token=...` endpoint; on success the page reloads.
