// Long-media WP-D: paths, owner-root guards and child-process environment.
// All large media lives under ONE owner root (default E:\Editkin-LongMediaTest).
// Small manifests/logs live under the work dir inside .rd/benchmarks.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {fileURLToPath} from 'node:url';

export const APP_ROOT = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
export const FFMPEG = path.join(APP_ROOT, 'vendor', 'ffmpeg', 'win32-x64', 'ffmpeg.exe');
export const FFPROBE = path.join(APP_ROOT, 'vendor', 'ffmpeg', 'win32-x64', 'ffprobe.exe');
export const NODE = path.join(APP_ROOT, 'vendor', 'node', 'win32-x64', 'node.exe');
// Relative to APP_ROOT on purpose: a drive colon inside a filtergraph needs fragile escaping.
export const FONT_REL = 'public/fonts/LXGWWenKaiMonoTC-Regular.ttf';
export const WORK_DIR = path.join(APP_ROOT, '.rd', 'benchmarks', 'usable-v1-20261009', 'work', 'long-media');
export const OWNER_ROOT = path.resolve(process.env.EDITKIN_LONG_MEDIA_ROOT || 'E:\\Editkin-LongMediaTest');
export const TMP_DIR = path.join(OWNER_ROOT, 'tmp');
export const OWNER_TAG = 'editkin-long-media-wpd';

const norm = p => path.resolve(p).toLowerCase();

/** Throws unless `p` is the owner root itself or strictly inside it. */
export function assertInsideOwnerRoot(p, {allowRoot = false} = {}) {
  const abs = path.resolve(p);
  const root = norm(OWNER_ROOT);
  const a = abs.toLowerCase();
  if (a === root) { if (allowRoot) return abs; throw new Error(`refusing to operate on the owner root itself: ${abs}`); }
  if (!a.startsWith(root + path.sep)) throw new Error(`path is outside the owner root ${OWNER_ROOT}: ${abs}`);
  if (abs.split(path.sep).includes('..')) throw new Error(`path contains '..': ${abs}`);
  return abs;
}

/** Large media must never land on the system drive. */
export function assertNotSystemDrive(p) {
  const sys = (process.env.SystemDrive || 'C:').toLowerCase();
  if (path.resolve(p).toLowerCase().startsWith(sys)) throw new Error(`refusing to place media on the system drive ${sys}: ${p}`);
  return p;
}

/** Every ancestor from the owner root down to `p` must be a real directory, not a junction/symlink. */
export function assertNoReparseAncestry(p) {
  const abs = assertInsideOwnerRoot(p, {allowRoot: true});
  const rootParts = path.resolve(OWNER_ROOT).split(path.sep);
  const parts = abs.split(path.sep);
  for (let i = rootParts.length; i <= parts.length; i++) {
    const cur = parts.slice(0, i).join(path.sep) || path.sep;
    let st;
    try { st = fs.lstatSync(cur); } catch (e) { if (e.code === 'ENOENT') break; throw e; }
    if (st.isSymbolicLink()) throw new Error(`reparse point (junction/symlink) in owned path ancestry: ${cur}`);
  }
  return abs;
}

/** Creates the owner root, its tmp dir and an OWNER.json marker (never overwritten). */
export function ensureOwnerRoot() {
  assertNotSystemDrive(OWNER_ROOT);
  fs.mkdirSync(TMP_DIR, {recursive: true});
  const marker = path.join(OWNER_ROOT, 'OWNER.json');
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, JSON.stringify({
      schema: 'editkin.longMedia.ownerRoot/v1', owner: OWNER_TAG,
      createdAt: new Date().toISOString(), createdBy: 'scripts/long-media (WP-D part 1)',
      rule: 'Single owner root for Editkin long-media fixtures and long outputs (Hao: 能用E槽). Cleanup deletes only exact ledgered paths inside this folder. The 12 h fixture must be kept for the other work packages.',
      ledger: 'OWNER_LEDGER.jsonl',
    }, null, 2) + '\n', {flag: 'wx'});
  }
  return OWNER_ROOT;
}

export function ownerPath(...parts) {
  const p = path.join(OWNER_ROOT, ...parts);
  return assertInsideOwnerRoot(p);
}

export function workPath(...parts) { return path.join(WORK_DIR, ...parts); }

/** Child processes get TEMP/TMP inside the owner root, never C:. */
export function childEnv(extra = {}) {
  return {...process.env, TEMP: TMP_DIR, TMP: TMP_DIR, ...extra};
}

/** Lowers this Node process to BELOW_NORMAL; Windows children inherit it. */
export function lowerOwnPriority() {
  try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* best effort */ }
  try { return os.getPriority(0); } catch { return null; }
}

export function priorityName(v) {
  const P = os.constants.priority;
  for (const [k, n] of Object.entries(P)) if (n === v) return k;
  return String(v);
}

export function hostFacts() {
  const cpus = os.cpus();
  return {
    platform: process.platform, release: os.release(), hostname: os.hostname(),
    cpuModel: cpus[0]?.model?.trim(), logicalCpus: cpus.length,
    totalMemBytes: os.totalmem(), node: process.version, nodeExecPath: process.execPath,
  };
}
