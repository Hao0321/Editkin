import type { EditProject } from "../domain/types";
import type { LongformUiFocusArtifactV1 } from "../domain/longformUiFocusFileV1";
import type { LongformUiFocusProjectClockV1 } from "../domain/longformUiFocusProjectClockV1";
import type { LongformUiFocusHoldResultV1 } from "./longformUiFocusHoldJobsV1";
import { colorDigest } from "./materialColorSamplingRuntime";
import { verifyLongformUiFocusArtifactV1 } from "./longformUiFocusArtifactV1";
import { longformUiFocusHoldTargetV1 } from "./longformUiFocusHoldV1";
import { compositeFrameClock } from "../render/compositeFrameClock";
export function longformUiFocusProjectContextV1(project: EditProject, artifact: LongformUiFocusArtifactV1, hold: LongformUiFocusHoldResultV1) {
  verifyLongformUiFocusArtifactV1(artifact, artifact.artifactId);
  const { receiptSha256, ...body } = hold;
  if (receiptSha256 !== colorDigest(body) || hold.state !== "TRACKING_EVIDENCE_READY" || hold.flags.length || !hold.pixelTemplateContinuityVerified
    || hold.focusHintsReady !== false || hold.projectModified !== false || hold.selectableByDefault !== false || hold.artworkStatus !== "ART_PENDING_CLAUDE"
    || hold.draftId !== artifact.draft.draftId || hold.sourceSha256 !== artifact.draft.source.sha256
    || !hold.frames.length || hold.frames.length > 256 || hold.sourceFrameCount !== hold.frames.length || hold.frames.some(row => row.flags.length))
    throw Error("UI_FOCUS_PROJECT_HOLD_BINDING");
  const target = longformUiFocusHoldTargetV1(artifact.draft, { draftId: hold.draftId, candidateId: hold.candidateId, duration: hold.requestedDuration });
  if (Math.abs(target.start - hold.sourceStart) > 1e-7 || Math.abs(target.end - hold.sourceEnd) > 1e-7) throw Error("UI_FOCUS_PROJECT_HOLD_WINDOW");
  const clip = project.tracks.flatMap(track => track.clips).find(row => row.id === artifact.project.clipId);
  if (!clip || project.id !== artifact.project.id || project.revision !== artifact.project.revision || colorDigest(project) !== artifact.project.canonicalSha256
    || clip.assetId !== artifact.project.assetId || clip.sourceStart !== artifact.draft.source.start || clip.duration !== artifact.draft.source.duration
    || artifact.draft.source.recordingId !== clip.id || !Number.isFinite(project.fps) || project.fps <= 0 || project.fps > 120
    || clip.sourceStart < 0 || clip.duration <= 0 || clip.timelineStart < 0) throw Error("UI_FOCUS_PROJECT_CURRENT_CONTEXT");
  return { project: { ...artifact.project, fps: project.fps, timelineStart: clip.timelineStart, sourceStart: clip.sourceStart, duration: clip.duration },
    target, sourceOrigin: target.frame.display.decoded.timelineOrigin };
}
/** All coordinates come from the owned successful hold. Clock rows cannot
 * invent poses, interpolate across drops, extend the last pose or reacquire. */
