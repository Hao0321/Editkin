import { isAbsolute, resolve } from "node:path";
import type { EditProject } from "../domain/types";
import { resolveMediaPath } from "../render/mediaProcess";
import { analyzeMotionTrack } from "./motionTracking";
import { motionTrackRetrackSourceV1, prepareMotionTrackRetrackV1, type MotionTrackRetrackJobV1 } from "./motionTrackRetrackV1";

/** EG5 package handler; no service/IPC registration, project write or second apply owner.
 * The selected original URI and optional pinned SHA come exclusively from the captured live job. */
export async function analyzeMotionTrackRetrackV1(project: EditProject, job: MotionTrackRetrackJobV1,
  host: { assetBase: string }, requestedRuntime: Parameters<typeof analyzeMotionTrack>[1]) {
  const selected = motionTrackRetrackSourceV1(project, job), runtime = Object.freeze({ ...requestedRuntime });
  if (!isAbsolute(host.assetBase) || resolve(host.assetBase) !== host.assetBase) throw Error("RETRACK_ABSOLUTE_ASSET_BASE_REQUIRED");
  if (selected.signal && runtime.signal && selected.signal !== runtime.signal) throw Error("RETRACK_SINGLE_OWNER_SIGNAL_REQUIRED");
  const signal = selected.signal ?? runtime.signal; signal?.throwIfAborted();
  const sourcePath = resolve(resolveMediaPath(selected.assetUri, host.assetBase));
  const analysis = await analyzeMotionTrack({ ...selected.request, sourcePath }, { ...runtime, signal });
  signal?.throwIfAborted(); motionTrackRetrackSourceV1(project, job);
  const plan = prepareMotionTrackRetrackV1(project, job, analysis, signal);
  return { plan, analysis };
}
