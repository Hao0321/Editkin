#!/usr/bin/env node
// Output-vs-reference quality (PSNR/SSIM via FFmpeg psnr/ssim filters), every frame of every window.
//   node scripts/long-media/evaluate-quality.mjs --distorted out.mp4 --reference ref.mkv --window 0:10 --window 21600:10 [--psnr-min 40] [--ssim-min 0.995] [--out r.json]
// Windows are start:duration in exact seconds; omit --window to compare the whole file. VMAF is NOT_CHECKED.
import path from 'node:path';
import {evaluateQuality} from './lib/quality.mjs';
import {main, list, emit} from './lib/cli.mjs';
import {workPath} from './lib/env.mjs';

main(async o => {
  const windows = list(o.window)?.map(w => { const [start, duration] = w.split(':'); return {start, duration}; }) ?? null;
  const statsDir = o['stats-dir'] ? path.resolve(o['stats-dir']) : workPath('quality', `q-${Date.now()}`);
  const r = await evaluateQuality({distorted: o.distorted, reference: o.reference, windows, statsDir,
    psnrMin: o['psnr-min'] ? Number(o['psnr-min']) : 40, ssimMin: o['ssim-min'] ? Number(o['ssim-min']) : 0.995, checkIdentity: !o['no-identity']});
  return emit(o, r);
});
