export interface CubeLut {
  size: number;
  domainMin: [number, number, number];
  domainMax: [number, number, number];
  values: Float32Array;
}

const clamp = (value: number, minimum = 0, maximum = 1) => Math.max(minimum, Math.min(maximum, value));

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
