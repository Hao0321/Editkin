import type { EditorCommand } from "./commandTypes";
import type { EditProject, TimelineClip } from "./types";
import { EditGraphError } from "./editGraphError";
import { clipLinkMembers, expandLinkedClipIds, linkedClipRepresentative, unusedLinkGroupId } from "./clipLinks";
import { clipSlipError, isTemplateManagedClip, planClipExtension } from "./clipSourceEdits";
import { getSourceAnalysisBindingError } from "./clipSourceReplacement";
import { TRACK_LOCKED_MESSAGE } from "./trackLock";
import { applyRippleDelete, type RippleDeleteOutcome } from "./rippleDelete";

export const LINK_TEMPLATE_REFUSAL = "這組包含標題模板管理的片段，尚未能安全連結調整；原專案保持不變。";
export const LINK_TIMING_REFUSAL = "這個操作還不能安全套用到整組片段，請先取消連結；原專案保持不變。";
export const LINK_DONE = "已連結選取的片段，可一次復原。";
export const UNLINK_DONE = "已取消片段連結，可一次復原。";
export const LINK_SLIP_REFUSAL = "連結的另一段（例如分離的聲音）無法跟著換入點，原專案保持不變";
export const LINK_REPLACE_REFUSAL = "連結的另一段（例如分離的聲音）無法跟著換成新素材，原專案保持不變";

/** Source-time edits whose linked peers keep the same source offset (B5): slip, and a replace on a shared source. */
const SOURCE_SHIFTS = new Set<EditorCommand["type"]>(["slip_clip", "replace_clip_source"]);

const GESTURES = new Set<EditorCommand["type"]>(["move_clip", "move_clip_to_track", "trim_clip_start", "trim_clip_end", "split_clip", "delete_clip", "ripple_delete_clip", "extend_clip"]);

export interface LinkedCommandContext {
  generated: WeakSet<EditorCommand>;
  pending: Map<string, number>;
  splits: Map<string, string>;
}

function signature(project: EditProject, command: EditorCommand): string | undefined {
  if (!(GESTURES.has(command.type) || command.type === "slip_clip") || !("clipId" in command)) return undefined;
  const frame = (seconds: number) => Math.round(seconds * project.fps);
  return JSON.stringify([command.type, command.clipId,
    "timelineStart" in command ? frame(command.timelineStart) : "at" in command ? frame(command.at) : "seconds" in command ? frame(command.seconds)
      : command.type === "slip_clip" ? frame(command.sourceStart) : null,
    "trackId" in command ? command.trackId : "edge" in command ? command.edge : null]);
}

export function createLinkedCommandContext(project: EditProject, root: EditorCommand): LinkedCommandContext {
  const context: LinkedCommandContext = { generated: new WeakSet(), pending: new Map(), splits: new Map() };
  const visit = (command: EditorCommand) => {
    if (command.type === "batch") command.commands.forEach(visit);
    else if (command.type === "split_clip") context.splits.set(`${command.clipId}\0${Math.round(command.at * project.fps)}`, command.newClipId);
  };
  visit(root); return context;
}

/** Legacy fast paths stay exact when no linked member can be changed. */
export function needsLinkedCommandDispatch(project: EditProject, command: EditorCommand): boolean {
  if (command.type === "batch") return command.commands.some(child => needsLinkedCommandDispatch(project, child));
  if (command.type === "set_clip_links") return true;
  if (command.type === "delete_track") return Boolean(project.tracks.find(track => track.id === command.trackId)?.clips.some(clip => clip.linkGroupId));
  if (command.type === "precompose_clips") return command.clipIds.some(id => clipLinkMembers(project, id).length > 1);
  if (command.type === "compact_track") return Boolean(project.tracks.find(track => track.id === command.trackId)?.clips.some(clip => clip.linkGroupId));
  if (GESTURES.has(command.type) && project.tracks.some(track => track.clips.some(clip => clip.linkGroupId))) return true;
  return "clipId" in command && Boolean(project.tracks.flatMap(track => track.clips).find(clip => clip.id === command.clipId)?.linkGroupId)
    && (GESTURES.has(command.type) || SOURCE_SHIFTS.has(command.type) || command.type === "retime_clip" || command.type === "smart_cut_clip");
}

function assertMembersEditable(project: EditProject, members: readonly TimelineClip[]): void {
  if (members.some(clip => project.tracks.find(track => track.id === clip.trackId)?.locked)) throw new EditGraphError(TRACK_LOCKED_MESSAGE);
  if (members.some(clip => isTemplateManagedClip(project, clip.id))) throw new EditGraphError(LINK_TEMPLATE_REFUSAL);
  if (members.some(clip => {
    const asset = project.assets.find(item => item.id === clip.assetId);
    return !asset || asset.compositionId || asset.imageSequence || clip.layer?.role === "controller";
  })) throw new EditGraphError("請選取一般影片、圖片或聲音片段來連結。");
}

