export interface CubeLut {
  size: number;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  values: Float32Array;
}

/** A validated Resolve/Adobe .cube file: one 3D or one 1D table. */
export type ParsedCube =
  | ({ kind: "3d"; title?: string } & CubeLut)
  | { kind: "1d"; title?: string; size: number; domainMin: [number, number, number]; domainMax: [number, number, number]; values: Float32Array };

export const CUBE_MAX_SOURCE_BYTES = 64 * 1024 * 1024;
export const CUBE_3D_MAX_SIZE = 129;
export const CUBE_1D_MAX_SIZE = 65_536;
const CUBE_VALUE_LIMIT = 1e4;

const clamp = (value: number, minimum = 0, maximum = 1) => Math.max(minimum, Math.min(maximum, value));

function parseTriple(fields: string[], line: number, label: string): [number, number, number] {
  if (fields.length !== 4) throw new Error(`.cube 第 ${line} 行 ${label} 需要三個數值`);
  const values = fields.slice(1).map(Number);
  if (!values.every(Number.isFinite)) throw new Error(`.cube 第 ${line} 行 ${label} 不是有限數值`);
  return values as [number, number, number];
}

/**
 * Strict .cube parser for imports. Accepts exactly one LUT_3D_SIZE or LUT_1D_SIZE table,
 * TITLE, comments, DOMAIN_MIN/MAX and the Resolve LUT_*_INPUT_RANGE form. Rejects
 * duplicate headers, missing/extra rows, non-finite values, absurd magnitudes and
 * inverted domains instead of guessing.
 */
export function parseCubeFile(source: string): ParsedCube {
  if (source.length > CUBE_MAX_SOURCE_BYTES) throw new Error(".cube 檔案超過 64 MiB 上限");
  let size3d = 0, size1d = 0, title: string | undefined;
  let domainMin: [number, number, number] | undefined, domainMax: [number, number, number] | undefined;
  const rows: number[] = [];
  const lines = source.replace(/^﻿/, "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    const keyword = fields[0].toUpperCase();
    if (keyword === "TITLE") {
      if (title !== undefined || rows.length) throw new Error(".cube TITLE 重複或出現在資料之後");
      title = line.slice(5).trim().replace(/^"|"$/g, "").slice(0, 120);
      continue;
    }
    if (keyword === "LUT_3D_SIZE" || keyword === "LUT_1D_SIZE") {
      if (size3d || size1d) throw new Error(".cube 只能有一個 LUT 尺寸宣告");
      if (rows.length) throw new Error(".cube 尺寸宣告必須在資料之前");
      const value = Number(fields[1]);
      if (fields.length !== 2 || !Number.isInteger(value)) throw new Error(`.cube 第 ${index + 1} 行尺寸不合法`);
      if (keyword === "LUT_3D_SIZE") {
        if (value < 2 || value > CUBE_3D_MAX_SIZE) throw new Error(`.cube 3D 尺寸必須介於 2–${CUBE_3D_MAX_SIZE}`);
        size3d = value;
      } else {
        if (value < 2 || value > CUBE_1D_MAX_SIZE) throw new Error(`.cube 1D 尺寸必須介於 2–${CUBE_1D_MAX_SIZE}`);
        size1d = value;
      }
      continue;
    }
    if (keyword === "DOMAIN_MIN" || keyword === "DOMAIN_MAX") {
      if (rows.length) throw new Error(".cube DOMAIN 宣告必須在資料之前");
      const triple = parseTriple(fields, index + 1, keyword);
      if (keyword === "DOMAIN_MIN") { if (domainMin) throw new Error(".cube DOMAIN_MIN 重複"); domainMin = triple; }
      else { if (domainMax) throw new Error(".cube DOMAIN_MAX 重複"); domainMax = triple; }
      continue;
    }
    if (keyword === "LUT_3D_INPUT_RANGE" || keyword === "LUT_1D_INPUT_RANGE") {
      if (rows.length || domainMin || domainMax) throw new Error(".cube INPUT_RANGE 與 DOMAIN 不可重複宣告");
      const low = Number(fields[1]), high = Number(fields[2]);
      if (fields.length !== 3 || !Number.isFinite(low) || !Number.isFinite(high)) throw new Error(`.cube 第 ${index + 1} 行 INPUT_RANGE 不合法`);
      domainMin = [low, low, low]; domainMax = [high, high, high];
      continue;
    }
    if (/^[A-Z_]+$/.test(keyword)) throw new Error(`.cube 不支援的關鍵字：${fields[0]}`);
    if (fields.length !== 3) throw new Error(`.cube 第 ${index + 1} 行需要三個數值`);
    const values = fields.map(Number);
    if (!values.every(value => Number.isFinite(value) && Math.abs(value) <= CUBE_VALUE_LIMIT)) throw new Error(`.cube 第 ${index + 1} 行數值不合法`);
    rows.push(values[0], values[1], values[2]);
  }
  if (!size3d && !size1d) throw new Error(".cube 缺少 LUT_3D_SIZE 或 LUT_1D_SIZE");
  const min = domainMin ?? [0, 0, 0], max = domainMax ?? [1, 1, 1];
  if (min.some((value, channel) => !(max[channel] > value))) throw new Error(".cube DOMAIN_MAX 必須大於 DOMAIN_MIN");
  const expected = size3d ? size3d ** 3 * 3 : size1d * 3;
  if (rows.length !== expected) throw new Error(`無效或不完整的 ${size3d ? "3D" : "1D"} LUT：需要 ${expected / 3} 列，實際 ${rows.length / 3} 列`);
  const values = new Float32Array(rows);
  return size3d
    ? { kind: "3d", ...(title ? { title } : {}), size: size3d, domainMin: min, domainMax: max, values }
    : { kind: "1d", ...(title ? { title } : {}), size: size1d, domainMin: min, domainMax: max, values };
}

