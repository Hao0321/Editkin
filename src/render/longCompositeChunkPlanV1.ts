import type { EditProject } from "../domain/types";
import { projectDuration } from "../domain/editGraph";
import { buildRenderPlan, type AssetPathResolver, type RenderPlan } from "./planner";
import { LongRenderRefusalV1 } from "./longRenderContractsV1";

/** A chunk may end in a black gap, or contain no media at all. Its frame clock still belongs to the parent schedule. */
export function buildLongCompositeChunkPlanV1(project: EditProject, resolvePath: AssetPathResolver, durationSeconds?: number, precision16 = false): RenderPlan {
  const duration = projectDuration(project);
  if (durationSeconds !== undefined && (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 60 + 1e-6 || duration > durationSeconds + 1e-7)) {
    throw new LongRenderRefusalV1("LONG_RENDER_OUTPUT_QA", "chunk duration does not contain its complete visual records");
  }
  const plan: RenderPlan = duration > 0 || durationSeconds === undefined ? buildRenderPlan(project, resolvePath) : {
    fps: project.fps, width: project.width, height: project.height, duration: durationSeconds, videoLayers: project.tracks.flatMap((track, trackIndex) =>
      track.kind === "video" && !track.hidden ? [{ trackId: track.id, trackIndex, segments: [] }] : []), audioClips: [], captions: [],
  };
  if (durationSeconds !== undefined) {
    plan.duration = durationSeconds;
    for (const layer of plan.videoLayers) {
      const end = layer.segments.at(-1); const lastTime = end ? end.start + end.duration : 0;
      if (lastTime < durationSeconds - 1e-8) layer.segments.push({ kind: "gap", start: lastTime, duration: durationSeconds - lastTime });
    }
  }
  if (precision16) plan.compositePrecision16 = true;
  return plan;
}
