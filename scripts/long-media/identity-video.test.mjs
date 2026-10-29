import {test} from 'node:test';
import assert from 'node:assert/strict';
import {videoLayout, identityWord, decodeBand, paintBand, bitExpression, smpteStart, identityFilters, VIDEO_IDENTITY} from './lib/identity-video.mjs';

test('layout scales proportionally with the frame (decode works on rescaled outputs)', () => {
  const a = videoLayout(1920, 1080), b = videoLayout(3840, 2160), c = videoLayout(960, 540), d = videoLayout(320, 180);
  assert.deepEqual([a.cell, a.x0, a.y0, a.bandHeight, a.flash.x, a.flash.y, a.flash.size], [48, 192, 24, 144, 1764, 12, 120]);
  for (const [k, s] of [[b, 2], [c, 0.5]]) assert.deepEqual([k.cell, k.x0, k.y0, k.bandHeight, k.flash.x, k.flash.y, k.flash.size], [a.cell, a.x0, a.y0, a.bandHeight, a.flash.x, a.flash.y, a.flash.size].map(v => v * s));
  assert.equal(d.cell, 8);
  assert.throws(() => videoLayout(160, 90), /too small/);
  assert.throws(() => videoLayout(640, 480), /too narrow/);
});

test('identity word: 24-bit index + mod-251 check, range enforced', () => {
  const w = identityWord(150);
  assert.deepEqual(w.bits.slice(0, 8), [0, 1, 1, 0, 1, 0, 0, 1]);
  assert.equal(w.check, 150);
  assert.equal(identityWord(1295999).check, 1295999 % 251);
  assert.throws(() => identityWord(-1));
  assert.throws(() => identityWord(2 ** 24));
  assert.equal(VIDEO_IDENTITY.indexBits + VIDEO_IDENTITY.checkBits, VIDEO_IDENTITY.columns);
});

function noisy(gray, amp, seed = 1) {
  let s = seed;
  for (let i = 0; i < gray.length; i++) { s = (s * 1103515245 + 12345) >>> 0; gray[i] = Math.max(0, Math.min(255, gray[i] + ((s >>> 16) % (2 * amp + 1)) - amp)); }
}

test('paint/decode round trip at several sizes and indices, with noise', () => {
  for (const [w, h] of [[1920, 1080], [3840, 2160], [640, 360], [320, 180]]) {
    for (const idx of [0, 1, 150, 1295999, 2697302, 2 ** 24 - 1]) {
      const L = videoLayout(w, h), g = new Uint8Array(w * L.bandHeight);
      paintBand(g, w, h, idx, {flash: idx % 2 === 0});
      noisy(g, 30, idx + w);
      const d = decodeBand(g, w, h);
      assert.equal(d.valid, true, `${w}x${h} #${idx}`);
      assert.equal(d.index, idx);
      assert.equal(d.flashOn, idx % 2 === 0);
    }
  }
});

test('decode rejects low contrast and a flipped bit', () => {
  const w = 640, h = 360, L = videoLayout(w, h);
  const g = new Uint8Array(w * L.bandHeight);
  paintBand(g, w, h, 12345);
  // flatten column 3 (both cells mid grey): ambiguous
  const flat = Uint8Array.from(g);
  for (let y = L.y0; y < L.y0 + 2 * L.cell; y++) flat.fill(128, y * w + L.x0 + 3 * L.cell, y * w + L.x0 + 4 * L.cell);
  const a = decodeBand(flat, w, h);
  assert.equal(a.valid, false);
  assert.deepEqual(a.ambiguousBits, [3]);
  // swap column 5's cells: still high contrast, but the check bits no longer match
  const sw = Uint8Array.from(g);
  for (let y = 0; y < L.cell; y++) for (let x = 0; x < L.cell; x++) {
    const top = (L.y0 + y) * w + L.x0 + 5 * L.cell + x, bot = (L.y0 + L.cell + y) * w + L.x0 + 5 * L.cell + x;
    [sw[top], sw[bot]] = [sw[bot], sw[top]];
  }
  const b = decodeBand(sw, w, h);
  assert.equal(b.ambiguousBits.length, 0);
  assert.equal(b.valid, false);
  assert.notEqual(b.index, 12345);
});

test('filter expressions and SMPTE start timecodes', () => {
  assert.equal(bitExpression(0), 'mod(floor(n/1),2)');
  assert.equal(bitExpression(23, 1800), 'mod(floor((n+1800)/8388608),2)');
  assert.equal(bitExpression(24, 1800), 'mod(floor(mod((n+1800),251)/1),2)');
  const ntsc = {num: 30000n, den: 1001n};
  assert.equal(smpteStart(0, ntsc, ';'), '00:00:00;00');
  assert.equal(smpteStart(1800, ntsc, ';'), '00:01:00;02');
  assert.equal(smpteStart(17982, ntsc, ';'), '00:10:00;00');
  assert.equal(smpteStart(107892, ntsc, ';'), '01:00:00;00');
  assert.equal(smpteStart(108000, {num: 30n, den: 1n}, ':'), '01:00:00:00');
  const {filters} = identityFilters({width: 1920, height: 1080, fps: {num: 30n, den: 1n}, startFrame: 0, label: 'F1 1080p30'});
  assert.equal(filters.length, 1 + 64 + 1 + 2);
  assert.match(filters.at(-1), /timecode='00\\:00\\:00\\:00':timecode_rate=30\/1/);
});
