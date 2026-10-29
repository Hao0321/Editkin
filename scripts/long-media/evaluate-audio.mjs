#!/usr/bin/env node
// Audio sample-position checks around timestamps.
//   node scripts/long-media/evaluate-audio.mjs --fixture F1-1080p30-12h [--points ...] [--tolerance-samples 2] [--out r.json]
// Every chirp marker found is decoded (second k, channel c, check) and its absolute sample position must equal k*R
// within the tolerance; every marker expected inside the window must be found; channel ids must match positions.
import {evaluateAudio} from './lib/evaluate.mjs';
import {main, resolveSpec, list, emit} from './lib/cli.mjs';

main(async o => {
  const {spec, input} = resolveSpec(o);
  const r = await evaluateAudio({file: input, spec, points: list(o.points), toleranceSamples: o['tolerance-samples'] ? Number(o['tolerance-samples']) : 2});
  return emit(o, r);
});
