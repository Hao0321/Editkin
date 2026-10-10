import faceIndex from "../generated/fontFaceIndex.json";
import emMetrics from "../generated/fontEmMetrics.json";

export interface BundledFontFaceSpec {
  readonly faceId: string;
  readonly fontFamily: string;
  readonly fontWeight: number;
  readonly fontFile: string;
  readonly sha256: string;
  readonly manifestSha256: string;
}

const SHA256 = /^[a-f0-9]{64}$/;
const EXPECTED_FACE_COUNT = 43;
const byId = new Map<string, BundledFontFaceSpec>();
const specs: BundledFontFaceSpec[] = [];

// These are compiled, gate-bound inputs. No request or runtime manifest can
// extend this catalog or replace the digest expected for a physical face.
if (emMetrics.schema !== "editkin.font-em-metrics/v1" || !SHA256.test(emMetrics.manifestSha256)
  || emMetrics.faces.length !== EXPECTED_FACE_COUNT) throw new Error("Compiled bundled font metrics are invalid");
const metricsById = new Map(emMetrics.faces.map(face => [face.id, face]));
if (metricsById.size !== EXPECTED_FACE_COUNT) throw new Error("Compiled bundled font metrics contain duplicate faces");

for (const entry of faceIndex) {
  const [family, id, weights] = entry as [string, string, number[]];
  if (typeof family !== "string" || !family.trim() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)
    || !Array.isArray(weights) || !weights.length || new Set(weights).size !== weights.length) {
    throw new Error("Compiled bundled font index is invalid");
  }
  for (const weight of weights) {
    if (!Number.isInteger(weight) || weight < 100 || weight > 900) throw new Error("Compiled physical font weight is invalid");
    const faceId = `EditkinFace-${id}-${weight}`;
    const metrics = metricsById.get(faceId);
    if (!metrics || !SHA256.test(metrics.sha256) || byId.has(faceId)) throw new Error("Compiled bundled font catalog and metrics disagree");
    const spec = Object.freeze({ faceId, fontFamily: `EditkinFace ${id} ${weight}`, fontWeight: weight,
      fontFile: `render/${faceId}.ttf`, sha256: metrics.sha256, manifestSha256: emMetrics.manifestSha256 });
    byId.set(faceId, spec);
    specs.push(spec);
  }
}
if (specs.length !== EXPECTED_FACE_COUNT) throw new Error("Compiled bundled font catalog must contain exactly 43 faces");
const frozenSpecs: readonly BundledFontFaceSpec[] = Object.freeze(specs);

/** Exact physical identity only: no logical family, URL, path or requested SHA. */
export function bundledFontFaceSpec(faceId: string): BundledFontFaceSpec {
  const spec = typeof faceId === "string" && faceId.length <= 96 ? byId.get(faceId) : undefined;
  if (!spec) throw new Error("Unknown bundled physical font face ID");
  return spec;
}

export function bundledFontFaceSpecs(): readonly BundledFontFaceSpec[] {
  return frozenSpecs;
}
