import * as z from "zod/v4";
import { findClip } from "../domain/editGraph";
import type { creativePresetCommands } from "../mcp/moduleCompilers";
import { readProject } from "../mcp/storage";

export const clipsSchema = z.array(z.string().min(1)).min(1).max(64);
/** One owner for the three existing clip-command adapters; the workspace boundary remains readProject. */
export async function clipCommands(projectPath: string, clipIds: string[], build: (clipId: string) => ReturnType<typeof creativePresetCommands>) {
  if (new Set(clipIds).size !== clipIds.length) throw new Error("clipIds 不可重複");
  const project = await readProject(projectPath);
  for (const clipId of clipIds) findClip(project, clipId);
  return { status: "PREPARED", projectRevision: project.revision, commands: clipIds.flatMap(build) };
}
