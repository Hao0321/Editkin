import type { EditorCommand } from "./commandTypes";
import type { EditProject } from "./types";
import { canonicalJson } from "../shared/canonicalJson";
import { assertOriginalSceneGraphicRevision } from "./originalSceneGraphicRevision";

export type OriginalSourceOwnerRevisionCommand = Extract<EditorCommand, { type: "revise_original_motion_scene_graphic" }>;
declare const sourceProofBrand: unique symbol;
export interface OriginalSourceOwnerRevisionProof { readonly [sourceProofBrand]: true }
const issued = new WeakMap<OriginalSourceOwnerRevisionProof, { project: string; batch: string; sceneId: string }>();

/** A complete, flat owner replacement. One aesthetic declaration is metadata;
 * media, geometry, other owners, nested batches and manual commands are absent. */
function ownerBatch(project: EditProject, batch: EditorCommand) {
  if (batch.type !== "batch" || !batch.commands.length || batch.commands.some(command =>
    command.type !== "revise_original_motion_scene_graphic" && command.type !== "set_aesthetic_system")) {
    throw new Error("ORIGINAL_SOURCE_OWNER_EXACT_BATCH_REQUIRED: only flat source-owner revisions and aesthetic metadata are admitted");
  }
  if (batch.commands.filter(command => command.type === "set_aesthetic_system").length > 1) {
    throw new Error("ORIGINAL_SOURCE_OWNER_EXACT_BATCH_REQUIRED: aesthetic metadata cannot be duplicated");
  }
  const commands = batch.commands.filter((command): command is OriginalSourceOwnerRevisionCommand => command.type === "revise_original_motion_scene_graphic");
  const sceneId = commands[0]?.sceneId, scenes = project.motionScenes?.filter(scene => scene.id === sceneId) ?? [];
  if (scenes.length !== 1 || commands.length !== scenes[0].graphicIds.length
    || commands.some((command, ordinal) => command.sceneId !== sceneId || command.expectedGraphic.id !== scenes[0].graphicIds[ordinal]
      || command.graphic.id !== scenes[0].graphicIds[ordinal])) {
    throw new Error("ORIGINAL_SOURCE_OWNER_EXACT_BATCH_REQUIRED: preserve one owner's complete ordered graphic identities");
  }
  const indexes = batch.commands.flatMap((command, index) => command.type === "revise_original_motion_scene_graphic" ? [index] : []);
  if (indexes.some((value, ordinal) => ordinal > 0 && value !== indexes[ordinal - 1] + 1)) {
    throw new Error("ORIGINAL_SOURCE_OWNER_EXACT_BATCH_REQUIRED: owner commands must be contiguous");
  }
  const expectedGraphics = commands.map(command => command.expectedGraphic), graphics = commands.map(command => command.graphic);
  assertOriginalSceneGraphicRevision(project, { type: "revise_motion_scene_graphics", expectedRevision: project.revision,
    expectedScene: scenes[0], expectedGraphics, graphics });
  return { sceneId: scenes[0].id, commands };
}

/** Internal trusted recompiler issuer. This does not itself perform source I/O
 * or physical preparation. Issue only after both full compilations and exact
 * source/editorial binding, never from an editable command or MCP parameter. */
export function issueOriginalSourceOwnerRevisionProof(project: EditProject, exactBatch: EditorCommand): OriginalSourceOwnerRevisionProof {
  const { sceneId } = ownerBatch(project, exactBatch);
  const proof = Object.freeze(Object.create(null)) as OriginalSourceOwnerRevisionProof;
  issued.set(proof, { project: canonicalJson(project), batch: canonicalJson(exactBatch), sceneId });
  return proof;
}

/** Check the entire authenticated batch before cloning or any mutation. */
export function verifyOriginalSourceOwnerRevisionProof(project: EditProject, exactBatch: EditorCommand, proof: unknown): string {
  const binding = proof && typeof proof === "object" ? issued.get(proof as OriginalSourceOwnerRevisionProof) : undefined;
  if (!binding || binding.project !== canonicalJson(project) || binding.batch !== canonicalJson(exactBatch)) {
    throw new Error("ORIGINAL_SOURCE_OWNER_RECOMPILE_REQUIRED: exact current project and independently recompiled source batch authority are required");
  }
  const { sceneId } = ownerBatch(project, exactBatch);
  if (sceneId !== binding.sceneId) throw new Error("ORIGINAL_SOURCE_OWNER_RECOMPILE_REQUIRED: source owner changed");
  return sceneId;
}

/** Per-command stale/ownership/structural check inside that one verified batch. */
export function assertOriginalSourceOwnerRevisionCommand(project: EditProject, command: OriginalSourceOwnerRevisionCommand,
  authorizedSceneId?: string): void {
  if (!authorizedSceneId || authorizedSceneId !== command.sceneId) {
    throw new Error("ORIGINAL_SOURCE_OWNER_RECOMPILE_REQUIRED: source owner revision has no owning recompiler authority");
  }
  const scenes = project.motionScenes?.filter(scene => scene.id === command.sceneId) ?? [];
  if (scenes.length !== 1 || command.expectedGraphic.id !== command.graphic.id || !scenes[0].graphicIds.includes(command.graphic.id)) {
    throw new Error("Original source owner revision targets a foreign or missing identity");
  }
  const scene = scenes[0], expectedGraphics = scene.graphicIds.map(id => {
    const matches = project.motionGraphics.filter(graphic => graphic.id === id);
    if (matches.length !== 1) throw new Error("Original source owner graphic is missing or duplicated");
    return matches[0];
  });
  const current = expectedGraphics.find(graphic => graphic.id === command.graphic.id)!;
  if (canonicalJson(current) !== canonicalJson(command.expectedGraphic)) throw new Error("Original source owner graphic content is stale");
  assertOriginalSceneGraphicRevision(project, { type: "revise_motion_scene_graphics", expectedRevision: project.revision,
    expectedScene: scene, expectedGraphics, graphics: expectedGraphics.map(graphic => graphic.id === command.graphic.id ? command.graphic : graphic) });
}
