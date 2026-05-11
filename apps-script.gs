/**
 * HHS Dashboard — Extension functions to add to the existing v4 script
 * ====================================================================
 * Steve already has v4 of `HHS Updates` Apps Script running. It populates:
 *   - GA4_Daily       date, Sessions, Users, New Users, Conversions
 *   - GA4_Channels    Date, Channel, Sessions   (per-day; published 2026-05-11)
 *   - GA4_Pages       (per-page metrics)
 *   - ShortLinks      (Short.io clicks)
 *
 * What's missing for the dashboard's filter-everything goal:
 *   - GA4_Events      Date, eventName, channel, count
 *                     (for paid-vs-organic inquiry attribution)
 *   - GBP_Daily       per-day per-location impressions / calls / directions / clicks
 *   - Alchemer        per-response feed (replaces the buggy Zap)
 *
 * THIS FILE = three drop-in functions + a one-line addition to fetchAllData().
 * Paste at the bottom of Code.gs in the "HHS Updates" Apps Script project.
 *
 * Required setup beyond what's already in place:
 *   1. Add a new OAuth scope for GBP. Open Project Settings → tick
 *      "Show appsscript.json", and add to the oauthScopes array:
 *        "https://www.googleapis.com/auth/business.manage"
 *   2. Set ALCHEMER_API_KEY + ALCHEMER_API_SECRET below (Account → Security →
 *      API Access in Alchemer; the existing key from Sep 2016 works).
 *   3. After first run, Publish to web → add GA4_Events + GBP_Daily +
 *      Alchemer_Responses tabs so the dashboard can fetch their CSVs.
 *   4. Send me each new tab's gid (number after gid= in the URL when you
 *      click the tab); I'll wire them into CAMPAIGN.sheet.gids.
 */

// ─── ADD-ON CONFIG ────────────────────────────────────────────────────
var ALCHEMER_API_KEY    = 'REPLACE_ME_ALCHEMER_KEY';
var ALCHEMER_API_SECRET = 'REPLACE_ME_ALCHEMER_SECRET';
var ALCHEMER_SURVEY_ID  = '8781626'; // HHS: Request an Appointment

var GBP_LOCATIONS_ADDON = [
  { id: '16646406286010861765', name: 'HMC (Hurley Plaza)' },
  { id: '16097963768114038946', name: 'Dort Hwy' }
];

// How many days back the GBP + Events refresh should pull on each run.
var ADDON_DAYS_LOOKBACK = 90;

// ─── INTEGRATE WITH EXISTING fetchAllData ─────────────────────────────
// Replace your existing fetchAllData() with this version (or just add the
// three new function calls inside the existing one):
//
//   function fetchAllData() {
//     fetchGA4Daily();
//     fetchGA4Channels();
//     fetchGA4Pages();
//     fetchShortIoClicks();
//     fetchGA4Events();         // <-- new
//     fetchGBPDaily();          // <-- new
//     fetchAlchemerResponses(); // <-- new
//     Logger.log('All data updated at ' + new Date().toISOString());
//   }

// ─── fetchGA4Events: per-day appointment + phone events × channel ─────
function fetchGA4Events() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('GA4_Events') || ss.insertSheet('GA4_Events');
  sheet.clear();

  var endDate = Utilities.formatDate(new Date(), 'America/Detroit', 'yyyy-MM-dd');
  var startDate = Utilities.formatDate(new Date(Date.now() - ADDON_DAYS_LOOKBACK * 86400000), 'America/Detroit', 'yyyy-MM-dd');

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
    orderBys: [{ dimension: { dimensionName: 'date' } }],
    limit: 10000
  }, 'properties/' + GA4_PROPERTY_ID); // GA4_PROPERTY_ID already declared at top of v4

  sheet.appendRow(['date', 'eventName', 'channel', 'count']);
  if (report.rows) {
    report.rows.forEach(function(r) {
      var d = r.dimensionValues[0].value;
      sheet.appendRow([
        d.substring(0,4) + '-' + d.substring(4,6) + '-' + d.substring(6,8),
        r.dimensionValues[1].value,
        r.dimensionValues[2].value,
        parseInt(r.metricValues[0].value) || 0
      ]);
    });
  }
  sheet.setFrozenRows(1);
  Logger.log('GA4_Events: ' + (report.rows ? report.rows.length : 0) + ' rows');
}

