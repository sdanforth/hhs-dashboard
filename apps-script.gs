/**
 * HHS Campaign Dashboard — nightly data refresh
 * =============================================
 * This script lives INSIDE the campaign's Google Sheet (Extensions →
 * Apps Script). It runs once a night and writes per-day rows to the
 * sheet, which the dashboard at https://sdanforth.github.io/hhs-dashboard/
 * reads via published CSV.
 *
 * What it refreshes:
 *   1. `GA4_Daily`         — date, sessions, users, newUsers, conversions
 *   2. `GA4_DailyChannels` — date, channel, sessions
 *   3. `GA4_Events`        — date, eventName, channel, count
 *                            (eventName is appointment_request or phone_call_click;
 *                             channel is GA4's sessionDefaultChannelGroup — Paid Search,
 *                             Organic Search, Direct, Referral, etc.)
 *   4. `GBP_Daily`         — date, location_id, location_name,
 *                            impressions_search_mobile, impressions_search_desktop,
 *                            impressions_maps_mobile, impressions_maps_desktop,
 *                            call_clicks, direction_requests, website_clicks,
 *                            bookings, conversations
 *
 * One-time setup (5 min):
 *   1. Open the campaign Google Sheet in your browser. Click
 *      Extensions → Apps Script. Paste the contents of this file.
 *   2. In the editor, set the constants in the CONFIG section below.
 *   3. Click the project icon → Project Settings → tick "Show appsscript.json"
 *      then in appsscript.json add this oauthScopes block:
 *
 *      "oauthScopes": [
 *        "https://www.googleapis.com/auth/spreadsheets",
 *        "https://www.googleapis.com/auth/analytics.readonly",
 *        "https://www.googleapis.com/auth/business.manage",
 *        "https://www.googleapis.com/auth/script.scriptapp",
 *        "https://www.googleapis.com/auth/script.external_request"
 *      ]
 *
 *   4. In the editor sidebar: Services (+) → add
 *        - "Google Analytics Data API" (identifier: AnalyticsData)
 *      (Business Profile is called via UrlFetch + OAuth token, no service needed.)
 *
 *   5. Run the function `setupTrigger` once. Authorize when prompted.
 *      It installs a daily 03:00–04:00 ET trigger that calls `refreshAll`.
 *      You'll see a confirmation in the script editor's execution log.
 *
 * Tabs are created automatically on first run. After the first run,
 * find each new tab's gid (open the sheet, click the tab, the gid is
 * the number in the URL after `gid=`) and paste them into the
 * CAMPAIGN.sheet.gids object in index.html so the dashboard can fetch them.
 *
 * Author: Claude + Steve, 2026-05-11
 */

// ─── CONFIG ──────────────────────────────────────────────────────────
// GA4 property ID for hhs.hurleymc.com (numeric, not the G-XXX measurement id).
var GA4_PROPERTY_ID = '366812419';

// GBP location IDs. Numeric IDs from the Business Profile Manager.
// (These are confirmed for the OB/GYN Healthcare Associates clinics.)
var GBP_LOCATIONS = [
  { id: '16646406286010861765', name: 'HMC (Hurley Plaza)' },
  { id: '16097963768114038946', name: 'Dort Hwy' }
];

// How many days back to refresh on each run. Keep at least 30 so that
// late-arriving conversions and edits show up.
var DAYS_LOOKBACK = 60;

// Sheet tab names (will be auto-created if missing).
var TAB_DAILY    = 'GA4_Daily';
var TAB_CHANNELS = 'GA4_DailyChannels';
var TAB_EVENTS   = 'GA4_Events';
var TAB_GBP      = 'GBP_Daily';

// ─── ENTRY POINTS ────────────────────────────────────────────────────
function refreshAll() {
  var startDate = daysAgo(DAYS_LOOKBACK);
  var endDate   = daysAgo(1); // GA4 sometimes lags same-day data; go through yesterday
  Logger.log('refreshAll: %s → %s', startDate, endDate);

  refreshGA4Daily(startDate, endDate);
  refreshGA4DailyChannels(startDate, endDate);
  refreshGA4Events(startDate, endDate);
  refreshGBPDaily(startDate, endDate);

  Logger.log('refreshAll: done');
}

