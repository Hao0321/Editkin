// Small CLI helpers shared by the long-media scripts.
import fs from 'node:fs';
import path from 'node:path';
import {getSpec, specFromManifest} from './fixtures.mjs';
import {fixturePath, manifestWorkPath, writeJson} from './generate.mjs';
import {lowerOwnPriority} from './env.mjs';

export function parseArgs(argv = process.argv.slice(2)) {
  const o = {_: []};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { o['--'] = argv.slice(i + 1); break; }
    if (a.startsWith('--')) {
      const k = a.slice(2), v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) o[k] = true;
      else { o[k] = o[k] === undefined ? v : [].concat(o[k], v); i++; }
    } else o._.push(a);
  }
  return o;
}

export const list = v => (v === undefined || v === true ? undefined : [].concat(v).flatMap(x => String(x).split(',')).map(s => s.trim()).filter(Boolean));

/** Resolves {spec, input} from --manifest <path> | --fixture <id> and optional --input <media>. */
export function resolveSpec(o) {
  let spec, input = o.input;
  if (o.manifest) {
    const m = JSON.parse(fs.readFileSync(o.manifest, 'utf8'));
    spec = specFromManifest(m);
    input = input || m.path;
  } else if (o.fixture) {
    spec = getSpec(o.fixture);
    const mp = manifestWorkPath(spec);
    if (fs.existsSync(mp)) input = input || JSON.parse(fs.readFileSync(mp, 'utf8')).path;
    input = input || fixturePath(spec);
  } else throw new Error('need --manifest <path> or --fixture <id> (the expectation), plus --input <media> for outputs other than the fixture itself');
  if (!input || !fs.existsSync(input)) throw new Error(`input not found: ${input}`);
  return {spec, input};
}

export async function main(fn) {
  lowerOwnPriority();
  try {
    const r = await fn(parseArgs());
    process.exitCode = r && (r.status === 'PASS' || r.status === 'NOT_APPLICABLE' || r.ok === true) ? 0 : 1;
  } catch (e) {
    console.error(e.stack || e.message);
    process.exitCode = 2;
  }
}

export function emit(o, result) {
  if (o.out) { writeJson(path.resolve(o.out), result); console.log(`wrote ${path.resolve(o.out)}`); }
  if (!o.quiet) console.log(JSON.stringify(summarize(result), null, 2));
  return result;
}

/** Compact console view (full detail goes to --out). */
function summarize(r) {
  const strip = x => {
    if (Array.isArray(x)) return x.map(strip);
    if (x && typeof x === 'object') {
      const o = {};
      for (const [k, v] of Object.entries(x)) if (!['decodeArgv', 'argv', 'raw', 'frames', 'decoded', 'markers'].includes(k)) o[k] = strip(v);
      if (x.decoded) o.decoded = x.decoded.map(f => `${f.identity}${f.valid ? '' : '!'}${f.ok === false ? 'X' : ''}${f.flashOn ? '*' : ''}`).join(' ');
      if (x.markers) o.markers = x.markers.map(m => `${m.k}@${m.errorSamples}`).join(' ');
      return o;
    }
    return x;
  };
  return strip(r);
}
