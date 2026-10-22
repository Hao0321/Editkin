import type { EditProject } from "../domain/types";

/** Call-scoped: first ID wins, raw group cardinality and authored traversal order stay intact. */
export function createTimelineSelectionIndex(project: Pick<EditProject, "tracks">) {
  const firstGroup = new Map<string, string | undefined>();
  const groups = new Map<string, string[]>();
  for (const track of project.tracks) for (const clip of track.clips) {
    const id = clip.id, group = clip.linkGroupId;
    if (!firstGroup.has(id)) firstGroup.set(id, group);
    if (group) {
      let members = groups.get(group);
      if (!members) { members = []; groups.set(group, members); }
      members.push(id);
    }
  }
  return {
    expand(ids: readonly string[]): string[] {
      const output: string[] = [], seen = new Set<string>();
      for (const id of ids) {
        if (!firstGroup.has(id)) continue;
        const group = firstGroup.get(id), members = group ? groups.get(group)! : [id];
        for (const member of members) if (!seen.has(member)) { seen.add(member); output.push(member); }
      }
      return output;
    },
    linked(id: string): boolean {
      const group = firstGroup.get(id);
      return Boolean(group && groups.get(group)!.length > 1);
    },
  };
}
