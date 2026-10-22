// Instrument-only geometry. No file identity, real subject review or encoded movie is asserted.
import { rotoProjectFixture } from "./rotoCutoutProject.fixture";
import type { MatteTrackMeasurementV1, MatteTrackOptionsV1 } from "../matteTrackV1";
export function matteTrackFixtureV1() {
  const project = rotoProjectFixture();
  const options: MatteTrackOptionsV1 = { clipId: "selected", newTrackId: "matte-track", name: "Subject bounds", minimumAlpha: .1,
    referenceFrame: 0, createdAt: "2026-10-17T00:00:00.000Z" };
  const boxes = [[8, 8, 16, 16], [12, 10, 16, 16], null, [8, 8, 20, 16], [0, 0, 1, 1]];
  const measurement: MatteTrackMeasurementV1 = { schema: "editkin.matte-track-measurement/v1", sourceSha256: "a".repeat(64),
    alphaSha256: "c".repeat(64), analysisSha256: "d".repeat(64), subjectConfirmationSha256: "f".repeat(64),
    width: 64, height: 40, alphaBits: 16, fps: 4, frameCount: 5, sourceStart: 1, minimumAlpha: .1,
    frames: boxes.map((b, frame) => b ? { frame, time: frame / 4, confidence: .75, foregroundPixels: b[2] * b[3], alphaMass: b[2] * b[3],
      bbox: { x: b[0] / 64, y: b[1] / 40, width: b[2] / 64, height: b[3] / 40 },
      centroid: { x: (b[0] + b[2] / 2) / 64, y: (b[1] + b[3] / 2) / 40 } }
      : { frame, time: frame / 4, confidence: 0, foregroundPixels: 0, alphaMass: 0 }) };
  return { project, options, measurement };
}
