// Owner ledger: append-only record of every path created/removed inside the owner root.
// Removal is exact-path only, inside the owner root, never through a junction/symlink.
import fs from 'node:fs';
import path from 'node:path';
import {OWNER_ROOT, OWNER_TAG, assertInsideOwnerRoot, assertNoReparseAncestry, ensureOwnerRoot} from './env.mjs';

export const LEDGER = path.join(OWNER_ROOT, 'OWNER_LEDGER.jsonl');

export function ledgerAppend(rec) {
  ensureOwnerRoot();
  fs.appendFileSync(LEDGER, JSON.stringify({ts: new Date().toISOString(), by: OWNER_TAG, pid: process.pid, ...rec}) + '\n');
}

export function readLedger() {
  if (!fs.existsSync(LEDGER)) return [];
  return fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

/** Deletes one owned regular file (exact path). Returns false if it did not exist. */
export function removeOwnedFile(p, reason) {
  const abs = assertNoReparseAncestry(assertInsideOwnerRoot(p));
  let st;
  try { st = fs.lstatSync(abs); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  if (!st.isFile()) throw new Error(`refusing to remove non-regular file: ${abs}`);
  fs.unlinkSync(abs);
  ledgerAppend({action: 'remove', path: abs, bytes: st.size, reason});
  return true;
}

const SCRATCH_PARENTS = ['scratch', 'unit', 'tmp', 'bench-tmp', 'controls'];
/** Recursively removes an owned scratch directory (only under scratch/, unit/, tmp/, bench-tmp/, controls/). */
export function removeOwnedScratchDir(p, reason) {
  const abs = assertNoReparseAncestry(assertInsideOwnerRoot(p));
  const rel = path.relative(OWNER_ROOT, abs).split(path.sep);
  if (rel.length < 2 || !SCRATCH_PARENTS.includes(rel[0].toLowerCase())) throw new Error(`not an owned scratch dir: ${abs}`);
  if (!fs.existsSync(abs)) return false;
  const walk = d => { for (const e of fs.readdirSync(d, {withFileTypes: true})) { if (e.isSymbolicLink()) throw new Error(`link inside scratch dir: ${path.join(d, e.name)}`); if (e.isDirectory()) walk(path.join(d, e.name)); } };
  walk(abs);
  const bytes = dirBytes(abs).bytes;
  fs.rmSync(abs, {recursive: true, force: false});
  ledgerAppend({action: 'remove-dir', path: abs, bytes, reason});
  return true;
}

/** Sum of file sizes under a directory (stops after maxEntries; links are not followed). */
export function dirBytes(dir, {maxEntries = 100000} = {}) {
  let bytes = 0, files = 0, entries = 0, truncated = false;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let list;
    try { list = fs.readdirSync(d, {withFileTypes: true}); } catch { continue; }
    for (const e of list) {
      if (++entries > maxEntries) { truncated = true; break; }
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) { try { bytes += fs.statSync(p).size; files++; } catch { /* raced */ } }
    }
  }
  return {bytes, files, truncated};
}

/** Inventory of the owner root: every regular file with size (for the final report). */
export function inventory(root = OWNER_ROOT) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const d = stack.pop();
    for (const e of fs.readdirSync(d, {withFileTypes: true})) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p); else if (e.isFile()) out.push({path: p, bytes: fs.statSync(p).size});
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
