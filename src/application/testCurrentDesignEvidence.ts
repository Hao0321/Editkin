import { strict as assert } from "node:assert";
import type { EditorCommand } from "../domain/commands";
import { MOTION_TREATMENT_FAMILIES, motionCommandFamilies } from "./motionTreatment";

type Call = (name: string, args: Record<string, unknown>) => Promise<{
  result: { isError?: boolean };
  value: Record<string, any>;
}>;

/** Keep source-backed STDIO integration fixtures on the same v4 design contract as production. */
export async function bindCurrentDesignEvidence<T extends {
  route: { format: string; domain: string };
  aesthetic: { primaryFamily: string };
  editorial: { narrative: { beats: readonly { id: string; energy: number; primaryFocus: string; summary: string; range: { startFrame: number; endFrame: number } }[] } };
  commands: readonly EditorCommand[];
}>(call: Call, projectPath: string, fps: number, plan: T) {
  const request = {
    format: plan.route.format, domain: plan.route.domain, topic: "實際 STDIO 調色證據",
    duration: Math.max(...plan.editorial.narrative.beats.map(beat => beat.range.endFrame)) / fps,
    styleFamily: plan.aesthetic.primaryFamily,
    beats: plan.editorial.narrative.beats.map(beat => ({
      id: beat.id, role: beat.id === "promise" ? "first_frame" : beat.id === "payoff" ? "payoff" : "chapter",
      energy: beat.energy, subject: beat.primaryFocus,
    })),
  };
  async function readPage(pageId: string) {
    let offset = 0, identity: Record<string, string> | undefined;
    for (let pageNumber = 0; pageNumber < 30; pageNumber += 1) {
      const { result, value } = await call("get_autopilot_design_brief", { projectPath, request, pageId, offset, maxTokens: 900 });
      assert.equal(result.isError, undefined, JSON.stringify(value));
      assert.equal(value.status, "GREEN");
      assert.equal(value.pageId, pageId);
      const current = { projectSha256: value.projectSha256 as string, sourceSha256: value.sourceSha256 as string,
        briefSha256: value.briefSha256 as string, ...(value.recipeSha256 ? { recipeSha256: value.recipeSha256 as string } : {}) };
      if (identity) assert.deepEqual(current, identity);
      else identity = current;
      assert.equal(typeof value.text, "string");
      if (!value.hasMore) return current;
      assert.ok(value.nextOffset > offset);
      offset = value.nextOffset as number;
    }
    throw new Error(`Current design page did not finish: ${pageId}`);
  }
  const identity = await readPage("context");
  const recipes = await Promise.all(request.beats.map(async beat => {
    const recipe = await readPage(`beat:${beat.id}`);
    assert.equal(recipe.projectSha256, identity.projectSha256);
    assert.equal(recipe.sourceSha256, identity.sourceSha256);
    assert.equal(recipe.briefSha256, identity.briefSha256);
    assert.match(recipe.recipeSha256 ?? "", /^[a-f0-9]{64}$/);
    return recipe.recipeSha256!;
  }));
  const designCommandStart = plan.commands.length;
  const captions: EditorCommand[] = plan.editorial.narrative.beats.map(beat => ({
    type: "add_caption", caption: { id: `test-design-${beat.id}`, text: beat.summary,
      start: beat.range.startFrame / fps, duration: (beat.range.endFrame - beat.range.startFrame) / fps },
  }));
  const commands = [...plan.commands, ...captions];
  const motionTreatment = { schema: "editkin.motion-treatment/v1" as const,
    decisions: MOTION_TREATMENT_FAMILIES.map(family => {
      const commandIndexes = commands.flatMap((command, index) => motionCommandFamilies(command).includes(family) ? [index] : []);
      return { family, action: commandIndexes.length ? "use" as const : "omit" as const,
        reason: commandIndexes.length ? "以實際調色與字幕命令呈現工程樣片" : "這份樣片不需要此類效果",
        beatIds: commandIndexes.length ? request.beats.map(beat => beat.id) : [], commandIndexes };
    }),
  };
  return { ...plan, commands, editorial: { ...plan.editorial, motionTreatment },
    designEvidence: { schema: "editkin.autopilot-design-evidence/v1" as const, request,
      projectSha256: identity.projectSha256, sourceSha256: identity.sourceSha256, briefSha256: identity.briefSha256,
      decisions: request.beats.map((beat, index) => ({ beatId: beat.id, recipeSha256: recipes[index],
        application: `保留實際調色測試畫面，使用字幕標示${beat.subject}的量測段落`, commandIndexes: [designCommandStart + index] })) } };
}
