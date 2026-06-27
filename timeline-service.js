'use strict';

const firestoreService = require('../firestore-service');

const DEDUPE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

async function record({ clientId, eventType, actorType, actorId, summary, meta, isMilestone, dedupeKey }) {
  if (!clientId)   throw new Error('timeline-service.record: clientId is required');
  if (!eventType)  throw new Error('timeline-service.record: eventType is required');
  if (!summary)    throw new Error('timeline-service.record: summary is required');

  if (dedupeKey) {
    const recent = await firestoreService.findRecentTimelineEvent(
      clientId, eventType, dedupeKey, DEDUPE_WINDOW_MS
    );
    if (recent) return;
  }

  await firestoreService.saveTimelineEvent({
    clientId,
    eventType,
    actorType:   actorType   || 'system',
    actorId:     actorId     || null,
    summary,
    meta:        meta        || null,
    isMilestone: isMilestone || false,
    dedupeKey:   dedupeKey   || null,
  });
}

module.exports = { record };
