import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseRational, rat, frameAt, framePts, firstFrameAtOrAfter, sampleAt, toDecimalString, hms, exactTicks, toSafeNumber, cmp} from './lib/rational.mjs';

const NTSC = parseRational('30000/1001'), F30 = parseRational('30/1');

test('parses rates and times exactly (no binary floating point)', () => {
  assert.deepEqual(parseRational('30000/1001'), {num: 30000n, den: 1001n});
  assert.deepEqual(parseRational('35999'), {num: 35999n, den: 1n});
  assert.deepEqual(parseRational('43199.5'), {num: 86399n, den: 2n});
  assert.deepEqual(parseRational('9:59:59'), {num: 35999n, den: 1n});
  assert.deepEqual(parseRational('10:00:00.25'), {num: 144001n, den: 4n});
  assert.deepEqual(parseRational('0.1'), {num: 1n, den: 10n});
  assert.deepEqual(parseRational(12), {num: 12n, den: 1n});
  assert.throws(() => parseRational('ten'));
});

test('frame and sample positions at the LV-01 timestamps', () => {
  assert.equal(frameAt(parseRational('10:00:00'), F30), 1080000);
  assert.equal(frameAt(parseRational('9:59:59'), F30), 1079970);
  assert.equal(frameAt(parseRational('11:59:59'), F30), 1295970);
  // 30000/1001: 36000 s * 30000/1001 = 1078921.07..., the frame shown at 10:00:00 is 1078921
  assert.equal(frameAt(parseRational('36000'), NTSC), 1078921);
  assert.equal(firstFrameAtOrAfter(parseRational('36000'), NTSC), 1078922);
  assert.equal(toDecimalString(framePts(1078921, NTSC), 6), '35999.997366');
  // last frame of the 12 h 30 fps fixture
  assert.equal(toDecimalString(framePts(1295999, F30), 6), '43199.966666');
  assert.equal(hms(framePts(1295999, F30)), '11:59:59.966');
  // 48 kHz sample index crosses 2^32 inside the 25 h fixture
  assert.equal(sampleAt(parseRational('89478.485333'), 48000), 4294967295);
  assert.equal(sampleAt(parseRational('89478.485334'), 48000), 4294967296);
});

test('exact tick conversion refuses inexact positions', () => {
  assert.equal(exactTicks(framePts(30, F30), rat(1, 15360)), 15360);
  assert.equal(exactTicks(framePts(7, NTSC), rat(1, 30000)), 7007);
  assert.equal(exactTicks(framePts(1, NTSC), rat(1, 1000)), null);
});

test('safe-integer guard and ordering', () => {
  assert.throws(() => toSafeNumber(2n ** 53n), /safe integer/);
  assert.equal(toSafeNumber(2n ** 53n - 1n), Number.MAX_SAFE_INTEGER);
  assert.equal(cmp(parseRational('1/3'), parseRational('0.333333')), 1);
  assert.equal(hms(parseRational('90000.0101')), '25:00:00.010');
});