function setupTrigger() {
  // Remove existing triggers for refreshAll
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'refreshAll') ScriptApp.deleteTrigger(t);
  });
  // Daily at 3am in the script's timezone (set to ET in Project Settings)
  ScriptApp.newTrigger('refreshAll').timeBased().atHour(3).everyDays(1).create();
  Logger.log('Daily trigger installed (3am).');
  // Run once now so the sheet is populated
  refreshAll();
}

// ─── GA4: per-day sessions / users / newUsers / conversions ──────────
function refreshGA4Daily(startDate, endDate) {
  var report = AnalyticsData.Properties.runReport({
    dateRanges: [{ startDate: startDate, endDate: endDate }],
    dimensions: [{ name: 'date' }],
    metrics: [
      { name: 'sessions' },
      { name: 'totalUsers' },
      { name: 'newUsers' },
      { name: 'conversions' }
    ],
    orderBys: [{ dimension: { dimensionName: 'date' } }]
  }, 'properties/' + GA4_PROPERTY_ID);

  var rows = [];
  (report.rows || []).forEach(function(r) {
    rows.push([
      ymd(r.dimensionValues[0].value),
      Number(r.metricValues[0].value) || 0,
      Number(r.metricValues[1].value) || 0,
      Number(r.metricValues[2].value) || 0,
      Number(r.metricValues[3].value) || 0
    ]);
  });

  writeTab(TAB_DAILY, ['date', 'sessions', 'users', 'newUsers', 'conversions'], rows);
}

// ─── GA4: per-day default channel grouping ───────────────────────────
function refreshGA4DailyChannels(startDate, endDate) {
  var report = AnalyticsData.Properties.runReport({
    dateRanges: [{ startDate: startDate, endDate: endDate }],
    dimensions: [{ name: 'date' }, { name: 'sessionDefaultChannelGroup' }],
    metrics: [{ name: 'sessions' }],
    orderBys: [{ dimension: { dimensionName: 'date' } }]
  }, 'properties/' + GA4_PROPERTY_ID);

  var rows = [];
  (report.rows || []).forEach(function(r) {
    rows.push([
      ymd(r.dimensionValues[0].value),
      r.dimensionValues[1].value,
      Number(r.metricValues[0].value) || 0
    ]);
  });

  writeTab(TAB_CHANNELS, ['date', 'channel', 'sessions'], rows);
}

// ─── GA4: per-day event counts × channel for inquiry events ──────────
// Output is long-form: one row per (date, eventName, channel). The dashboard
// pivots it into totals + paid/organic splits on the fly.
function refreshGA4Events(startDate, endDate) {
  var report = AnalyticsData.Properties.runReport({
    dateRanges: [{ startDate: startDate, endDate: endDate }],
    dimensions: [
      { name: 'date' },
      { name: 'eventName' },
      { name: 'sessionDefaultChannelGroup' }
    ],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: {
      filter: {
        fieldName: 'eventName',
        inListFilter: { values: ['appointment_request', 'phone_call_click'] }
      }
    },
    orderBys: [{ dimension: { dimensionName: 'date' } }]
  }, 'properties/' + GA4_PROPERTY_ID);

  var rows = (report.rows || []).map(function(r) {
    return [
      ymd(r.dimensionValues[0].value),
      r.dimensionValues[1].value,
      r.dimensionValues[2].value,
      Number(r.metricValues[0].value) || 0
    ];
  });

  writeTab(TAB_EVENTS, ['date', 'eventName', 'channel', 'count'], rows);
}

