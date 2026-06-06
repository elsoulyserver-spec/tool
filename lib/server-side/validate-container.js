'use strict';
/**
 * validate-container.js  -  Pre-export validator for EasyTrack sGTM Server
 * Container exports. Runs the full checklist before a container is shipped to
 * GTM so a broken export can never reach "Admin > Import Container".
 *
 * Usage (CLI):   node lib/server-side/validate-container.js <export.json>
 * Usage (code):  const { validateServerContainer } = require('./validate-container');
 *                const { ok, errors, warnings, checks } = validateServerContainer(obj);
 *
 * Checks: JSON validity, GTM export schema basics, Sandboxed-JS compatibility
 * (no regex literals / try-catch / non-ASCII / NUL / Object.keys-without-require),
 * valid require() APIs, and credential hygiene (no URLs in pixelId/accessToken/...).
 */

// APIs that are legal to require() in a server-side sandboxed template.
var VALID_REQUIRES = {
  sendHttpRequest:1, sendPixel:1, JSON:1, Math:1, Object:1, Promise:1,
  sha256:1, sha256Sync:1, hmacSha256:1, hmacSha256Sync:1,
  makeNumber:1, makeString:1, makeInteger:1, makeTableMap:1,
  logToConsole:1, getTimestampMillis:1, getTimestamp:1, getType:1,
  getAllEventData:1, getEventData:1, getRequestHeader:1, getRequestBody:1,
  setResponseBody:1, setResponseHeader:1, setResponseStatus:1,
  encodeUriComponent:1, decodeUriComponent:1, encodeUri:1, decodeUri:1,
  parseUrl:1, fromBase64:1, toBase64:1, computeEffectiveTldPlusOne:1,
  createRegex:1, testRegex:1, getContainerVersion:1, getRemoteAddress:1,
  extractEventsFromMpv1:1, returnResponse:1, claimRequest:1, runContainer:1
};
// Tag-parameter keys that must never hold a URL.
var CRED_KEYS = { pixelId:1, accessToken:1, apiToken:1, pixelCode:1,
                  conversionId:1, conversionLabel:1, customerId:1, developerToken:1 };

function looksLikeUrl(v) {
  var s = String(v == null ? '' : v).toLowerCase();
  return s.indexOf('http://') === 0 || s.indexOf('https://') === 0 ||
         s.indexOf('://') !== -1 || s.indexOf('easytrac.io') !== -1;
}

