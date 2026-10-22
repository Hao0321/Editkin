#!/usr/bin/env node
// Seam check between two outputs (CFR media carrying the long-media identity marks).
//   --mode concat  --a A.mp4 --b B.mp4            A followed by B continues the identity timeline (video + audio)
//   --mode compare --a A.mp4 --b B.mp4 --at T     A and B carry the same media around T (pixels, identities, audio null test)
//   --mode within  --input X.mp4 --at T           no dropped/duplicated frame and exact audio marker spacing across T
// Options: --frames-each-side N, --null-threshold-db -90, --out r.json
import {evaluateSeamConcat, evaluateSeamCompare, evaluateSeamWithin} from './lib/seam.mjs';
import {main, emit} from './lib/cli.mjs';

main(async o => {
  const k = o['frames-each-side'] ? Number(o['frames-each-side']) : undefined;
  let r;
  if (o.mode === 'concat') r = await evaluateSeamConcat({a: o.a, b: o.b, framesEachSide: k ?? 3});
  else if (o.mode === 'compare') r = await evaluateSeamCompare({a: o.a, b: o.b, at: o.at, framesEachSide: k ?? 4, nullThresholdDb: o['null-threshold-db'] ? Number(o['null-threshold-db']) : -90});
  else if (o.mode === 'within') r = await evaluateSeamWithin({file: o.input, at: o.at, framesEachSide: k ?? 4});
  else throw new Error('--mode concat|compare|within');
  return emit(o, r);
});
