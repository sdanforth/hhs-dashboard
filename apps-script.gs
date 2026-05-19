/**
 * HHS Dashboard ETL — Safe, validated, nightly + on-demand
 * ========================================================
 *
 * Deployed location: Apps Script project "HHS Updates" bound to the campaign
 * Google Sheet. This file is the source of truth in git; paste it over the
 * Apps Script project's Code.gs to deploy. (Use `clasp` once we set it up.)
 *
 * Why this rewrite (2026-05-19):
 *   - Old code did `sheet.clear()` then `appendRow(...)` per row. If the API
 *     fetch failed partway, the sheet was left empty and the dashboard
 *     showed blank cards until the next nightly run. This was the "boss
 *     looking at a wiped dashboard" failure mode. Fixed below.
 *   - All writes now go through `safeReplaceSheet()` which:
 *       1. Validates row count vs. existing (rejects updates that lose >20%)
 *       2. Validates column count matches expected headers
 *       3. Writes atomically via `setValues()` (one bulk call, not append loop)
 *       4. On any validation failure: aborts the write, leaves existing data
 *          intact, and logs to `Sync_Log` so the dashboard can show health.
 *   - On-demand refresh: deployed as a web app. Hit the /exec URL with
 *     `?action=update&token=XXX` to force a fresh sync from any device.
 *     Used by the hidden "Refresh now" button in the dashboard header.
 *
 * One-time setup (Steve, on the Apps Script project):
 *   1. Project Settings → Script Properties → add:
 *        UPDATE_TOKEN         = (any random string — paste into dashboard too)
 *        ALCHEMER_API_KEY     = (from app.alchemer.com → Account → Security)
 *        ALCHEMER_API_SECRET  = (same page)
 *   2. Project Settings → Show "appsscript.json" → paste the manifest in the
 *      MANIFEST comment block below.
 *   3. Select `setupTriggers` in the function dropdown → Run. Authorize all
 *      scopes when prompted. This installs the 4am ET nightly trigger AND
 *      runs one fetch immediately so all tabs populate.
 *   4. Deploy → New deployment → Type: Web app → Execute as: Me → Who has
 *      access: Anyone. Copy the /exec URL → paste into dashboard CAMPAIGN
 *      config as `updateEndpoint`.
 *
 * MANIFEST (appsscript.json):
 *   {
 *     "timeZone": "America/Detroit",
 *     "dependencies": {
 *       "enabledAdvancedServices": [
 *         { "userSymbol": "AnalyticsData", "version": "v1beta", "serviceId": "analyticsdata" }
 *       ]
 *     },
 *     "exceptionLogging": "STACKDRIVER",
 *     "runtimeVersion": "V8",
 *     "webapp": { "executeAs": "USER_DEPLOYING", "access": "ANYONE_ANONYMOUS" },
 *     "oauthScopes": [
 *       "https://www.googleapis.com/auth/spreadsheets",
 *       "https://www.googleapis.com/auth/script.external_request",
 *       "https://www.googleapis.com/auth/script.scriptapp",
 *       "https://www.googleapis.com/auth/analytics.readonly",
 *       "https://www.googleapis.com/auth/business.manage"
 *     ]
 *   }
 */

// ─── CONFIG ──────────────────────────────────────────────────────────
// GA4 property ID for HHS site. Redeclared here so this file stands alone
// even if pasted over the v4 Code.gs.
var GA4_PROPERTY_ID = '366812419';

// Survey for the appointment request form.
var ALCHEMER_SURVEY_ID = '8781626';

// GBP locations to pull daily metrics for. Add new clinics here.
var GBP_LOCATIONS = [
  { id: '16646406286010861765', name: 'HMC (Hurley Plaza)' },
  { id: '16097963768114038946', name: 'Dort Hwy' }
];

// How many days back to pull on every run. 90d gives 'Last 90 days' filter
// room without forcing a custom backfill.
var DAYS_LOOKBACK = 90;

// Validation: a sync that drops the row count below this fraction of the
// previous run is rejected. Per-source overrides below.
var DEFAULT_MIN_ROW_RATIO = 0.8;

// ─── ENTRY POINTS ────────────────────────────────────────────────────

/**
 * Web-app entry point. Deploy as web app; visit /exec?action=update&token=XXX
 * to trigger an on-demand sync. Returns JSON status. Used by the dashboard's
 * hidden "Refresh now" button.
 */
