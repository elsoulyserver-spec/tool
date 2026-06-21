// ══════════════════════════════════════════════════════════════════════════════
// lib/http-timeout.js
// One outbound request with THREE bounded timeout layers so a stalled peer can
// never hang a worker forever:
//   • connect  — armed at start, cleared once the socket connects
//   • response — self-managed INACTIVITY timer (re-armed on connect + each chunk)
//   • overall  — absolute hard deadline regardless of phase
//
// All three are OUR OWN timers (not req.setTimeout, which binds to the pooled
// keep-alive socket and would outlive this request → stale fires / socket churn).
// Every timer is cleared in clearAll() the instant the promise settles, so there
// is no resource/timer leak and no double settle. On any breach the request is
// destroyed (frees the socket + listeners) and the promise rejects with a
// retryable error (`code:'ETIMEDOUT', timeout:true`).
//
// Success shape ({ status, data:<rawString> }) is unchanged from the old inline
// https call, so callers that JSON.parse the body see no behavioral difference.
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const http  = require('http');
const https = require('https');

function requestWithTimeouts(opts, body, timeouts) {
  const { connectMs = 0, responseMs = 0, overallMs = 0 } = timeouts || {};
  const transport = opts.protocol === 'http:' ? http : https;

  return new Promise((resolve, reject) => {
    let settled      = false;
    let connectTimer = null;
    let idleTimer    = null;
    let overallTimer = null;

    const clearAll = () => {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      if (idleTimer)    { clearTimeout(idleTimer);    idleTimer    = null; }
      if (overallTimer) { clearTimeout(overallTimer); overallTimer = null; }
    };
    const finish = (cb, val) => {
      if (settled) return;                 // single settle — no double resolve/reject
      settled = true;
      clearAll();                          // every timer is ours → all released here
      cb(val);
    };
    const fail = (msg) => {
      const e = new Error(msg);
      e.code    = 'ETIMEDOUT';
      e.timeout = true;                    // marker: caller MAY retry idempotent ops
      try { if (req) req.destroy(); } catch (_) { /* already gone */ }
      finish(reject, e);
    };
    // Self-managed inactivity timer. Re-armed whenever we make progress; cleared on
    // settle. Never touches the socket's own timeout, so it can't leak onto a
    // reused keep-alive socket.
    const armIdle = () => {
      if (responseMs <= 0 || settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => fail('response/inactivity timeout after ' + responseMs + 'ms'), responseMs);
    };

    const req = transport.request(opts, (res) => {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      armIdle();
      let data = '';
      res.setEncoding('utf8');
      res.on('data',  (c)   => { data += c; armIdle(); });   // reset inactivity each chunk
      res.on('end',   ()    => finish(resolve, { status: res.statusCode, data }));
      res.on('error', (err) => { try { req.destroy(); } catch (_) {} finish(reject, err); });
    });

    if (connectMs > 0) {
      connectTimer = setTimeout(() => fail('connect timeout after ' + connectMs + 'ms'), connectMs);
    }
    req.on('socket', (socket) => {
      const onConnect = () => {
        if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
        armIdle();                         // "connected but no headers yet" is covered
      };
      if (socket.connecting) socket.once('connect', onConnect);
      else onConnect();                    // reused keep-alive socket — already connected
    });

    if (overallMs > 0) {
      overallTimer = setTimeout(() => fail('overall deadline exceeded ' + overallMs + 'ms'), overallMs);
    }

    req.on('error', (err) => { if (!settled) finish(reject, err); });
    if (body) req.write(body);
    req.end();
  });
}

module.exports = { requestWithTimeouts };