// ─── GBP: per-day per-location metrics ───────────────────────────────
function refreshGBPDaily(startDate, endDate) {
  var headers = ['date', 'location_id', 'location_name',
                 'impressions_search_mobile', 'impressions_search_desktop',
                 'impressions_maps_mobile', 'impressions_maps_desktop',
                 'call_clicks', 'direction_requests', 'website_clicks',
                 'bookings', 'conversations'];
  var metricMap = {
    BUSINESS_IMPRESSIONS_MOBILE_SEARCH:  'impressions_search_mobile',
    BUSINESS_IMPRESSIONS_DESKTOP_SEARCH: 'impressions_search_desktop',
    BUSINESS_IMPRESSIONS_MOBILE_MAPS:    'impressions_maps_mobile',
    BUSINESS_IMPRESSIONS_DESKTOP_MAPS:   'impressions_maps_desktop',
    CALL_CLICKS:                         'call_clicks',
    BUSINESS_DIRECTION_REQUESTS:         'direction_requests',
    WEBSITE_CLICKS:                      'website_clicks',
    BUSINESS_BOOKINGS:                   'bookings',
    BUSINESS_CONVERSATIONS:              'conversations'
  };

  var allRows = [];
  GBP_LOCATIONS.forEach(function(loc) {
    var rowsByDate = {};
    // Performance API takes one request per metric set; fetchMultiDailyMetricsTimeSeries handles up to 25 metrics
    var url = 'https://businessprofileperformance.googleapis.com/v1/locations/' + loc.id +
              ':fetchMultiDailyMetricsTimeSeries' +
              '?dailyMetrics=' + Object.keys(metricMap).join('&dailyMetrics=') +
              '&dailyRange.startDate.year='  + parseInt(startDate.split('-')[0], 10) +
              '&dailyRange.startDate.month=' + parseInt(startDate.split('-')[1], 10) +
              '&dailyRange.startDate.day='   + parseInt(startDate.split('-')[2], 10) +
              '&dailyRange.endDate.year='    + parseInt(endDate.split('-')[0], 10) +
              '&dailyRange.endDate.month='   + parseInt(endDate.split('-')[1], 10) +
              '&dailyRange.endDate.day='     + parseInt(endDate.split('-')[2], 10);

    var resp = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) {
      Logger.log('GBP fetch failed for %s: %s %s', loc.id, resp.getResponseCode(), resp.getContentText().substring(0, 500));
      return;
    }
    var data = JSON.parse(resp.getContentText());
    var series = data.multiDailyMetricTimeSeries || [];
    series.forEach(function(group) {
      (group.dailyMetricTimeSeries || []).forEach(function(s) {
        var metricName = s.dailyMetric;
        var key = metricMap[metricName];
        if (!key) return;
        (s.timeSeries.datedValues || []).forEach(function(dv) {
          var dateStr = String(dv.date.year) + '-' +
                        pad2(dv.date.month) + '-' + pad2(dv.date.day);
          if (!rowsByDate[dateStr]) rowsByDate[dateStr] = blankGbpRow(loc, dateStr);
          rowsByDate[dateStr][key] = Number(dv.value) || 0;
        });
      });
    });

    Object.keys(rowsByDate).sort().forEach(function(d) {
      var r = rowsByDate[d];
      allRows.push([
        r.date, r.location_id, r.location_name,
        r.impressions_search_mobile, r.impressions_search_desktop,
        r.impressions_maps_mobile, r.impressions_maps_desktop,
        r.call_clicks, r.direction_requests, r.website_clicks,
        r.bookings, r.conversations
      ]);
    });
  });

  writeTab(TAB_GBP, headers, allRows);
}

function blankGbpRow(loc, dateStr) {
  return {
    date: dateStr, location_id: loc.id, location_name: loc.name,
    impressions_search_mobile: 0, impressions_search_desktop: 0,
    impressions_maps_mobile: 0, impressions_maps_desktop: 0,
    call_clicks: 0, direction_requests: 0, website_clicks: 0,
    bookings: 0, conversations: 0
  };
}

// ─── HELPERS ─────────────────────────────────────────────────────────
function writeTab(name, header, rows) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  sheet.clearContents();
  if (rows.length === 0) {
    sheet.getRange(1, 1, 1, header.length).setValues([header]);
    Logger.log('%s: 0 rows written (no data in range)', name);
    return;
  }
  sheet.getRange(1, 1, 1, header.length).setValues([header]);
  sheet.getRange(2, 1, rows.length, header.length).setValues(rows);
  sheet.setFrozenRows(1);
  Logger.log('%s: %s rows written', name, rows.length);
}

function daysAgo(n) {
  var d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().substring(0, 10);
}

function ymd(yyyymmdd) {
  // GA4 returns date as 'YYYYMMDD'; convert to 'YYYY-MM-DD'.
  return yyyymmdd.substring(0, 4) + '-' + yyyymmdd.substring(4, 6) + '-' + yyyymmdd.substring(6, 8);
}

function pad2(n) { return String(n).padStart(2, '0'); }