/** Delete the peers first, then close the primary gap once using the existing attachment/ripple rules. */
export function applyLinkedRippleDelete(project: EditProject, clipId: string): RippleDeleteOutcome {
  const members = clipLinkMembers(project, clipId);
  if (members.length < 2) return applyRippleDelete(project, clipId);
  assertMembersEditable(project, members);
  const primary = members.find(clip => clip.id === linkedClipRepresentative(project, clipId))!, peers = new Set(members.filter(clip => clip.id !== primary.id).map(clip => clip.id));
  // Peer attachments need their existing removal path; free captions and global ripple remain primary-owned.
  if (members.some(clip => peers.has(clip.id) && (project.motionTracks.some(track => track.clipId === clip.id)
    || project.tracks.flatMap(track => track.clips).some(child => child.layer?.parentClipId === clip.id || child.layer?.trackMatte?.sourceClipId === clip.id)))) {
    throw new EditGraphError(LINK_TIMING_REFUSAL);
  }
  for (const track of project.tracks) track.clips = track.clips.filter(clip => !peers.has(clip.id));
  return applyRippleDelete(project, primary.id);
}

/** One transaction; commands already supplied by a multi-selection batch are consumed only once. */
export function applyLinkedCommand(project: EditProject, command: EditorCommand, context: LinkedCommandContext, run: (command: EditorCommand) => void): boolean {
  const key = signature(project, command);
  if (!context.generated.has(command) && key && context.pending.has(key)) {
    const count = context.pending.get(key)!;
    if (count === 1) context.pending.delete(key); else context.pending.set(key, count - 1);
    return true;
  }
  if (context.generated.has(command)) return false;
  if (command.type === "set_clip_links") {
    const ids = expandLinkedClipIds(project, command.clipIds), selected = new Set(ids);
    if (command.clipIds.some(id => !ids.includes(id))) throw new EditGraphError("找不到這個片段，請重新選取。");
    const members = project.tracks.flatMap(track => track.clips).filter(clip => selected.has(clip.id));
    if (!members.length) throw new EditGraphError("請選取至少兩個片段來連結。");
    assertMembersEditable(project, members);
    if (command.groupId !== undefined) {
      if (members.length < 2) throw new EditGraphError("請選取至少兩個片段來連結。");
      if (!command.groupId || command.groupId.trim() !== command.groupId || command.groupId.length > 160) throw new EditGraphError("片段連結代號無效。");
      if (project.tracks.flatMap(track => track.clips).some(clip => clip.linkGroupId === command.groupId && !selected.has(clip.id))) throw new EditGraphError("片段連結代號已存在，請重新連結。");
    }
    for (const member of members) if (command.groupId === undefined) delete member.linkGroupId; else member.linkGroupId = command.groupId;
    return true;
  }
  if (command.type === "precompose_clips" && command.clipIds.some(id => clipLinkMembers(project, id).length > 1)
    || command.type === "compact_track" && project.tracks.find(track => track.id === command.trackId)?.clips.some(clip => clip.linkGroupId)) throw new EditGraphError(LINK_TIMING_REFUSAL);
  if (!("clipId" in command)) return false;
  const members = clipLinkMembers(project, command.clipId);
  if (members.length < 2) return false;
  if (command.type === "retime_clip" || command.type === "smart_cut_clip") throw new EditGraphError(LINK_TIMING_REFUSAL);
  if (!GESTURES.has(command.type) && !SOURCE_SHIFTS.has(command.type)) return false;
  assertMembersEditable(project, members);
  const owner = members.find(clip => clip.id === command.clipId)!, peers = members.filter(clip => clip.id !== owner.id);
  const dispatch = (generated: EditorCommand, consume = true) => {
    context.generated.add(generated);
    if (consume) {
      const pendingKey = signature(project, generated);
      if (pendingKey) context.pending.set(pendingKey, (context.pending.get(pendingKey) ?? 0) + 1);
    }
    run(generated);
  };
  if (command.type === "slip_clip" || command.type === "replace_clip_source") {
    applyLinkedSourceShift(project, command, owner, peers, dispatch);
    return true;
  }
  if (command.type === "ripple_delete_clip") {
    for (const peer of peers) for (const type of ["delete_clip", "ripple_delete_clip"] as const) {
      const pendingKey = signature(project, { type, clipId: peer.id })!;
      context.pending.set(pendingKey, (context.pending.get(pendingKey) ?? 0) + 1);
    }
    applyLinkedRippleDelete(project, owner.id); return true;
  }
  if (command.type === "split_clip") {
    const at = Math.round(command.at * project.fps) / project.fps;
    if (members.some(clip => at <= clip.timelineStart || at >= clip.timelineStart + clip.duration)) throw new EditGraphError("分割位置必須在每段連結片段的內部；原專案保持不變。");
    const rightGroup = unusedLinkGroupId(project, command.newClipId), rightIds = [command.newClipId];
    dispatch({ ...command }, false);
    for (const peer of peers) {
      const explicit = context.splits.get(`${peer.id}\0${Math.round(at * project.fps)}`);
      let id = explicit ?? `${command.newClipId}-linked-${peer.id}`, suffix = 0;
      if (!explicit) while (project.tracks.flatMap(track => track.clips).some(clip => clip.id === id)) id = `${command.newClipId}-linked-${peer.id}-${++suffix}`;
      dispatch({ type: "split_clip", clipId: peer.id, at, newClipId: id }); rightIds.push(id);
    }
    for (const clip of project.tracks.flatMap(track => track.clips)) if (rightIds.includes(clip.id)) clip.linkGroupId = rightGroup;
    return true;
  }
  if (command.type === "extend_clip") {
    const plans = members.map(clip => planClipExtension(project, clip.id, command.edge, Math.round(command.seconds * project.fps)));
    const starts = plans.map((plan, index) => Math.round((plan.timelineStart - members[index].timelineStart) * project.fps));
    if (plans.some(plan => plan.push) || starts.some(delta => delta !== starts[0])) throw new EditGraphError(LINK_TIMING_REFUSAL);
  }
  const delta = "timelineStart" in command ? Math.round(command.timelineStart * project.fps) / project.fps - owner.timelineStart : 0;
  const peerCommands: EditorCommand[] = peers.map(peer => command.type === "move_clip" || command.type === "move_clip_to_track"
    ? { type: "move_clip", clipId: peer.id, timelineStart: peer.timelineStart + delta }
    : { ...command, clipId: peer.id } as EditorCommand);
  dispatch({ ...command }, false);
  for (const peerCommand of peerCommands) dispatch(peerCommand);
  return true;
}