function validateServerContainer(container) {
  var errors = [], warnings = [], checks = 0;
  function err(m){ errors.push(m); }
  function warn(m){ warnings.push(m); }

  // 1) JSON validity / serializable
  checks++;
  try { JSON.parse(JSON.stringify(container)); }
  catch (e) { err('container is not JSON-serializable: ' + e.message); }

  // 2) Schema basics
  var cv = container && container.containerVersion;
  checks++; if (!cv) { err('missing containerVersion'); return _result(); }
  checks++; if (!cv.container) err('missing containerVersion.container');
  checks++;
  if (!cv.container || (cv.container.usageContext || []).indexOf('SERVER') === -1)
    err('container.usageContext must include "SERVER" for an sGTM export');

  // 3) Custom templates -> sandboxed JS compatibility
  var tpls = cv.customTemplate || [];
  checks++; if (!tpls.length) warn('no customTemplate[] present in export');
  for (var i = 0; i < tpls.length; i++) {
    var nm = tpls[i].name || ('customTemplate#' + i);
    var td = tpls[i].templateData || '';
    checks++; if (!td) { err(nm + ': empty templateData'); continue; }
    checks++; if (td.indexOf('___SANDBOXED_JS_FOR_SERVER___') === -1)
      err(nm + ': templateData missing ___SANDBOXED_JS_FOR_SERVER___ section');

    var js = td.split('___SANDBOXED_JS_FOR_SERVER___')[1] || '';
    js = js.split('___SERVER_PERMISSIONS___')[0];

    checks++; if (/(?:=|\(|,|return|&&|\|\||:|\?)\s*\/[^\/*\s]/.test(js) || /\.test\s*\(/.test(js) || /new RegExp/.test(js))
      err(nm + ': regex literal / .test() / new RegExp in sandboxed JS (use createRegex/testRegex or string logic)');
    checks++; if (/\btry\s*\{/.test(js) || /\}\s*catch/.test(js))
      err(nm + ': try/catch is not supported by the GTM sandbox');
    checks++; if (/\bconst\s+\w/.test(js) || /\blet\s+\w/.test(js))
      err(nm + ': const/let declaration in sandboxed JS (GTM parser rejects these; use var)');
    checks++; if (/\}\)\.catch\s*\(/.test(js))
      err(nm + ': .then().catch() chain in sandboxed JS (use two-arg .then(onFulfilled, onRejected) instead)');
    checks++; if (/[^\x00-\x7F]/.test(td))
      err(nm + ': non-ASCII character in templateData (strip emojis/em-dashes/smart quotes)');
    checks++; if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(td))
      err(nm + ': NUL/control byte in templateData');
    checks++; if (/\bnew\s+[A-Z]/.test(js))
      err(nm + ': "new" keyword is not supported by the GTM sandbox');
    checks++; if (/Object\.keys\s*\(/.test(js) && js.indexOf("require('Object')") === -1)
      err(nm + ": Object.keys used without const Object = require('Object')");

    // require() API validity
    var m, re = /require\('([^']+)'\)/g;
    while ((m = re.exec(js)) !== null) {
      checks++;
      if (!VALID_REQUIRES[m[1]]) err(nm + ": require('" + m[1] + "') is not a valid GTM server API");
    }
  }

  // 4) Tag / credential hygiene + structural checks
  var tags = cv.tag || [];
  for (var t = 0; t < tags.length; t++) {
    var tn = tags[t].name || ('tag#' + t);
    var params = tags[t].parameter || [];
    checks++; if (!tags[t].type) err(tn + ': tag missing "type"');
    checks++; if (!(tags[t].firingTriggerId || []).length) warn(tn + ': tag has no firingTriggerId');
    for (var p = 0; p < params.length; p++) {
      var key = params[p].key, val = params[p].value;
      if (!CRED_KEYS[key]) continue;
      checks++;
      if (looksLikeUrl(val)) err(tn + ': credential field "' + key + '" contains a URL (' + val + ')');
      else if (!val) warn(tn + ': credential field "' + key + '" is empty');
      else if (/^YOUR_|XXXX|^LABEL_|^AW-?XXXX/.test(String(val))) warn(tn + ': credential field "' + key + '" is a placeholder (' + val + ')');
    }
  }

  // 5) Triggers / clients / variables present
  checks++; if (!(cv.client || []).length) warn('no client[] in server container (a GA4 client is normally required)');
  checks++; if (!(cv.trigger || []).length) warn('no trigger[] in server container');

  // 6) Whole-export ASCII guard
  checks++; if (/[^\x00-\x7F]/.test(JSON.stringify(container)))
    warn('export contains non-ASCII characters somewhere (names/notes)');

  function _result(){ return { ok: errors.length === 0, errors: errors, warnings: warnings, checks: checks }; }
  return _result();
}

module.exports = { validateServerContainer: validateServerContainer };

// CLI
if (require.main === module) {
  var fs = require('fs');
  var file = process.argv[2];
  if (!file) { console.error('usage: node validate-container.js <export.json>'); process.exit(2); }
  var raw = fs.readFileSync(file, 'utf8');
  var obj;
  try { obj = JSON.parse(raw); } catch (e) { console.error('INVALID JSON: ' + e.message); process.exit(1); }
  var r = validateServerContainer(obj);
  console.log('checks run : ' + r.checks);
  console.log('errors     : ' + r.errors.length);
  r.errors.forEach(function(e){ console.log('  ERROR  ' + e); });
  console.log('warnings   : ' + r.warnings.length);
  r.warnings.forEach(function(w){ console.log('  warn   ' + w); });
  console.log(r.ok ? 'RESULT: PASS - safe to import' : 'RESULT: FAIL - do not import');
  process.exit(r.ok ? 0 : 1);
}
