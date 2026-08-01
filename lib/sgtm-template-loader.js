'use strict';

const fs   = require('fs');
const path = require('path');

function sanitizeTpl(text) {
  if (text == null) return null;
  return text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

function loadTpl(name) {
  try {
    const raw = fs.readFileSync(
      path.join(__dirname, 'server-side', 'sgtm-templates', name + '.tpl'),
      'utf8',
    );
    const clean = sanitizeTpl(raw);
    if (!clean || clean.indexOf('___SANDBOXED_JS_FOR_SERVER___') === -1) {
      throw new Error('template ' + name + ' is empty or missing required sections');
    }
    return clean;
  } catch (e) {
    return null;
  }
}

module.exports = { loadTpl, sanitizeTpl };
