#!/usr/bin/env node
// Frame-identity decode at timestamps.
//   node scripts/long-media/evaluate-frames.mjs --fixture F1-1080p30-12h [--points start,middle,9:59:59,10:00:00,11:59:59,last] [--out r.json]
//   node scripts/long-media/evaluate-frames.mjs --manifest <fixture manifest> --input <output that reproduces the fixture timeline>
// Each decoded frame proves its own index: barcode identity == index implied by its exact pts; check bits valid;
// flash only on the first frame of each second; frames around a point are consecutive; `last` must be the final frame.
import {evaluateFrames} from './lib/evaluate.mjs';
import {main, resolveSpec, list, emit} from './lib/cli.mjs';

main(async o => {
  const {spec, input} = resolveSpec(o);
  const r = await evaluateFrames({file: input, spec, points: list(o.points), framesPerPoint: o['frames-per-point'] ? Number(o['frames-per-point']) : 5});
  return emit(o, r);
});
