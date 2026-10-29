// W3-6: the design brief in one call. A real public Video Autopilot Kit (copied, compiled by its own Python bridge) and a
// real saved 3-minute chapter project: the paged read (VA v4 contract: context, then beat:<id>, nextOffset until
// hasMore=false) and the one-call read (pageId "all") return the same identity, recipe hashes and bytes; pages 2…n come
// from the source-validated cache; a Skill source edit recompiles.
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useTempRoots } from "../test/tempRoot.mjs";
import { designRequestSchema } from "../application/autopilotDesignContract";
import { compileCurrentDesign, compileCurrentDesignCached, designBriefOneCall, DESIGN_BRIEF_ONE_CALL_MAX_BYTES, forgetCurrentDesignBriefs,
  registerAutopilotDesignTools } from "./autopilotDesignTools";
import { createProjectFile } from "./storage";

const publicKit = resolve(import.meta.dirname, "../../../../video-autopilot-kit/codex-skill/video-autopilot");
const ENV_KEYS = ["EDITKIN_WORKSPACE", "EDITKIN_VIDEO_AUTOPILOT_SKILL", "EDITKIN_PLUGIN_ROOTS", "EDITKIN_GPU_COMPOSITOR_PATH"] as const;
const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const temp = useTempRoots();
let skillRoot = "";
const handlers = new Map<string, (input: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
registerAutopilotDesignTools({ registerTool: (name: string, _config: unknown, handler: never) => handlers.set(name, handler) } as never);
const brief = async (input: Record<string, unknown>) => {
  const result = await handlers.get("get_autopilot_design_brief")!({ projectPath: "chapter.editkin.json", request, offset: 0, maxTokens: 900, ...input });
  expect(result.isError, result.content[0].text).toBeUndefined();
  return { value: JSON.parse(result.content[0].text) as Record<string, any>, bytes: Buffer.byteLength(result.content[0].text) };
};
const request = designRequestSchema.parse({ format: "longform", domain: "tech", topic: "三分鐘章節：自動剪輯工作流程", duration: 180,
  beats: [
    { id: "hook", role: "first_frame", energy: 0.8, subject: "成品畫面先看" },
    { id: "problem", role: "chapter", energy: 0.55, subject: "手動剪輯要花的時間" },
    { id: "process", role: "process", energy: 0.6, subject: "工具一步一步完成" },
    { id: "proof", role: "proof", energy: 0.7, subject: "實際輸出的影片" },
    { id: "compare", role: "comparison", energy: 0.65, subject: "前後差別" },
    { id: "payoff", role: "payoff", energy: 0.75, subject: "最後成果與下一步" },
  ] });

/** The VA v4 paged read of one page id: every call, its identity and the joined text. */
async function readPages(pageId: string) {
  let offset = 0, calls = 0, bytes = 0, text = "", identity: Record<string, unknown> | undefined;
  for (;;) {
    const page = await brief({ pageId, offset });
    calls += 1; bytes += page.bytes; text += page.value.text;
    const { projectSha256, sourceSha256, briefSha256, recipeSha256 } = page.value;
    identity ??= { projectSha256, sourceSha256, briefSha256, ...(recipeSha256 ? { recipeSha256 } : {}) };
    if (!page.value.hasMore) return { calls, bytes, text, identity };
    offset = page.value.nextOffset;
  }
}

describe.skipIf(!existsSync(join(publicKit, "editkin_design_bridge.py")))("W3-6 design brief in one call (real public Kit)", () => {
  beforeAll(async () => {
    const root = await temp.create("w25-design-brief-");
    skillRoot = join(root, "video-autopilot");
    await cp(publicKit, skillRoot, { recursive: true });
    await mkdir(join(root, "plugins"));
    await mkdir(join(root, "ws"));
    process.env.EDITKIN_WORKSPACE = join(root, "ws");
    process.env.EDITKIN_VIDEO_AUTOPILOT_SKILL = join(skillRoot, "SKILL.md");
    process.env.EDITKIN_PLUGIN_ROOTS = join(root, "plugins");
    delete process.env.EDITKIN_GPU_COMPOSITOR_PATH;
    await createProjectFile("chapter.editkin.json", "三分鐘章節", 1920, 1080, 30);
    forgetCurrentDesignBriefs();
  }, 120_000);
  afterAll(() => {
    forgetCurrentDesignBriefs();
    for (const key of ENV_KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  });

  it("returns the whole brief in one call with the identity, recipe hashes and bytes of every page", async () => {
    const pagedStarted = performance.now();
    const context = await readPages("context");
    const beats = [];
    for (const beat of request.beats) beats.push({ id: beat.id, ...await readPages(`beat:${beat.id}`) });
    const pagedMs = performance.now() - pagedStarted;
    const pagedCalls = context.calls + beats.reduce((sum, beat) => sum + beat.calls, 0);

    const oneStarted = performance.now();
    const one = await brief({ pageId: "all" });
    const oneMs = performance.now() - oneStarted;
    expect(one.value).toMatchObject({ status: "GREEN", pageId: "all", hasMore: false, quality: "REVIEW_REQUIRED", cacheHit: true,
      projectSha256: context.identity.projectSha256, sourceSha256: context.identity.sourceSha256, briefSha256: context.identity.briefSha256 });
    expect(JSON.stringify(one.value.context)).toBe(context.text);
    expect(one.value.beats.map((beat: { beatId: string }) => beat.beatId)).toEqual(request.beats.map(beat => beat.id));
    for (const [index, beat] of beats.entries()) {
      expect(one.value.beats[index].recipeSha256).toBe(beat.identity.recipeSha256);
      expect(JSON.stringify(one.value.beats[index].recipe)).toBe(beat.text);
      expect(beat.identity.briefSha256).toBe(context.identity.briefSha256);
    }
    expect(one.bytes).toBeLessThanOrEqual(DESIGN_BRIEF_ONE_CALL_MAX_BYTES);
    expect(pagedCalls).toBeGreaterThanOrEqual(1 + request.beats.length);
    // Measured on this real Kit + project (reported by the W3-6 package): paged calls and bytes versus one call.
    console.log("W3-6 design brief", JSON.stringify({ pagedCalls, pagedBytes: context.bytes + beats.reduce((sum, beat) => sum + beat.bytes, 0),
      pagedMs: Math.round(pagedMs), oneCall: 1, oneBytes: one.bytes, oneMs: Math.round(oneMs) }));
  }, 300_000);

  it("serves later reads from the cache and recompiles once a Skill source changes", async () => {
    forgetCurrentDesignBriefs();
    let compiles = 0;
    const counting: typeof compileCurrentDesign = async (...args) => { compiles += 1; return compileCurrentDesign(...args); };
    const first = await compileCurrentDesignCached(request, {}, counting);
    const second = await compileCurrentDesignCached(request, {}, counting);
    expect([first.cacheHit, second.cacheHit, compiles]).toEqual([false, true, 1]);
    expect(second.brief).toEqual(first.brief);
    const reference = join(skillRoot, "references", "design-reference-dna-v6.md");
    await writeFile(reference, `${await readFile(reference, "utf8")}\n`, "utf8");
    const changed = await compileCurrentDesignCached(request, {}, counting);
    expect([changed.cacheHit, compiles]).toEqual([false, 2]);
    expect(changed.brief.sourceSha256).not.toBe(first.brief.sourceSha256);
    // A different review policy is a different brief, never a cache hit.
    const agent = await compileCurrentDesignCached(request, { reviewPolicy: { mode: "agent_reference_comparison", authorization: "Creator authorizes comparison of full rendered scenes" } }, counting);
    expect([agent.cacheHit, compiles]).toEqual([false, 3]);
  }, 300_000);

  it("answers an oversize brief with the page index to read instead", async () => {
    const { brief: compiled } = await compileCurrentDesignCached(request);
    const index = designBriefOneCall(compiled, { status: "GREEN" }, 1024);
    expect(index).toMatchObject({ pageId: "all", hasMore: true, oversize: true, maxBytes: 1024 });
    expect((index.pages as Array<{ pageId: string }>).map(page => page.pageId)).toEqual(["context", ...request.beats.map(beat => `beat:${beat.id}`)]);
    expect(Buffer.byteLength(JSON.stringify(index))).toBeLessThan(2048);
  }, 120_000);
});
