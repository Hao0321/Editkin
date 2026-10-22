import { resolveLongformSourceV1, longformSourceSha256V1 } from "./longformMaterialIntakeV1";
import { extractMaterialKeyframes } from "./materialKeyframeExtraction";
import { getMaterialColorRuntimeIdentity, colorDigest } from "./materialColorSamplingRuntime";
import { recognizeWindowsOcrV1 } from "./windowsOcrRuntimeV1";
import { assembleLongformUiFocusDraftV1 } from "./longformUiFocusV1";
import { longformUiFocusRequestV1Schema, type LongformUiFocusFrameV1 } from "../domain/longformUiFocusV1";
import type { MaterialColorRuntime } from "./materialColorSamplingTypes";
import type { MediaColorMetadata } from "../domain/types";

export interface LongformUiFocusRuntimeV1 extends MaterialColorRuntime {
  sourceRoot: string; workRoot: string; color?: MediaColorMetadata;
  onFrame?: (frame: LongformUiFocusFrameV1 & { data: Uint8Array }) => void | Promise<void>;
}

/** No cache seal supplies detector pixels. Decode the requested instants from
 * the actual source with current tool identity, then perform real local OCR. */
export async function detectLongformUiFocusV1(raw: unknown, runtime: LongformUiFocusRuntimeV1) {
  const request = longformUiFocusRequestV1Schema.parse(raw); runtime.signal?.throwIfAborted();
  const sourcePath = await resolveLongformSourceV1(runtime.sourceRoot, request.sourcePath);
  const before = await longformSourceSha256V1(sourcePath, runtime.signal);
  if (before.sha256 !== request.expectedSourceSha256) throw Error("UI_FOCUS_SOURCE_CHANGED");
  const identity = await getMaterialColorRuntimeIdentity(runtime); runtime.signal?.throwIfAborted();
  if (identity.status !== "verified") throw Error("UI_FOCUS_DECODE_RUNTIME_UNVERIFIED");
  const samples = request.frameTimes.map((time, index) => ({ id: `focus-frame-${index + 1}`, time, sceneIndex: 0 }));
  const extracted = await extractMaterialKeyframes({ sourcePath, sourceSha256: before.sha256, sourceStart: request.sourceStart,
    duration: request.duration, kind: "video", color: runtime.color, samples, sceneCount: 1, sceneCountVerified: false }, runtime, identity);
  runtime.signal?.throwIfAborted();
  if (!extracted.frames.length) throw Error(`UI_FOCUS_DECODE_BLOCKED:${extracted.analysis.omitted.map(row => row.reason).join(",")}`);
  const frames: LongformUiFocusFrameV1[] = [], omitted = extracted.analysis.omitted.map(row => ({ frameId: row.id, reason: row.reason }));
  for (const frame of extracted.frames) {
    runtime.signal?.throwIfAborted();
    // Provider failures remain failures, not empty successful observations.
    const ocr = await recognizeWindowsOcrV1(frame.data, { imageSha256: frame.display.jpeg.sha256,
      width: frame.display.decoded.width, height: frame.display.decoded.height, language: request.language }, runtime);
    const observation = { id: frame.id, display: frame.display, ocr };
    frames.push(observation);
    // Evidence sinks receive isolated copies, not mutable detector authority.
    await runtime.onFrame?.({ ...structuredClone(observation), data: Uint8Array.from(frame.data) });
    runtime.signal?.throwIfAborted();
  }
  const after = await longformSourceSha256V1(sourcePath, runtime.signal);
  if (before.sha256 !== after.sha256 || before.bytes !== after.bytes) throw Error("UI_FOCUS_SOURCE_CHANGED");
  if (colorDigest(await getMaterialColorRuntimeIdentity(runtime)) !== colorDigest(identity)) throw Error("UI_FOCUS_DECODE_RUNTIME_CHANGED");
  return assembleLongformUiFocusDraftV1({ recordingId: request.recordingId, sha256: before.sha256,
    start: request.sourceStart, duration: request.duration }, frames, omitted, request.targetTexts);
}
