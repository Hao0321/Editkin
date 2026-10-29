import type { EditProject } from "../domain/types";
import { LongRenderRefusalV1 } from "./longRenderContractsV1";

const roots = new Set(["schemaVersion", "revision", "id", "name", "width", "height", "fps", "editorialProfile", "aestheticSystem", "colorManagement",
  "scene25d", "scene3d", "particleSimulation", "assets", "compositions", "tracks", "captions", "captionStyle", "motionTracks", "motionGraphics", "motionScenes",
  "timelineTransitions", "director", "templateApplication", "referenceMotionInstances", "unifiedLayerOrderV1", "updatedAt"]);
const opaque = /^(assets|aestheticSystem|templateApplication|referenceMotionInstances|colorManagement|captionStyle|scene25d|scene3d|particleSimulation)(\.|$)|^motionGraphics\.\*\.(designV3|motionV2|holdBeatV3|paintV1|vectorV2)(\.|$)|^motionScenes\.\*\.(camera|semanticCues)(\.|$)|^tracks\.\*\.clips\.\*\.(timeRemap|proofStill)(\.|$)|^tracks\.\*\.clips\.\*\.creative\.nativeEffectInstances\.\*\.parameters(\.|$)/;
const localNames = new Set(["fps", "analysisFps", "duration", "durationFrames", "sourceStart", "sourceDuration", "createdAt", "updatedAt", "generatedAt",
  "beforeFrames", "afterFrames", "delayFrames", "entranceFrames", "exitFrames", "revealFrames", "periodSeconds", "sampleRate", "frameCount", "offsetX", "offsetY", "floatingFrame", "timelineTransitions"]);
const known = [
  /^tracks\.\*\.clips\.\*\.timelineStart$/, /^captions\.\*\.start$/, /^motionGraphics\.\*\.timelineStart$/, /^motionScenes\.\*\.startFrame$/,
  /^director\.markers\.\*\.time$/, /^tracks\.\*\.clips\.\*\.keyframes\.\*\.(time|frame)$/,
  /^tracks\.\*\.clips\.\*\.audioEnvelope\.(fades|volume)\.offset$/, /^tracks\.\*\.clips\.\*\.audioEnvelope\.volume\.points\.\*\.time$/,
  /^tracks\.\*\.clips\.\*\.masks\.\*\.(keyframes|rotoCorrections)\.\*\.(time|frame)$/,
  /^tracks\.\*\.clips\.\*\.masks\.\*\.(frozenRange|fixedWindowV3)\.(fromFrame|toFrame)$/,
  /^tracks\.\*\.clips\.\*\.masks\.\*\.matteSequence(\.|$)/,
  /^motionTracks\.\*\.points\.\*\.(time|frame)$/,
  /^motionGraphics\.\*\.vectorTrackingV1\.referenceTime$/,
];
function timingName(key: string): boolean {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/)
    .some(word => ["time", "timeline", "timestamp", "start", "end", "frame", "frames", "duration", "offset", "clock", "fps", "seconds", "milliseconds"].includes(word));
}

/** The only rebased clocks are top-level timeline positions. Source/local/authoring metadata clocks retain bytes. */
export function assertLongChunkClocksV1(project: EditProject): void {
  for (const key of Object.keys(project)) if (!roots.has(key)) {
    throw new LongRenderRefusalV1("LONG_RENDER_CHUNK_FIELD_UNSUPPORTED", "unknown project field cannot be assigned a chunk clock", { path: key });
  }
  const visit = (value: unknown, path: string) => {
    if (opaque.test(path) || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) visit(item, path + ".*"); return; }
    for (const [key, item] of Object.entries(value)) {
      const next = path ? `${path}.${key}` : key;
      if (!opaque.test(next) && timingName(key) && !localNames.has(key) && !known.some(pattern => pattern.test(next))) {
        throw new LongRenderRefusalV1("LONG_RENDER_CHUNK_FIELD_UNSUPPORTED", "unknown time-bearing field cannot be silently rebased", { path: next });
      }
      visit(item, next);
    }
  };
  visit(project, "");
}
