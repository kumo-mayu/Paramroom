'use strict';
// Training images (disjoint from the test set) for static tables baked into the avatar.
const fs = require('fs');
const path = require('path');
const I = require('../lib/image');

let cache = null;
function trainingImages() {
  if (!cache) {
    const dir = path.join(__dirname, '..', 'images', 'ref-train');
    cache = fs.readdirSync(dir).filter(f => f.endsWith('.png')).map(f => I.loadPNG(path.join(dir, f)));
  }
  return cache;
}
module.exports = { trainingImages };
