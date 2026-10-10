import type { EditorCommand } from "./commandTypes";
import type { EditProject, MotionGraphic } from "./types";
import { canonicalJson } from "../shared/canonicalJson";

declare const proofBrand: unique symbol;
/** Process-local compiler authority, never a command or persisted project field. */
export interface NativePaintOwnerRevisionProof { readonly [proofBrand]: true }
interface Binding { project: string; batch: string; graphicIds: readonly string[] }
const issued = new WeakMap<NativePaintOwnerRevisionProof, Binding>();

function flatCommands(batch: EditorCommand): EditorCommand[] {
  if (batch.type !== "batch") throw new Error("Native paint owner proof requires an exact command batch");
  const result: EditorCommand[] = [], pending = [...batch.commands].reverse();
  while (pending.length) {
    const command = pending.pop()!;
    if (command.type === "batch") pending.push(...[...command.commands].reverse());
    else result.push(command);
  }
  return result;
}
function referenceOwners(project: EditProject, graphicId: string) {
  return (project.referenceMotionInstances ?? []).filter(instance => instance.roles.some(role => role.kind === "graphic" && role.id === graphicId));
}
function assertOtherOwnersAbsent(project: EditProject, before: MotionGraphic, after = before): void {
  if (before.templateOwner || after.templateOwner || project.motionScenes?.some(scene => scene.graphicIds.includes(before.id))) {
    throw new Error("Native paint reference proof cannot authorize a movie template or Motion scene owner");
  }
}
function readonlyIds(ids: readonly string[]): ReadonlySet<string> {
  const values = new Set(ids);
  const view: ReadonlySet<string> = {
    size: values.size, has: value => values.has(value), entries: () => values.entries(),
    keys: () => values.keys(), values: () => values.values(), [Symbol.iterator]: () => values.values(),
    forEach: (callback, thisArg) => { for (const value of values) callback.call(thisArg, value, value, view); },
  };
  return Object.freeze(view);
}

/** Internal issuer for the owning physical recompiler only. It does not prove a
 * compilation itself: callers derive this exact batch from the true compiler
 * and finish scoped-content checks before returning or committing it. MCP
 * accepts no proof argument, and v4 independently recompiles anew at
 * both audit and apply. A caller's declaration/boolean is never authority. */
export function issueNativePaintOwnerRevisionProof(project: EditProject, exactBatch: EditorCommand,
  allowedReferenceInstanceIds: readonly string[]): NativePaintOwnerRevisionProof {
  const commands = flatCommands(exactBatch), allowed = new Set(allowedReferenceInstanceIds), grants = new Set<string>();
  if (allowed.size !== allowedReferenceInstanceIds.length) throw new Error("Native paint reference proof has duplicate instance identities");
  for (const id of allowed) {
    const matches = (project.referenceMotionInstances ?? []).filter(instance => instance.id === id);
    if (matches.length !== 1) throw new Error("Native paint reference proof requires a unique current instance");
    for (const role of matches[0].roles.filter(role => role.kind === "graphic")) {
      const targets = project.motionGraphics.filter(graphic => graphic.id === role.id);
      if (targets.length !== 1 || referenceOwners(project, role.id).length !== 1) {
        throw new Error("Native paint reference proof requires a unique graphic and single reference owner");
      }
      assertOtherOwnersAbsent(project, targets[0]);
    }
  }
  for (const command of commands) {
    if (command.type === "remove_reference_motion_instance") throw new Error("Native paint reference proof cannot detach instance ownership");
    if (command.type === "update_motion_graphic") {
      const before = project.motionGraphics.find(graphic => graphic.id === command.graphicId);
      if (!before) continue; // Normal domain application still rejects missing targets.
      const after = { ...before, ...command.patch };
      if (!before.paintV1 && !after.paintV1) continue;
      assertOtherOwnersAbsent(project, before, after);
      const owners = referenceOwners(project, before.id);
      if (owners.length > 1) throw new Error("Native paint reference proof cannot authorize multiple reference owners");
      if (owners.length) {
        if (!allowed.has(owners[0].id)) throw new Error("Native paint target is outside the compiled reference instance");
        grants.add(before.id);
      }
    }
    if (command.type === "upsert_reference_motion_instance") {
      const previous = project.referenceMotionInstances?.find(instance => instance.id === command.instance.id);
      if (previous) {
        if (!allowed.has(previous.id) || command.expectedInstanceRevision !== previous.instanceRevision
          || command.instance.instanceRevision !== previous.instanceRevision + 1) {
          throw new Error("Native paint reference proof requires the exact current sequential instance revision");
        }
        for (const old of previous.roles) {
          const retained = command.instance.roles.find(role => role.key === old.key);
          if (retained && (retained.id !== old.id || retained.kind !== old.kind || retained.parentId !== old.parentId)) {
            throw new Error("Native paint reference proof cannot rebind retained semantic ownership");
          }
          if (!retained && old.kind !== "graphic") throw new Error("Native paint reference proof cannot remove source topology");
        }
      }
      for (const role of command.instance.roles.filter(role => role.kind === "graphic")) {
        if (referenceOwners(project, role.id).some(owner => owner.id !== command.instance.id)) {
          throw new Error("Native paint reference proof cannot transfer or duplicate reference ownership");
        }
      }
    }
  }
  const proof = Object.freeze(Object.create(null)) as NativePaintOwnerRevisionProof;
  issued.set(proof, { project: canonicalJson(project), batch: canonicalJson(exactBatch), graphicIds: Object.freeze([...grants]) });
  return proof;
}

/** Check once at the outer applyCommand boundary, before cloning/mutation. The
 * verified read-only IDs may then travel through that exact synchronous batch. */
export function verifyNativePaintOwnerRevisionProof(project: EditProject, exactBatch: EditorCommand,
  proof: unknown): ReadonlySet<string> {
  const binding = proof && typeof proof === "object" ? issued.get(proof as NativePaintOwnerRevisionProof) : undefined;
  if (!binding) throw new Error("Native paint owner revision proof was not issued by this process");
  if (canonicalJson(project) !== binding.project || canonicalJson(exactBatch) !== binding.batch) {
    throw new Error("Native paint owner revision proof project or exact batch changed");
  }
  return readonlyIds(binding.graphicIds);
}