/** 3D-only parser kept for the shipped ACES transforms. */
export function parseCubeLut(source: string): CubeLut {
  let size = 0;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  const values: number[] = [];
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("TITLE")) continue;
    const fields = line.split(/\s+/);
    if (fields[0] === "LUT_3D_SIZE") { size = Number(fields[1]); continue; }
    if (fields[0] === "DOMAIN_MIN") { domainMin = fields.slice(1, 4).map(Number) as [number, number, number]; continue; }
    if (fields[0] === "DOMAIN_MAX") { domainMax = fields.slice(1, 4).map(Number) as [number, number, number]; continue; }
    if (fields.length >= 3 && fields.slice(0, 3).every((field) => Number.isFinite(Number(field)))) values.push(...fields.slice(0, 3).map(Number));
  }
  if (!Number.isInteger(size) || size < 2 || values.length !== size ** 3 * 3) throw new Error("無效或不完整的 3D LUT");
  return { size, domainMin, domainMax, values: new Float32Array(values) };
}

/** FFmpeg-compatible tetrahedral interpolation (same tetrahedra and order as vf_lut3d). */
export function sampleCubeLut(lut: CubeLut, rgb: readonly [number, number, number]): [number, number, number] {
  const rScaled = clamp((rgb[0] - lut.domainMin[0]) / Math.max(1e-9, lut.domainMax[0] - lut.domainMin[0])) * (lut.size - 1);
  const gScaled = clamp((rgb[1] - lut.domainMin[1]) / Math.max(1e-9, lut.domainMax[1] - lut.domainMin[1])) * (lut.size - 1);
  const bScaled = clamp((rgb[2] - lut.domainMin[2]) / Math.max(1e-9, lut.domainMax[2] - lut.domainMin[2])) * (lut.size - 1);
  const r = Math.min(lut.size - 2, Math.floor(rScaled));
  const g = Math.min(lut.size - 2, Math.floor(gScaled));
  const b = Math.min(lut.size - 2, Math.floor(bScaled));
  const fr = rScaled - r;
  const fg = gScaled - g;
  const fb = bScaled - b;
  const redStride = 3;
  const greenStride = lut.size * 3;
  const blueStride = lut.size * lut.size * 3;
  const i000 = (r + g * lut.size + b * lut.size * lut.size) * 3;
  const i100 = i000 + redStride;
  const i010 = i000 + greenStride;
  const i001 = i000 + blueStride;
  const i110 = i100 + greenStride;
  const i101 = i100 + blueStride;
  const i011 = i010 + blueStride;
  const i111 = i110 + blueStride;
  const values = lut.values;
  const result: [number, number, number] = [0, 0, 0];
  for (let channel = 0; channel < 3; channel += 1) {
    const c000 = values[i000 + channel];
    const c100 = values[i100 + channel];
    const c010 = values[i010 + channel];
    const c001 = values[i001 + channel];
    const c110 = values[i110 + channel];
    const c101 = values[i101 + channel];
    const c011 = values[i011 + channel];
    const c111 = values[i111 + channel];
    if (fr >= fg) {
      if (fg >= fb) result[channel] = c000 + fr * (c100 - c000) + fg * (c110 - c100) + fb * (c111 - c110);
      else if (fr >= fb) result[channel] = c000 + fr * (c100 - c000) + fb * (c101 - c100) + fg * (c111 - c101);
      else result[channel] = c000 + fb * (c001 - c000) + fr * (c101 - c001) + fg * (c111 - c101);
    } else if (fb >= fg) result[channel] = c000 + fb * (c001 - c000) + fg * (c011 - c001) + fr * (c111 - c011);
    else if (fb >= fr) result[channel] = c000 + fg * (c010 - c000) + fb * (c011 - c010) + fr * (c111 - c011);
    else result[channel] = c000 + fg * (c010 - c000) + fr * (c110 - c010) + fb * (c111 - c110);
  }
  return result;
}

