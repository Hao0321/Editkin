// Instrument-only metadata. No encoded file or human approval is asserted.
import { createEmptyProject, validateProject } from "../../domain/editGraph";
import { createClipMask } from "../../domain/masks";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../../domain/types";
import type { RotoCutoutClipResultV1 } from "../rotoCutoutClipV1";
export function rotoProjectFixture() {
  const p = createEmptyProject("Cutout instrument", { id: "cutout-project", width: 1920, height: 1080, fps: 4 });
  p.assets = [{ id: "source", name: "Original", kind: "video", uri: "D:/control/source.mkv", duration: 4, width: 64, height: 40,
    derivatives: { sourceSha256: "a".repeat(64), generatedAt: "2026-10-16T00:00:00Z" }, license: "creator_owned", rightsBasis: "creator_owned" }];
  p.tracks[0].clips = [{ id: "selected", assetId: "source", trackId: p.tracks[0].id, timelineStart: 2, sourceStart: 1, duration: 1.25, volume: .7,
    transform: { ...DEFAULT_TRANSFORM, opacity: .8, x: 20, y: 5, scale: .9 }, color: { ...DEFAULT_COLOR }, keyframes: [], masks: [createClipMask("roi", "subject")] }];
  return validateProject(p);
}
export function rotoBakeFixture(): RotoCutoutClipResultV1 {
  const matteIdentity = { schema: "editkin.roto-matte-identity/v1" as const, sourceSha256: "a".repeat(64), cutoutSha256: "b".repeat(64), alphaSha256: "c".repeat(64),
    analysisSha256: "d".repeat(64), nativeCoreSha256: "e".repeat(64), sourceStart: 1, width: 64, height: 40, frameCount: 5, fps: 4, qualityState: "diagnostic" as const };
  return { schema: "editkin.roto-cutout-clip/v1", qualityState: "diagnostic", subjectConfirmation: "required", benchmarkAccepted: false,
    manifestPath: "D:/control/cutout-v1.json", clip: { path: "D:/control/cutout.mkv", bytes: 1234, sha256: "b".repeat(64) },
    width: 64, height: 40, frameCount: 5, fps: 4, duration: 1.25, alphaMode: "straight", codec: "ffv1", pixelFormat: "gbrap16le", inputAlphaBits: 16,
    audio: "source-pcm24", sourcePath: "D:/control/source.mkv", sourceSha256: "a".repeat(64), analysisSha256: "d".repeat(64), alphaSha256: "c".repeat(64), matteIdentity };
}