export function assembleLongformUiFocusProjectClockV1(project: EditProject, artifact: LongformUiFocusArtifactV1, hold: LongformUiFocusHoldResultV1,
  actual: { frames: Array<{ projectFrame: number; sourcePts: number; sourceTime: number; imageSha256: string }>;
    sourceTimestampOffsetPts: number; inputFramesObserved: number; outputFramesObserved: number; droppedSourceFrames: number; duplicatedSourceFrames: number;
    processStdoutSha256: string; processStderrSha256: string }, provider: { decodeRuntimeIdentitySha256: string; implementationSha256: string },
  projectTimeBase: { numerator: number; denominator: number }): LongformUiFocusProjectClockV1 {
  const context = longformUiFocusProjectContextV1(project, artifact, hold), held = new Map(hold.frames.map(row => [row.pts, row]));
  const clock = compositeFrameClock(project.fps, context.project.timelineStart), [rateNumerator, rateDenominator] = clock.rate.split("/").map(Number);
  if (projectTimeBase.numerator !== rateDenominator || projectTimeBase.denominator !== rateNumerator
    || ![actual.sourceTimestampOffsetPts, actual.inputFramesObserved, actual.outputFramesObserved, actual.droppedSourceFrames, actual.duplicatedSourceFrames].every(Number.isSafeInteger)
    || actual.inputFramesObserved < 1 || actual.inputFramesObserved > 65536 || actual.outputFramesObserved < 1
    || actual.outputFramesObserved > Math.ceil(context.project.duration * project.fps) + 1 || actual.droppedSourceFrames < 0 || actual.duplicatedSourceFrames < 0
    || ![actual.processStdoutSha256, actual.processStderrSha256, provider.decodeRuntimeIdentitySha256, provider.implementationSha256].every(value => /^[a-f0-9]{64}$/.test(value)))
    throw Error("UI_FOCUS_PROJECT_CLOCK_PROVIDER_BINDING");
  if (held.size !== hold.frames.length || !actual.frames.length || actual.frames.length > 256) throw Error("UI_FOCUS_PROJECT_CLOCK_FRAME_BUDGET");
  const frames = actual.frames.map((row, i) => {
    const source = held.get(row.sourcePts);
    if (!source || !Number.isSafeInteger(row.projectFrame) || row.projectFrame < clock.startFrame || row.projectFrame >= clock.startFrame + actual.outputFramesObserved || !Number.isSafeInteger(row.sourcePts)
      || source.imageSha256 !== row.imageSha256 || Math.abs(source.sourceTime - row.sourceTime) > 1e-7
      || (i > 0 && (row.projectFrame !== actual.frames[i - 1].projectFrame + 1 || row.sourcePts < actual.frames[i - 1].sourcePts)))
      throw Error("UI_FOCUS_PROJECT_CLOCK_PIXEL_OR_POSE_BINDING");
    return { projectFrame: row.projectFrame, sourceFrame: source.frame, sourcePts: row.sourcePts, sourceTime: row.sourceTime,
      imageSha256: row.imageSha256, targetQuad: structuredClone(source.targetQuad) };
  });
  const { canonicalSha256, id, revision, clipId, assetId, fps, timelineStart, sourceStart, duration } = context.project;
  const body: Omit<LongformUiFocusProjectClockV1, "receiptSha256"> = {
    schema: "editkin.longform-ui-focus-project-clock/v1", state: "SOURCE_PROJECT_CLOCK_READY", artifactId: artifact.artifactId,
    holdReceiptSha256: hold.receiptSha256, sourceSha256: hold.sourceSha256, contextSha256: colorDigest(context.project),
    project: { id, revision, canonicalSha256, clipId, assetId, fps, timelineStart, sourceStart, duration },
    sourceTimeBase: structuredClone(hold.sourceTimeBase), projectTimeBase: { ...projectTimeBase }, sourceTimestampOffsetPts: actual.sourceTimestampOffsetPts,
    timelineStartFrame: frames[0].projectFrame, timelineEndFrame: frames.at(-1)!.projectFrame + 1, frames,
    provider: { route: "ffmpeg-composite-clock", ...provider, processStdoutSha256: actual.processStdoutSha256,
      processStderrSha256: actual.processStderrSha256, inputFramesObserved: actual.inputFramesObserved, outputFramesObserved: actual.outputFramesObserved,
      droppedSourceFrames: actual.droppedSourceFrames, duplicatedSourceFrames: actual.duplicatedSourceFrames },
    sourceProjectPixelsVerified: true, nativePresentationVerified: false, browserPresentationVerified: false,
    projectModified: false, focusHintsReady: false, artworkStatus: "ART_PENDING_CLAUDE", selectableByDefault: false,
  };
  return { ...body, receiptSha256: colorDigest(body) };
}
