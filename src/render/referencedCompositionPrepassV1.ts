import type { EditProject } from "../domain/types";

/** Internal render view only. Whole-project validation still includes unused compositions. */
export function selectReferencedCompositionsForRenderV1(project: EditProject): EditProject {
  const assets = new Map(project.assets.map(asset => [asset.id, asset]));
  const compositions = new Map(project.compositions.map(composition => [composition.id, composition]));
  const pending: string[] = [];
  const needed = new Set<string>();
  const enqueue = (tracks: EditProject["tracks"]): void => {
    for (const track of tracks) for (const clip of track.clips) {
      const id = assets.get(clip.assetId)?.compositionId;
      if (id) pending.push(id);
    }
  };
  // Conservatively include hidden, muted and disabled clips as well as visible clips.
  enqueue(project.tracks);
  while (pending.length) {
    const id = pending.pop()!;
    if (needed.has(id)) continue;
    const composition = compositions.get(id);
    if (!composition) throw new Error(`找不到預合成：${id}`);
    needed.add(id);
    enqueue(composition.tracks);
  }
  return { ...project, compositions: project.compositions.filter(composition => needed.has(composition.id)) };
}
