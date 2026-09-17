'use strict';
// Send-order candidates around a "fast first pass" (units in greedy order = decreasing importance, each once) for the
// prim codec, shared by sim/schedule-fastfirst.js (numbers) and sim/fastfirst-visual.js (pictures).
//   sqrt            square-root rule from the start (current default of the senders)
//   fast            units 0..N-1 once, then sqrt
//   fast+sqrt/4     first pass where every 4th slot is taken by the global sqrt rule, then sqrt
//   fast+baseB/k    first pass where every k-th slot re-sends the next unit of the cycle 0..B-1 (the most important
//                   units: background + coarse shapes), then sqrt
//   fast+sqrtB/k    like baseB/k, but the filler slots follow the sqrt rule restricted to units 0..B-1
// A viewer who joins during the first pass gets the coarse image from the filler slots instead of waiting for the pass
// to end; viewers present from the start pay one filler slot out of k.
const T = require('./transport');

function firstPassWith(N, k, filler, after) {
  const seq = [];
  let next = 0, fk = 0, ak = 0;
  return slot => {
    while (seq.length <= slot) {
      const j = seq.length;
      if (next < N) {
        if (k > 0 && j % k === k - 1) seq.push(filler(fk++));
        else seq.push(next++);
      } else seq.push(after(ak++));
    }
    return seq[slot];
  };
}

// returns [[label, scheduleFn], ...]; each call builds fresh (stateful) schedules
function candidates(N, gains) {
  const sqrt = () => T.makeSchedule(N, { type: 'sqrt', alpha: 0 }, 1, gains);
  const sqrtFirst = B => { const b = Math.min(B, N); return T.makeSchedule(b, { type: 'sqrt', alpha: 0 }, 1, gains.slice(0, b)); };
  const list = [
    ['sqrt', sqrt()],
    ['fast', firstPassWith(N, 0, null, sqrt())],
    ['fast+sqrt/8', firstPassWith(N, 8, sqrt(), sqrt())],
    ['fast+sqrt/4', firstPassWith(N, 4, sqrt(), sqrt())],
  ];
  for (const [B, k] of [[8, 8], [16, 8], [16, 4], [32, 8], [64, 8], [64, 4], [128, 4]]) {
    const b = Math.min(B, N);
    list.push([`fast+base${B}/${k}`, firstPassWith(N, k, i => i % b, sqrt())]);
  }
  for (const [B, k] of [[16, 8], [32, 8], [32, 4], [64, 4], [128, 4]]) list.push([`fast+sqrt${B}/${k}`, firstPassWith(N, k, sqrtFirst(B), sqrt())]);
  return list;
}

module.exports = { candidates, firstPassWith };