/** Per-channel linear interpolation of a 1D table. */
export function sampleCube1d(lut: Extract<ParsedCube, { kind: "1d" }>, rgb: readonly [number, number, number]): [number, number, number] {
  const result: [number, number, number] = [0, 0, 0];
  for (let channel = 0; channel < 3; channel += 1) {
    const scaled = clamp((rgb[channel] - lut.domainMin[channel]) / (lut.domainMax[channel] - lut.domainMin[channel])) * (lut.size - 1);
    const index = Math.min(lut.size - 2, Math.floor(scaled));
    const fraction = scaled - index;
    const low = lut.values[index * 3 + channel];
    const high = lut.values[(index + 1) * 3 + channel];
    result[channel] = low + (high - low) * fraction;
  }
  return result;
}

export function sampleParsedCube(lut: ParsedCube, rgb: readonly [number, number, number]): [number, number, number] {
  return lut.kind === "3d" ? sampleCubeLut(lut, rgb) : sampleCube1d(lut, rgb);
}

/** Writes a 3D table in .cube order (red fastest). Six decimals; domain 0–1 is implicit. */
export function serializeCube3d(values: Float32Array, size: number, title: string): string {
  if (values.length !== size ** 3 * 3) throw new Error("3D LUT 資料長度與尺寸不符");
  const safeTitle = title.replace(/["\r\n]/g, "").slice(0, 120);
  const lines = [`TITLE "${safeTitle}"`, `LUT_3D_SIZE ${size}`];
  for (let index = 0; index < values.length; index += 3) {
    lines.push(`${values[index].toFixed(6)} ${values[index + 1].toFixed(6)} ${values[index + 2].toFixed(6)}`);
  }
  return `${lines.join("\n")}\n`;
}

const cache = new Map<string, Promise<CubeLut>>();

export function loadCubeLut(path: string): Promise<CubeLut> {
  const relativePath = path.replace(/^\/?color\/aces2\//, "").replace(/^\//, "");
  const url = new URL(path.replace(/^\//, ""), document.baseURI).toString();
  const key = window.haoDesktop?.readColorAsset ? `desktop:${relativePath}` : url;
  const cached = cache.get(key);
  if (cached) return cached;
  const source = window.haoDesktop?.readColorAsset
    ? window.haoDesktop.readColorAsset(relativePath)
    : fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`LUT 載入失敗：${response.status}`);
      return response.text();
    });
  const pending = source.then(parseCubeLut);
  cache.set(key, pending);
  return pending;
}
