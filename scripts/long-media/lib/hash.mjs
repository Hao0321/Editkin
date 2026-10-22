import {createHash} from 'node:crypto';
import fs from 'node:fs';

export const sha256 = buf => createHash('sha256').update(buf).digest('hex');

/** Streaming SHA-256 of a file (4 MiB reads; constant memory for multi-GiB files). */
export function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    let bytes = 0;
    const s = fs.createReadStream(p, {highWaterMark: 4 * 1024 * 1024});
    s.on('data', b => { bytes += b.length; h.update(b); });
    s.on('error', reject);
    s.on('end', () => resolve({sha256: h.digest('hex'), bytes}));
  });
}