/**
 * Slip (and a replace on the same source) keeps every linked member on the same source offset, so a picture and the
 * sound separated from it (分離聲音) stay in sync (B5). Image members have no source time and stay. On a replace, only
 * members that played the replaced media follow onto the new media; independent linked media keep their own source.
 * When any member cannot follow (not enough media, analysis bound to its source…), the whole edit is refused.
 */
function applyLinkedSourceShift(project: EditProject, command: Extract<EditorCommand, { type: "slip_clip" | "replace_clip_source" }>,
  owner: TimelineClip, peers: readonly TimelineClip[], dispatch: (generated: EditorCommand, consume?: boolean) => void): void {
  const fps = project.fps, frame = (seconds: number) => Math.round(seconds * fps);
  const before = new Map(peers.map(peer => [peer.id, { assetId: peer.assetId, sourceStart: peer.sourceStart }]));
  const ownerAssetId = owner.assetId, ownerSourceFrame = frame(owner.sourceStart);
  const deltaFrames = frame(command.sourceStart) - ownerSourceFrame;
  dispatch({ ...command }, false);
  for (const peer of peers) {
    const original = before.get(peer.id)!;
    if (project.assets.find(asset => asset.id === original.assetId)?.kind === "image") continue;
    if (command.type === "slip_clip") {
      const target = (frame(original.sourceStart) + deltaFrames) / fps + 0;
      const error = clipSlipError(project, peer.id, target);
      if (error) throw new EditGraphError(`${LINK_SLIP_REFUSAL}：${error}`);
      dispatch({ type: "slip_clip", clipId: peer.id, sourceStart: target });
      continue;
    }
    if (original.assetId !== ownerAssetId) continue;
    const asset = project.assets.find(item => item.id === command.assetId);
    const sourceFrame = frame(command.sourceStart) + frame(original.sourceStart) - ownerSourceFrame;
    const reason = !asset ? "找不到新素材"
      : sourceFrame < 0 || (sourceFrame / fps) + peer.duration > asset.duration + 1e-6 ? "新素材從對應入點起長度不足"
        : getSourceAnalysisBindingError(project, peer);
    if (reason) throw new EditGraphError(`${LINK_REPLACE_REFUSAL}：${reason}`);
    peer.assetId = command.assetId;
    peer.sourceStart = sourceFrame / fps + 0;
  }
}

/** Global ripple/insert operations must not shift a picture while leaving its linked locked sound behind. */
export function assertLinkedTimingKept(before: EditProject, after: EditProject, root: EditorCommand): void {
  const previous = before.tracks.flatMap(track => track.clips), current = new Map(after.tracks.flatMap(track => track.clips).map(clip => [clip.id, clip]));
  const splitGroups = new Set<string>();
  const visit = (command: EditorCommand) => {
    if (command.type === "batch") command.commands.forEach(visit);
    else if (command.type === "split_clip") {
      const group = previous.find(clip => clip.id === command.clipId)?.linkGroupId;
      if (group) splitGroups.add(group);
    }
  };
  visit(root);
  for (const group of new Set(previous.map(clip => clip.linkGroupId).filter((id): id is string => Boolean(id)))) {
    const members = previous.filter(clip => clip.linkGroupId === group && current.get(clip.id)?.linkGroupId === group);
    if (members.length < 2) continue;
    const startDelta = Math.round((current.get(members[0].id)!.timelineStart - members[0].timelineStart) * before.fps);
    const lengthDelta = Math.round((current.get(members[0].id)!.duration - members[0].duration) * before.fps);
    if (members.some(clip => Math.round((current.get(clip.id)!.timelineStart - clip.timelineStart) * before.fps) !== startDelta
      || !splitGroups.has(group) && Math.round((current.get(clip.id)!.duration - clip.duration) * before.fps) !== lengthDelta)) throw new EditGraphError(LINK_TIMING_REFUSAL);
  }
}
