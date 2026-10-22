// Volume free space and the generation budget (brief: stop if the total estimate exceeds 40 GiB).
import fs from 'node:fs';
import path from 'node:path';

export const GiB = 2 ** 30, MiB = 2 ** 20;
export const TOTAL_CAP_BYTES = 40 * GiB;
export const MIN_FREE_DURING_RUN = 4 * GiB;

export function volumeRoot(p) { return path.parse(path.resolve(p)).root; }

export function freeBytes(p) {
  const s = fs.statfsSync(volumeRoot(p));
  return s.bavail * s.bsize;
}

export const gib = b => (b / GiB).toFixed(2);

/**
 * planned: [{id, worstCase, expected}] for fixtures that do not exist yet.
 * ownedBytes: bytes already under the owner root. free: free bytes of the owner volume.
 */
export function planCheck({planned, ownedBytes, free, cap = TOTAL_CAP_BYTES, reserve = 10 * GiB}) {
  const worst = planned.reduce((s, p) => s + p.worstCase, 0);
  const expected = planned.reduce((s, p) => s + p.expected, 0);
  const total = ownedBytes + worst;
  const lines = planned.map(p => `  ${p.id}: expected ${gib(p.expected)} GiB, worst case ${gib(p.worstCase)} GiB`);
  lines.push(`  owner root already holds ${gib(ownedBytes)} GiB; planned worst case ${gib(worst)} GiB (expected ${gib(expected)} GiB)`);
  lines.push(`  total estimate ${gib(total)} GiB (cap ${gib(cap)} GiB); volume free ${gib(free)} GiB (needs worst case x1.2 + ${gib(reserve)} GiB reserve)`);
  let ok = true, reason = null;
  if (total > cap) { ok = false; reason = `total estimate ${gib(total)} GiB exceeds the ${gib(cap)} GiB cap`; }
  else if (free < worst * 1.2 + reserve) { ok = false; reason = `free space ${gib(free)} GiB below worst case x1.2 + reserve`; }
  return {ok, reason, worst, expected, total, lines};
}
