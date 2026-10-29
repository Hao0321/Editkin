// Output-vs-reference quality: per-frame PSNR and SSIM from FFmpeg's psnr/ssim filters, on sampled windows.
// No averaging hides a bad frame: a window passes only if EVERY frame meets the thresholds, the frame counts
// match and both windows carry the same identity sequence (so frames are compared like-for-like).
// VMAF is not run here (NOT_CHECKED): no model is downloaded or enabled by this package.
import fs from 'node:fs';
import path from 'node:path';
import {FFMPEG} from './env.mjs';
import {runChecked} from './proc.mjs';
import {ffprobeJson, probeFacts} from './probe.mjs';
import {decodeVideoFrames} from './decode.mjs';
import {decodeBand, videoLayout} from './identity-video.mjs';
import {parseRational, mul, toDecimalString, floorBig, toSafeNumber} from './rational.mjs';

const num = s => (s === 'inf' ? Infinity : Number(s));
function stats(values) {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return null;
  const finite = v.filter(Number.isFinite);
  const mean = finite.length === v.length ? finite.reduce((s, x) => s + x, 0) / v.length : (finite.length ? 'inf-included' : Infinity);
  const r = x => (x === Infinity ? 'inf' : typeof x === 'number' ? +x.toFixed(4) : x);
  return {min: r(v[0]), p5: r(v[Math.floor(0.05 * (v.length - 1))]), mean: r(mean), max: r(v[v.length - 1])};
}

async function identities(file, start, count) {
  const facts = probeFacts((await ffprobeJson(file)).json);
  const v = facts.video, L = videoLayout(v.width, v.height);
  const dec = await decodeVideoFrames(file, {start, count, timeBase: parseRational(v.time_base), width: v.width, height: v.height, region: 'band', bandRows: L.bandHeight});
  return dec.frames.map(f => { const d = decodeBand(f.data, v.width, v.height); return d.valid ? d.index : null; });
}

/**
 * windows: [{start: '21600', duration: '10'}] (seconds, exact decimals) or null for the whole file.
 * statsDir: directory for the psnr/ssim stats files (small text).
 */
export async function evaluateQuality({distorted, reference, windows = null, psnrMin = 40, ssimMin = 0.995, statsDir, checkIdentity = true}) {
  fs.mkdirSync(statsDir, {recursive: true});
  const [fd, fr] = await Promise.all([ffprobeJson(distorted), ffprobeJson(reference)]);
  const vd = probeFacts(fd.json).video, vr = probeFacts(fr.json).video;
  const fps = parseRational(vr.r_frame_rate);
  const wins = windows || [{start: '0', duration: vr.duration}];
  const results = [];
  for (let wi = 0; wi < wins.length; wi++) {
    const w = wins[wi];
    const ss = toDecimalString(parseRational(w.start), 6), dur = toDecimalString(parseRational(w.duration), 6);
    const pLog = `psnr_${wi}.log`, sLog = `ssim_${wi}.log`;
    for (const f of [pLog, sLog]) { try { fs.unlinkSync(path.join(statsDir, f)); } catch { /* none */ } }
    // Exactly N frames from each side, retimed to pts = n in a frame-duration time base, so framesync pairs
    // frame i with frame i (inputs with different time bases, e.g. mp4 1/15360 vs mkv 1/1000, otherwise
    // produce extra outputs on mismatched timestamps). The identity check below proves the pairing is like-for-like.
    const nFrames = toSafeNumber(floorBig(mul(parseRational(w.duration), fps)), 'frames');
    const head = `trim=end_frame=${nFrames},settb=${fps.den}/${fps.num},setpts=N`;
    const graph = `[0:v]${head}[d];[1:v]${head}[r];` +
      `[d]split[d1][d2];[r]split[r1][r2];[d1][r1]psnr=stats_file=${pLog};[d2][r2]ssim=stats_file=${sLog}`;
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-ss', ss, '-i', distorted, '-ss', ss, '-i', reference,
      '-filter_complex', graph, '-an', '-f', 'null', '-'];
    const r = await runChecked(FFMPEG, args, {cwd: statsDir, timeoutMs: 6 * 3600 * 1000});
    const pl = fs.readFileSync(path.join(statsDir, pLog), 'utf8').split('\n').filter(Boolean);
    const sl = fs.readFileSync(path.join(statsDir, sLog), 'utf8').split('\n').filter(Boolean);
    const psnrAvg = [], psnrY = [], ssimAll = [], ssimY = [];
    for (const l of pl) { psnrAvg.push(num(/psnr_avg:(\S+)/.exec(l)[1])); psnrY.push(num(/psnr_y:(\S+)/.exec(l)[1])); }
    for (const l of sl) { ssimAll.push(Number(/All:(\S+)/.exec(l)[1])); ssimY.push(Number(/Y:(\S+)/.exec(l)[1])); }
    const expectedFrames = nFrames;
    const lowP = psnrAvg.filter(x => x < psnrMin).length, lowS = ssimAll.filter(x => x < ssimMin).length;
    let identity = null;
    if (checkIdentity) {
      const st = parseRational(w.start), n = Math.min(psnrAvg.length, 600);
      const [ia, ib] = await Promise.all([identities(distorted, st, n), identities(reference, st, n)]);
      identity = {framesChecked: n, equal: ia.length === ib.length && ia.every((x, i) => x !== null && x === ib[i]), firstDistorted: ia[0], firstReference: ib[0]};
    }
    const ok = psnrAvg.length > 0 && psnrAvg.length === ssimAll.length && psnrAvg.length === expectedFrames && lowP === 0 && lowS === 0 && (!identity || identity.equal);
    results.push({window: {start: ss, duration: dur}, frames: psnrAvg.length, expectedFrames, psnrAvg: stats(psnrAvg), psnrY: stats(psnrY), ssimAll: stats(ssimAll), ssimY: stats(ssimY),
      framesBelowPsnr: lowP, framesBelowSsim: lowS, identity, argv: [FFMPEG, ...args], cwd: statsDir, wallMs: Math.round(r.wallMs), status: ok ? 'PASS' : 'FAIL'});
  }
  return {evaluator: 'quality-psnr-ssim/v1', distorted, reference, thresholds: {psnrMinDb: psnrMin, ssimMin, rule: 'every frame in every window'},
    sizes: {distorted: `${vd.width}x${vd.height}`, reference: `${vr.width}x${vr.height}`}, vmaf: 'NOT_CHECKED',
    windows: results, status: results.every(x => x.status === 'PASS') ? 'PASS' : 'FAIL'};
}

export {stats as qualityStats};