// ─── fetchGBPDaily: per-day per-location GBP Performance metrics ──────
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

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('GBP_Daily') || ss.insertSheet('GBP_Daily');
  sheet.clear();
  sheet.appendRow(headers);

  var end = new Date();
  var start = new Date(Date.now() - ADDON_DAYS_LOOKBACK * 86400000);
  var qs = 'dailyMetrics=' + Object.keys(metricMap).join('&dailyMetrics=') +
           '&dailyRange.startDate.year='  + start.getFullYear() +
           '&dailyRange.startDate.month=' + (start.getMonth() + 1) +
           '&dailyRange.startDate.day='   + start.getDate() +
           '&dailyRange.endDate.year='    + end.getFullYear() +
           '&dailyRange.endDate.month='   + (end.getMonth() + 1) +
           '&dailyRange.endDate.day='     + end.getDate();

  var totalRows = 0;
  GBP_LOCATIONS_ADDON.forEach(function(loc) {
    var url = 'https://businessprofileperformance.googleapis.com/v1/locations/' + loc.id + ':fetchMultiDailyMetricsTimeSeries?' + qs;
    var resp = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) {
      Logger.log('GBP fetch failed for ' + loc.id + ': ' + resp.getResponseCode() + ' ' + resp.getContentText().substring(0, 300));
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
          if (!byDate[dateStr]) byDate[dateStr] = { date: dateStr, location_id: loc.id, location_name: loc.name,
            impressions_search_mobile: 0, impressions_search_desktop: 0,
            impressions_maps_mobile: 0, impressions_maps_desktop: 0,
            call_clicks: 0, direction_requests: 0, website_clicks: 0,
            bookings: 0, conversations: 0 };
          byDate[dateStr][key] = Number(dv.value) || 0;
        });
      });
    });
    Object.keys(byDate).sort().forEach(function(d) {
      var r = byDate[d];
      sheet.appendRow([r.date, r.location_id, r.location_name,
        r.impressions_search_mobile, r.impressions_search_desktop,
        r.impressions_maps_mobile, r.impressions_maps_desktop,
        r.call_clicks, r.direction_requests, r.website_clicks,
        r.bookings, r.conversations]);
      totalRows++;
    });
  });
  sheet.setFrozenRows(1);
  Logger.log('GBP_Daily: ' + totalRows + ' rows');
}

// ─── fetchAlchemerResponses: pull all completed survey responses ──────
function fetchAlchemerResponses() {
  if (ALCHEMER_API_KEY.indexOf('REPLACE_ME') === 0) {
    Logger.log('Alchemer keys not set — skipping. Edit the script and fill ALCHEMER_API_KEY + ALCHEMER_API_SECRET.');
    return;
  }
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Alchemer_Responses') || ss.insertSheet('Alchemer_Responses');
  sheet.clear();
  sheet.appendRow(['response_id', 'date_submitted', 'provider_answer', 'message', 'city', 'country', 'referer']);

  var page = 1, total = 0;
  while (page < 20) { // safety cap
    var url = 'https://api.alchemer.com/v5/survey/' + ALCHEMER_SURVEY_ID + '/surveyresponse' +
              '?resultsperpage=100&page=' + page +
              '&filter[field][0]=status&filter[operator][0]==&filter[value][0]=Complete' +
              '&api_token=' + encodeURIComponent(ALCHEMER_API_KEY) +
              '&api_token_secret=' + encodeURIComponent(ALCHEMER_API_SECRET);
    var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) { Logger.log('Alchemer fetch failed: ' + resp.getContentText().substring(0,300)); break; }
    var j = JSON.parse(resp.getContentText());
    var data = j.data || [];
    if (!data.length) break;
    data.forEach(function(d) {
      var providerAns = (d.survey_data && d.survey_data['59'] && d.survey_data['59'].answer) || 'No preference';
      var msg = (d.survey_data && d.survey_data['31'] && d.survey_data['31'].answer) || '';
      sheet.appendRow([d.id, d.date_submitted, providerAns, msg, d.city || '', d.country || '', d.referer || '']);
      total++;
    });
    if (data.length < 100) break;
    page++;
  }
  sheet.setFrozenRows(1);
  Logger.log('Alchemer_Responses: ' + total + ' rows');
}

// ─── helper ─────────────────────────────────────────────────────────
function pad2(n) { return n < 10 ? '0' + n : '' + n; }
