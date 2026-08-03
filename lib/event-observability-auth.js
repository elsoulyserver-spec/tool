'use strict';

const DUMMY_HASH = '0'.repeat(64);

async function authenticateApiKey(rawKey, apiKeyService, firestoreService) {
  const parsed = apiKeyService.parse(rawKey);
  if (!parsed) {
    apiKeyService.verify(rawKey, DUMMY_HASH);
    const error = new Error('invalid api key format'); error.status = 401; throw error;
  }
  let keyDoc;
  try { keyDoc = await firestoreService.getApiKey(parsed.keyId); } catch (_) {}
  const valid = apiKeyService.verify(rawKey, (keyDoc && keyDoc.keyHash) || DUMMY_HASH);
  if (!valid || !keyDoc || keyDoc.status !== 'active') {
    const error = new Error('invalid or revoked api key'); error.status = 401; throw error;
  }
  return { clientId: keyDoc.clientId, keyId: parsed.keyId };
}

function authorizeOwner(decoded, targetId) {
  return !!decoded && typeof decoded.uid === 'string' && decoded.uid === targetId;
}

module.exports = { authenticateApiKey, authorizeOwner, DUMMY_HASH };