function doGet(e) {
  var params = (e && e.parameter) || {};
  var action = params.action || '';

  if (action === 'status') {
    return jsonResponse({ ok: true, ts: new Date().toISOString() });
  }

  if (action === 'update') {
    var expected = PropertiesService.getScriptProperties().getProperty('UPDATE_TOKEN');
    if (!expected) {
      return jsonResponse({ ok: false, error: 'UPDATE_TOKEN not configured' });
    }
    if (params.token !== expected) {
      return jsonResponse({ ok: false, error: 'unauthorized' });
    }
    var startMs = Date.now();
    var summary = fetchAll();
    return jsonResponse({
      ok: true,
      durationMs: Date.now() - startMs,
      timestamp: new Date().toISOString(),
      summary: summary
    });
  }

  return jsonResponse({ ok: false, error: 'unknown action; try ?action=status' });
}

/**
 * One-time setup. Installs the 4am ET nightly trigger AND runs a fetch once
 * so all tabs populate immediately.
 */
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'fetchAll') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('fetchAll').timeBased().atHour(4).everyDays(1).create();
  fetchAll();
  Logger.log('setupTriggers done. Nightly 4am trigger installed; initial fetch ran.');
}

/**
 * Master sync. Each fetcher logs independently to Sync_Log.
 * One failing source does not block the others.
 * Called by the nightly trigger AND by the on-demand web app.
 */
function fetchAll() {
  var results = {};
  results.ga4Daily         = runSafely('GA4_Daily',          fetchGA4Daily);
  results.ga4Channels      = runSafely('GA4_Channels',       fetchGA4Channels);
  results.ga4Events        = runSafely('GA4_Events',         fetchGA4Events);
  results.gbpDaily         = runSafely('GBP_Daily',          fetchGBPDaily);
  results.alchemer         = runSafely('Alchemer_Responses', fetchAlchemerResponses);
  return results;
}

function runSafely(label, fn) {
  try {
    return fn();
  } catch (e) {
    logSync(label, { ok: false, before: 0, after: 0, errors: ['EXCEPTION: ' + e] });
    Logger.log(label + ' threw: ' + e);
    return { ok: false, error: String(e) };
  }
}

// ─── SAFE WRITE + VALIDATION ─────────────────────────────────────────

/**
 * Atomic, validated replacement of a sheet's contents.
 * - Validates row count vs. existing (configurable threshold).
 * - Validates column count matches headers.
 * - Writes via setValues() (one bulk call).
 * - On failure: ABORTS write, leaves existing data intact, returns error.
 *
 * @param {string} sheetName
 * @param {string[]} headers   expected column names (first row)
 * @param {Array[]} newRows    2D array of new data rows
 * @param {{minRowRatio?:number, allowEmpty?:boolean}} opts
 * @return {{ok:boolean, before:number, after:number, errors:string[]}}
 */
function safeReplaceSheet(sheetName, headers, newRows, opts) {
  opts = opts || {};
  var minRatio = (opts.minRowRatio != null) ? opts.minRowRatio : DEFAULT_MIN_ROW_RATIO;
  var allowEmpty = !!opts.allowEmpty;

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(sheetName);
  var existing = sheet ? Math.max(0, sheet.getLastRow() - 1) : 0;
  var incoming = newRows.length;
  var errs = [];

  // Schema check
  if (incoming > 0 && newRows[0].length !== headers.length) {
    errs.push('column count mismatch: header=' + headers.length + ', row=' + newRows[0].length);
  }
  // Empty guard
  if (!allowEmpty && incoming === 0) {
    errs.push('no rows fetched (would wipe sheet of ' + existing + ' rows)');
  }
  // Drop guard
  if (existing > 0 && incoming < Math.floor(existing * minRatio)) {
    errs.push('new rows (' + incoming + ') < ' + Math.round(minRatio * 100) + '% of existing (' + existing + ')');
  }

  if (errs.length) {
    return { ok: false, before: existing, after: existing, errors: errs };
  }

  if (!sheet) sheet = ss.insertSheet(sheetName);
  sheet.clear();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (incoming > 0) {
    sheet.getRange(2, 1, incoming, headers.length).setValues(newRows);
  }
  sheet.setFrozenRows(1);
  return { ok: true, before: existing, after: incoming, errors: [] };
}

/**
 * Append a row to the Sync_Log tab. Creates the tab on first run.
 * One row per source per sync attempt.
 */
function logSync(source, result) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Sync_Log');
  if (!sheet) {
    sheet = ss.insertSheet('Sync_Log');
    sheet.appendRow(['timestamp', 'source', 'status', 'rows_before', 'rows_after', 'message']);
    sheet.setFrozenRows(1);
  }
  var ts = Utilities.formatDate(new Date(), 'America/Detroit', "yyyy-MM-dd'T'HH:mm:ssXXX");
  var msg = (result.errors && result.errors.length) ? result.errors.join('; ') : '';
  sheet.appendRow([
    ts,
    source,
    result.ok ? 'OK' : 'FAIL',
    result.before || 0,
    result.after || 0,
    msg
  ]);
  // Trim log to last 500 entries to keep the tab snappy
  var max = 500;
  if (sheet.getLastRow() > max + 1) {
    sheet.deleteRows(2, sheet.getLastRow() - max - 1);
  }
}

