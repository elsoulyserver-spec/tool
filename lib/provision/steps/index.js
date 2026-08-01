'use strict';

module.exports = [
  require('./create-gtm'),
  require('./deploy-preview'),
  require('./deploy-cloudrun'),
  require('./health-check'),
  require('./publish-route'),
  require('./wire-transport'),
  require('./finalize'),
];
