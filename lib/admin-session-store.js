'use strict';

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN SESSION STORE — storage-agnostic key/value backend for admin sessions.
//
// The authentication flow (lib/admin-session.js) talks only to this small async
// interface, so the backing store can be swapped — in-memory for launch, Redis or
// Firestore later — WITHOUT touching the auth flow.
//
// Interface (all async):
//   get(token)          → session object | null
//   set(token, session) → void
//   delete(token)       → boolean (true if a value was removed)
//   list()              → array of [token, session] pairs (for pruning)
//   clear()             → void (test/maintenance)
//
// Sessions are opaque JSON-serializable objects. Expiry/TTL semantics live in the
// auth layer, not here, so the store stays a dumb KV that any backend can model.
// ══════════════════════════════════════════════════════════════════════════════

function createInMemoryStore() {
  const map = new Map();
  return {
    kind: 'memory',
    async get(token) {
      return map.has(token) ? map.get(token) : null;
    },
    async set(token, session) {
      map.set(token, session);
    },
    async delete(token) {
      return map.delete(token);
    },
    async list() {
      return Array.from(map.entries());
    },
    async clear() {
      map.clear();
    },
  };
}

module.exports = { createInMemoryStore };
