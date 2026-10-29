import {test} from 'node:test';
import assert from 'node:assert/strict';
import {audioTiming, audioWord, synthesize, findMarkers, decodeWord, lfeBurst, lfePositions, channelExpression, aevalsrcFilter} from './lib/identity-audio.mjs';

test('timing per sample rate; non-multiples of 100 Hz refused', () => {
  assert.deepEqual(audioTiming(48000), {R: 48000, markerLen: 480, symStart: 960, symLen: 960, symEnd: 960 + 31 * 960, lfeLen: 9600});
  assert.equal(audioTiming(44100).symLen, 882);
  assert.throws(() => audioTiming(22050));
});

test('audio word: 20-bit second, 3-bit channel, mod-251 check', () => {
  const w = audioWord(89478, 5);
  assert.equal(w.bits.length, 31);
  assert.equal(w.check, (89478 * 8 + 5) % 251);
  assert.throws(() => audioWord(2 ** 20, 0));
  assert.throws(() => audioWord(1, 8));
  assert.deepEqual(lfePositions('5.1'), [3]);
  assert.deepEqual(lfePositions('5.1(side)'), [3]);
  assert.deepEqual(lfePositions('stereo'), []);
});

test('markers found at exact absolute positions, words decoded (also across the 2^32-sample boundary)', () => {
  for (const [R, start, c] of [[48000, 0, 0], [44100, 12345, 1], [48000, 4291200514, 0], [48000, 2 ** 32 - 30000, 1]]) {
    const x = synthesize(R, c, start, 3 * R + 1000);
    const m = findMarkers(x, R);
    const expected = [];
    for (let k = Math.ceil(start / R); k * R + audioTiming(R).symEnd <= start + x.length; k++) expected.push(k);
    const decoded = m.map(mm => ({abs: start + mm.posFrac, w: decodeWord(x, mm.pos, R)})).filter(d => d.w.complete);
    assert.deepEqual(decoded.map(d => d.w.k), expected, `R=${R} start=${start}`);
    for (const d of decoded) {
      assert.equal(d.w.valid, true);
      assert.equal(d.w.c, c);
      assert.ok(Math.abs(d.abs - d.w.k * R) < 0.01, `error ${d.abs - d.w.k * R}`);
    }
  }
});

test('marker position survives gain and noise; a half-sample shift is measured', () => {
  const R = 48000, x = synthesize(R, 0, 0, 2 * R);
  let s = 7;
  const y = x.map(v => { s = (s * 1103515245 + 12345) >>> 0; return 0.5 * v + (((s >>> 8) % 2001) - 1000) / 1000 * 0.01; });
  const m = findMarkers(y, R);
  assert.equal(m.length, 2);
  assert.ok(Math.abs(m[0].posFrac) < 0.3 && Math.abs(m[1].posFrac - R) < 0.3);
  const half = new Float32Array(x.length);
  for (let i = 1; i < x.length; i++) half[i] = (x[i] + x[i - 1]) / 2; // ~0.5-sample delay
  const h = findMarkers(half, R);
  assert.ok(Math.abs(h[1].posFrac - (R + 0.5)) < 0.2, `got ${h[1].posFrac}`);
});

test('a destroyed FSK symbol invalidates the word; LFE burst detection', () => {
  const R = 48000, T = audioTiming(R), x = synthesize(R, 2, 5 * R, R);
  const ok = decodeWord(x, 0, R);
  assert.equal(ok.valid, true);
  assert.equal(ok.k, 5);
  const bad = Float32Array.from(x);
  bad.fill(0, T.symStart + 4 * T.symLen, T.symStart + 5 * T.symLen);
  assert.equal(decodeWord(bad, 0, R).valid, false);
  const lfe = synthesize(R, 3, 0, R, true);
  assert.equal(lfeBurst(lfe, 0, R).present, true);
  assert.equal(lfeBurst(new Float32Array(R), 0, R).present, false);
  assert.equal(findMarkers(lfe, R).length, 0);
});

test('aevalsrc expression carries the absolute start sample and the channel id', () => {
  const e = channelExpression({R: 48000, c: 4, A0: 4291200514});
  assert.match(e, /^st\(0,n\+4291200514\);/);
  assert.match(e, /mod\(ld\(1\)\*8\+4,251\)/);
  const f = aevalsrcFilter({R: 48000, layout: '5.1', channels: 6, A0: 0});
  assert.equal(f.split('|').length, 6);
  assert.match(f, /:s=48000:c=5\.1:nb_samples=1024$/);
});
