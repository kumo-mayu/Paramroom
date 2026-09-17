'use strict';
// Build 256x256 reference images (test set) and training set from images/src and images/train.
const fs = require('fs');
const path = require('path');
const I = require('./lib/image');

const SIZE = Number(process.argv[2] || 256); // node prepare.js [256|512] -> images/ref (256) or images/ref512
const out = path.join(__dirname, 'images', SIZE === 256 ? 'ref' : 'ref' + SIZE);
const outTrain = path.join(__dirname, 'images', SIZE === 256 ? 'ref-train' : 'ref' + SIZE + '-train');
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(outTrain, { recursive: true });

function squareCenter(img) {
  const s = Math.min(img.w, img.h);
  return I.crop(img, (img.w - s) >> 1, (img.h - s) >> 1, s, s);
}

const specs = {
  // photos (Kodak): center square crop
  kodim01: squareCenter, kodim03: squareCenter, kodim04: squareCenter, kodim05: squareCenter,
  kodim07: squareCenter, kodim08: squareCenter, kodim15: squareCenter, kodim19: squareCenter,
  kodim20: squareCenter, kodim23: squareCenter,
  // illustrations / screenshot
  illust_wikipetan_face: squareCenter,
  illust_tux: img => I.crop(img, 0, 0, img.w, img.w),
  screenshot_wikipedia: img => I.crop(img, 0, 0, 480, 480),
  illust_pc_newyear: squareCenter,
  illust_chibi: img => I.crop(img, 0, 0, img.w, img.w),
  screenshot_mahara: img => I.crop(img, 0, 0, 480, 480),
};

for (const [name, fn] of Object.entries(specs)) {
  const img = fn(I.loadPNG(path.join(__dirname, 'images', 'src', name + '.png')));
  I.savePNG(I.quantize8(I.resize(img, SIZE, SIZE)), path.join(out, name + '.png'));
}
for (const f of fs.readdirSync(path.join(__dirname, 'images', 'train'))) {
  const img = squareCenter(I.loadPNG(path.join(__dirname, 'images', 'train', f)));
  I.savePNG(I.quantize8(I.resize(img, SIZE, SIZE)), path.join(outTrain, f));
}
console.log('done');