// ─── FETCHERS ────────────────────────────────────────────────────────

/**
 * Per-day sessions/users/conversions.
 */
function fetchGA4Daily() {
  var dateRange = lookbackDates();
  var report = AnalyticsData.Properties.runReport({
    dateRanges: [{ startDate: dateRange.start, endDate: dateRange.end }],
    dimensions: [{ name: 'date' }],
    metrics: [
      { name: 'sessions' },
      { name: 'totalUsers' },
      { name: 'newUsers' },
      { name: 'conversions' }
    ],
    orderBys: [{ dimension: { dimensionName: 'date' } }],
    limit: 1000
  }, 'properties/' + GA4_PROPERTY_ID);

  var headers = ['date', 'sessions', 'users', 'newUsers', 'conversions'];
  var rows = (report.rows || []).map(function(r) {
    return [
      ga4DateToISO(r.dimensionValues[0].value),
      parseInt(r.metricValues[0].value) || 0,
      parseInt(r.metricValues[1].value) || 0,
      parseInt(r.metricValues[2].value) || 0,
      parseFloat(r.metricValues[3].value) || 0
    ];
  });

  var result = safeReplaceSheet('GA4_Daily', headers, rows, { minRowRatio: 0.8 });
  logSync('GA4_Daily', result);
  return result;
}

/**
 * Per-day channel breakdown (sessions by channel).
 */
function fetchGA4Channels() {
  var dateRange = lookbackDates();
  var report = AnalyticsData.Properties.runReport({
    dateRanges: [{ startDate: dateRange.start, endDate: dateRange.end }],
    dimensions: [{ name: 'date' }, { name: 'sessionDefaultChannelGroup' }],
    metrics: [{ name: 'sessions' }],
    orderBys: [{ dimension: { dimensionName: 'date' } }],
    limit: 10000
  }, 'properties/' + GA4_PROPERTY_ID);

  var headers = ['date', 'channel', 'sessions'];
  var rows = (report.rows || []).map(function(r) {
    return [
      ga4DateToISO(r.dimensionValues[0].value),
      r.dimensionValues[1].value,
      parseInt(r.metricValues[0].value) || 0
    ];
  });

  var result = safeReplaceSheet('GA4_Channels', headers, rows, { minRowRatio: 0.8 });
  logSync('GA4_Channels', result);
  return result;
}

/**
 * Per-day appointment_request + phone_call_click events × channel × landingPage.
 */
function fetchGA4Events() {
  var dateRange = lookbackDates();
  var report = AnalyticsData.Properties.runReport({
    dateRanges: [{ startDate: dateRange.start, endDate: dateRange.end }],
    dimensions: [
      { name: 'date' },
      { name: 'eventName' },
      { name: 'sessionDefaultChannelGroup' },
      { name: 'landingPage' }
    ],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: {
      filter: {
        fieldName: 'eventName',
        inListFilter: { values: ['appointment_request', 'phone_call_click'] }
      }
    },
    orderBys: [{ dimension: { dimensionName: 'date' } }],
    limit: 10000
  }, 'properties/' + GA4_PROPERTY_ID);

  var headers = ['date', 'eventName', 'channel', 'landingPage', 'count'];
  var rows = (report.rows || []).map(function(r) {
    return [
      ga4DateToISO(r.dimensionValues[0].value),
      r.dimensionValues[1].value,
      r.dimensionValues[2].value,
      r.dimensionValues[3].value,
      parseInt(r.metricValues[0].value) || 0
    ];
  });

  var result = safeReplaceSheet('GA4_Events', headers, rows, { minRowRatio: 0.8 });
  logSync('GA4_Events', result);
  return result;
}

/**
 * Per-day per-location GBP Performance metrics.
 * Requires `business.manage` scope (in manifest).
 */
