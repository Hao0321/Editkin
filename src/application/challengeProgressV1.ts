import * as z from "zod/v4";
import type { EditorCommand } from "../domain/commandTypes";
import { findMotionGraphicPreset, assertMotionGraphicPresetBinding } from "../creative/motionGraphicPresets";
import { createMotionGraphic } from "../motion/composition";
import { motionGraphicV3Frame, motionGraphicV3Layout } from "../motion/compositionV3";
import { editorialPercentageV1, editorialEvidenceRefsV1Schema } from "./editorialNumericValueV1";
import { beginEditorialDataGraphicsV1, requireEditorialDataClipV1, prepareEditorialDataGraphicsV1, editorialDataSoundV1Schema, type EditorialDataRuntimeV1, type EditorialDataSoundLibraryV1 } from "./editorialDataGraphicsV1";
import type { CounterVisualTickV1 } from "./counterVisualTicksV1";
import type { ProjectSession } from "./projectSession";

const integer = z.string().regex(/^(?:0|[1-9]\d{0,17})$/u);
const copy = z.string().min(1).max(80).regex(/^[^\r\n\t{}\\]+$/u).refine(s => s.trim() === s, "Explicit single-line label required");
export const challengeProgressRequestV1Schema = z.strictObject({
  schema: z.literal("editkin.challenge-progress/v1"), expectedRevision: z.number().int().nonnegative(), idPrefix: z.string().regex(/^[A-Za-z0-9_-]{1,60}$/u),
  clipId: z.string().min(1).max(160), presetId: z.string().min(1).max(160), total: integer, percentDecimals: z.number().int().min(0).max(4),
  states: z.array(z.strictObject({ startFrame: z.number().int().nonnegative(), endFrame: z.number().int().positive(), completed: integer, label: copy, evidenceRefs: editorialEvidenceRefsV1Schema })).min(1).max(32),
  sound: editorialDataSoundV1Schema.optional(),
});
/** Per-state progress values use the frozen progress_bar. No continuous trend or new appearance. */
export async function prepareChallengeProgressV1(session: ProjectSession, payload: unknown, library?: EditorialDataSoundLibraryV1, runtime: EditorialDataRuntimeV1 = {}) {
  const request = challengeProgressRequestV1Schema.parse(structuredClone(payload)), context = beginEditorialDataGraphicsV1(session, request.expectedRevision, runtime);
  const preset = findMotionGraphicPreset(request.presetId), clip = requireEditorialDataClipV1(context, request.clipId), project = context.source;
  if (preset.seed.kind !== "counter" || preset.seed.schema !== "hao.motion-composition/v3" || preset.seed.designV3?.template !== "progress_bar") throw Error("CHALLENGE_PROGRESS_EXISTING_PROGRESS_PRESET_REQUIRED");
  if (BigInt(request.total) === 0n) throw Error("EDITORIAL_PROGRESS_RANGE");
  const totalFrames = request.states.reduce((sum, s) => sum + s.endFrame - s.startFrame, 0);
  if (!Number.isSafeInteger(totalFrames) || totalFrames > context.cap) throw Error("CHALLENGE_PROGRESS_FRAME_BUDGET");
  const graphics = request.states.map((state, i) => {
    if (state.startFrame < clip.start || state.endFrame > clip.end || state.endFrame - state.startFrame < Math.ceil(project.fps)
      || state.endFrame - state.startFrame > 18000 || i > 0 && state.startFrame < request.states[i - 1].endFrame) throw Error("CHALLENGE_PROGRESS_STATE_WINDOW");
    if (i > 0 && BigInt(state.completed) < BigInt(request.states[i - 1].completed)) throw Error("CHALLENGE_PROGRESS_NONDECREASING_REQUIRED");
    const percent = editorialPercentageV1(state.completed, request.total, request.percentDecimals), id = `${request.idPrefix}-state-${i + 1}`;
    if (project.motionGraphics.some(g => g.id === id)) throw Error("CHALLENGE_PROGRESS_ID_CONFLICT");
    const graphic = createMotionGraphic(id, "counter", `${state.label}\n${percent}`, state.startFrame / project.fps, (state.endFrame - state.startFrame) / project.fps, undefined, preset.seed);
    assertMotionGraphicPresetBinding(graphic, preset.id); return { graphic, percent };
  });
  const hooks: CounterVisualTickV1[] = [], diagnostics: { frame: number; text: string | null }[] = [], finalFrames: number[] = [];
  let analyzedFrames = 0;
  for (let i = 0; i < graphics.length; i++) {
    const { graphic, percent } = graphics[i], state = request.states[i], layout = motionGraphicV3Layout(project, graphic);
    if (layout.context.lines[0] !== state.label || layout.context.lines[1] !== percent) throw Error("CHALLENGE_PROGRESS_RENDERER_CHANGED_COPY");
    let landed: number | undefined;
    for (let frame = state.startFrame; frame < state.endFrame; frame++) {
      context.remaining(); const receipt = motionGraphicV3Frame(project, graphic, frame, layout);
      const values = receipt.ops.filter(op => op.kind === "text" && op.id === "value");
      const value = values.length === 1 && values[0].kind === "text" ? values[0] : undefined;
      if (value?.text === percent && value.opacity > 0 && landed === undefined) landed = receipt.timelineFrame;
      if (landed !== undefined && value && value.text !== percent) throw Error("CHALLENGE_PROGRESS_FINAL_NOT_HELD");
      diagnostics.push({ frame: receipt.timelineFrame, text: value?.text ?? null }); if (diagnostics.length > 8) diagnostics.shift(); analyzedFrames++;
      if (analyzedFrames % 64 === 0 || frame + 1 === state.endFrame) {
        context.settings.onProgress?.({ graphicId: graphic.id, completed: analyzedFrames, total: totalFrames }); context.remaining();
        await context.wait(() => new Promise<void>(resolve => setTimeout(resolve, 0)));
      }
    }
    if (landed === undefined) throw Error("CHALLENGE_PROGRESS_FINAL_NOT_DRAWN");
    finalFrames.push(landed); hooks.push({ graphicId: graphic.id, role: "challenge_ledger:compiled_progress_final", frame: landed, text: percent, phase: "state" });
  }
  const commands: EditorCommand[] = graphics.map(({ graphic }) => ({ type: "add_motion_graphic", graphic }));
  return prepareEditorialDataGraphicsV1(context, "challenge_progress", commands, { schema: request.schema, total: request.total, percentDecimals: request.percentDecimals,
    rounding: "exact_integer_ratio_half_up", states: request.states.map((state, i) => ({ ...state, percent: graphics[i].percent, graphicId: graphics[i].graphic.id, firstFinalFrame: finalFrames[i] })),
    presetId: preset.id, editorialRole: "challenge_ledger", analyzedFrames, diagnostics, storedWholeFrames: 0, maximumStoredDiagnostics: 8,
    evidenceAuthority: "caller_authored_unverified", appearance: "unchanged_frozen_progress_bar", stateAnimationRestarts: true, zeroPercentHasFrozenMinimumRoundCap: true,
    compositedPixelVisibilityCertified: false }, hooks, request.states.at(-1)!.endFrame, request.idPrefix, request.sound, library);
}
