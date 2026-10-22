import type { EditProject } from "../domain/types";
import type { EditorCommand } from "../domain/commandTypes";
import { applyCommand } from "../domain/commands";
import { mesh3dOverlaysV1Schema, type Mesh3dOverlaysV1 } from "../motion/mesh3dOverlayV1";
import { z } from "zod";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";

const id = z.string().trim().min(1).max(160);
export const mesh3dOverlaySourcesV1Schema = z.array(z.strictObject({
  clipId: id, assetId: id, trackId: id,
  timelineStart: z.number().finite().nonnegative(), sourceStart: z.number().finite().nonnegative(),
  duration: z.number().finite().positive(),
})).max(6);
type Sources = z.infer<typeof mesh3dOverlaySourcesV1Schema>;

/** One ordinary command, dry-run validated; no write, native admission or art certification. */
export function prepareMesh3dOverlaysV1(project: EditProject, input: Mesh3dOverlaysV1, newSources: Sources = []) {
  if (!project.scene3d?.enabled) throw new Error("MESH_OVERLAY_ENABLED_SCENE_REQUIRED");
  const overlaysV1 = mesh3dOverlaysV1Schema.parse(input);
  const sceneCommand: EditorCommand = { type: "set_mesh_3d_scene", scene: { ...structuredClone(project.scene3d), overlaysV1 } };
  const clips: EditorCommand[] = mesh3dOverlaySourcesV1Schema.parse(newSources).map(source => ({ type: "add_clip", clip: {
    id: source.clipId, assetId: source.assetId, trackId: source.trackId, timelineStart: source.timelineStart,
    sourceStart: source.sourceStart, duration: source.duration, volume: 0, transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [],
  } }));
  const command: EditorCommand = clips.length ? { type: "batch", commands: [...clips, sceneCommand] } : sceneCommand;
  applyCommand(project, command);
  return { status: "PREPARED_NOT_APPLIED" as const, projectId: project.id, revision: project.revision,
    artStatus: "PENDING_REVIEW" as const, commands: [command] };
}