function fetchGBPDaily() {
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

  var end = new Date();
  var start = new Date(Date.now() - DAYS_LOOKBACK * 86400000);
  var qs = 'dailyMetrics=' + Object.keys(metricMap).join('&dailyMetrics=') +
           '&dailyRange.startDate.year='  + start.getFullYear() +
           '&dailyRange.startDate.month=' + (start.getMonth() + 1) +
           '&dailyRange.startDate.day='   + start.getDate() +
           '&dailyRange.endDate.year='    + end.getFullYear() +
           '&dailyRange.endDate.month='   + (end.getMonth() + 1) +
           '&dailyRange.endDate.day='     + end.getDate();

  var allRows = [];
  var locErrors = [];
  GBP_LOCATIONS.forEach(function(loc) {
    var url = 'https://businessprofileperformance.googleapis.com/v1/locations/' + loc.id + ':fetchMultiDailyMetricsTimeSeries?' + qs;
    var resp = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) {
      locErrors.push(loc.name + ': HTTP ' + resp.getResponseCode());
      return;
    }
    var data = JSON.parse(resp.getContentText());
    var byDate = {};
    (data.multiDailyMetricTimeSeries || []).forEach(function(group) {
      (group.dailyMetricTimeSeries || []).forEach(function(s) {
        var key = metricMap[s.dailyMetric];
        if (!key) return;
        (s.timeSeries.datedValues || []).forEach(function(dv) {
          var dateStr = dv.date.year + '-' + pad2(dv.date.month) + '-' + pad2(dv.date.day);
          if (!byDate[dateStr]) byDate[dateStr] = {
            date: dateStr, location_id: loc.id, location_name: loc.name,
            impressions_search_mobile: 0, impressions_search_desktop: 0,
            impressions_maps_mobile: 0, impressions_maps_desktop: 0,
            call_clicks: 0, direction_requests: 0, website_clicks: 0,
            bookings: 0, conversations: 0
          };
          byDate[dateStr][key] = Number(dv.value) || 0;
        });
      });
    });
    Object.keys(byDate).sort().forEach(function(d) {
      var r = byDate[d];
      allRows.push([r.date, r.location_id, r.location_name,
        r.impressions_search_mobile, r.impressions_search_desktop,
        r.impressions_maps_mobile, r.impressions_maps_desktop,
        r.call_clicks, r.direction_requests, r.website_clicks,
        r.bookings, r.conversations]);
    });
  });

  // If all locations failed, the empty-guard in safeReplaceSheet will reject
  // and preserve existing data.
  var result = safeReplaceSheet('GBP_Daily', headers, allRows, { minRowRatio: 0.8 });
  if (locErrors.length) {
    result.errors = (result.errors || []).concat(locErrors);
  }
  logSync('GBP_Daily', result);
  return result;
}

/**
 * All completed Alchemer survey responses for the appointment-request form.
 */
function fetchAlchemerResponses() {
  var props = PropertiesService.getScriptProperties();
  var apiKey = props.getProperty('ALCHEMER_API_KEY');
  var apiSecret = props.getProperty('ALCHEMER_API_SECRET');
  if (!apiKey || !apiSecret) {
    var skip = { ok: false, before: 0, after: 0, errors: ['ALCHEMER_API_KEY / SECRET not set in Script Properties'] };
    logSync('Alchemer_Responses', skip);
    return skip;
  }

  var headers = ['response_id', 'date_submitted', 'provider_answer', 'service_type', 'city', 'country', 'referer'];
  var allRows = [];
  var page = 1;
  var fetchErr = null;

  while (page < 20) {
    var url = 'https://api.alchemer.com/v5/survey/' + ALCHEMER_SURVEY_ID + '/surveyresponse' +
              '?resultsperpage=100&page=' + page +
              '&filter[field][0]=status&filter[operator][0]==&filter[value][0]=Complete' +
              '&api_token=' + encodeURIComponent(apiKey) +
              '&api_token_secret=' + encodeURIComponent(apiSecret);
    var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) {
      fetchErr = 'HTTP ' + resp.getResponseCode() + ' on page ' + page;
      break;
    }
    var j = JSON.parse(resp.getContentText());
    var data = j.data || [];
    if (!data.length) break;
    data.forEach(function(d) {
      var providerAns = (d.survey_data && d.survey_data['59'] && d.survey_data['59'].answer) || 'No preference';
      var msg = (d.survey_data && d.survey_data['31'] && d.survey_data['31'].answer) || '';
      allRows.push([d.id, d.date_submitted, providerAns, msg, d.city || '', d.country || '', d.referer || '']);
    });
    if (data.length < 100) break;
    page++;
  }

  // Alchemer responses only grow — never shrink in practice.
  var result = safeReplaceSheet('Alchemer_Responses', headers, allRows, { minRowRatio: 0.95 });
  if (fetchErr) {
    result.errors = (result.errors || []).concat([fetchErr]);
  }
  logSync('Alchemer_Responses', result);
  return result;
}

// ─── HELPERS ─────────────────────────────────────────────────────────

function lookbackDates() {
  var end = Utilities.formatDate(new Date(), 'America/Detroit', 'yyyy-MM-dd');
  var start = Utilities.formatDate(new Date(Date.now() - DAYS_LOOKBACK * 86400000), 'America/Detroit', 'yyyy-MM-dd');
  return { start: start, end: end };
}

function ga4DateToISO(yyyymmdd) {
  return yyyymmdd.substring(0,4) + '-' + yyyymmdd.substring(4,6) + '-' + yyyymmdd.substring(6,8);
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
