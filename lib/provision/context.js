'use strict';

const crypto = require('crypto');

function slugFor(clientId) {
  return crypto.createHash('sha256').update(String(clientId)).digest('hex').slice(0, 12);
}

function baseDomain() {
  return (process.env.SGTM_BASE_DOMAIN || 'sgtm.easytrac.io').trim();
}

function urlsForSlug(slug) {
  const domain = baseDomain();
  return {
    publicServerUrl:  `https://${slug}.${domain}`,
    previewPublicUrl: `https://${slug}-preview.${domain}`,
  };
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

module.exports = { slugFor, urlsForSlug, sha256 };
