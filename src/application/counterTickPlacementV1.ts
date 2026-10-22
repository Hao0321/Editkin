import { deriveCounterVisualTicksV1, counterTickRequestV1Schema } from "./counterVisualTicksV1";
import { inspectReferenceMotionTemplateInstance } from "./referenceMotionTemplateInstances";
import { prepareProceduralSfxPlacementV1, type ProceduralSfxPlacementResolverV1 } from "./proceduralSfxPlacementV1";
import type { ProceduralSfxLibraryV1 } from "./proceduralSfxLibraryV1";
import type { ProjectSession } from "./projectSession";

/** Opt-in engine hook. Existing UI/VA/old compilers never call this implicitly. */
export async function prepareCounterTickPlacementV1(session: ProjectSession, library: Pick<ProceduralSfxLibraryV1, "list"> & ProceduralSfxPlacementResolverV1, payload: unknown, signal?: AbortSignal) {
  const request = counterTickRequestV1Schema.parse(payload), project = session.getSnapshot().history.present, task = session.beginTask(project);
  const current = () => { signal?.throwIfAborted(); if (!task.isCurrent()) throw new Error("COUNTER_PROJECT_CHANGED"); };
  current();
  for (const binding of request.bindings) if (binding.source === "reference_instance") {
    const inspection = await inspectReferenceMotionTemplateInstance(project, binding.instanceId); current();
    if (inspection.status !== "CURRENT") throw new Error(`COUNTER_INSTANCE_${inspection.status}`);
  }
  const visual = deriveCounterVisualTicksV1(project, request);
  if (!visual.selected.length) throw new Error("COUNTER_NO_COMPLETE_SOUND_HITS");
  const page = await library.list({ kind: "tick", limit: 5 }); current();
  const sound = page.entries.find(e => e.id === visual.soundId);
  if (!sound || sound.durationSamples !== visual.durationSamples) throw new Error("COUNTER_TICK_SOURCE_MISSING");
  const placement = await prepareProceduralSfxPlacementV1(session, library, { trackId: request.trackId, idPrefix: request.idPrefix, ...(request.newTrack ? { newTrack: request.newTrack } : {}),
    hits: visual.selected.map(h => ({ id: sound.id, sha256: sound.sha256, frame: h.frame, gain: request.sound.gain })) }, signal);
  current();
  return { placement, visual, ducking: "existing_render_sound_effect_sidechain" as const,
    sourceSha256: sound.sourceSha256, wavSha256: sound.sha256, defaultEnabled: false as const };
}
