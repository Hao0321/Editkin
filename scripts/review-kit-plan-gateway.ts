// Resume an isolated synthetic Kit run at the plan boundary through the packaged Agent gateway.
// Usage: npx tsx scripts/review-kit-plan-gateway.ts --workspace <kit-bound-create-* directory> --portable <preview.exe>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createAutopilotV4Fixture } from "../src/application/autopilotPlanFixture";
import { autopilotPlanSha256, parseAutopilotPlan } from "../src/application/autopilotPlan";
import { MOTION_TREATMENT_FAMILIES, motionCommandFamilies } from "../src/application/motionTreatment";
import type { EditorCommand } from "../src/domain/commands";

const root = resolve(import.meta.dirname, "..");
const artifacts = realpathSync(resolve(root, "../artifacts/autopilot-desk"));
const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  assert(index >= 0 && process.argv[index + 1], `Missing ${name}`);
  return resolve(process.argv[index + 1]);
};
const workspace = realpathSync(argument("--workspace"));
const portable = realpathSync(argument("--portable"));
assert.equal(basename(portable).toLowerCase(), "autopilotdesk-community-preview.exe");
assert.match(basename(workspace), /^kit-bound-create-[a-z0-9]+$/i);
assert.equal(dirname(workspace).toLowerCase(), artifacts.toLowerCase());
const fixtureReport = JSON.parse(await readFile(join(workspace, "review-report.json"), "utf8"));
assert.equal(fixtureReport.status, "PASS");
assert.equal(fixtureReport.semanticFixtureOnly, true);
const projectPath = join(workspace, "movie.editkin.json");
assert(statSync(projectPath).isFile());
const run = join(workspace, "videos/_AUTOPILOT/editkin-v4/gateway-smoke");
const resources = join(dirname(portable), "resources");
const executableOnPath = (name: string) => execFileSync("where.exe", [name], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
const client = new Client({ name: "editkin-kit-plan-review", version: "1" });
const transport = new StdioClientTransport({ command: process.execPath, args: [join(resources, "runtime/agent-gateway.mjs")], cwd: root,
  env: { ...process.env,
    EDITKIN_AGENT_GATEWAY_TARGET: join(resources, "runtime/mcp.mjs"),
    EDITKIN_WORKSPACE: workspace, EDITKIN_AGENT_PROJECT_PATH: projectPath,
    EDITKIN_VIDEO_AUTOPILOT_SKILL: join(resources, "video-autopilot-kit/SKILL.md"),
    HAO_FFMPEG_PATH: executableOnPath("ffmpeg"), HAO_FFPROBE_PATH: executableOnPath("ffprobe"),
    EDITKIN_CACHE_ROOT: join(workspace, "cache"), EDITKIN_PLUGIN_ROOTS: join(root, "plugins"),
  } as Record<string, string>, stderr: "pipe" });
const call = async (name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.find((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")?.text;
  if (result.isError) {
    const detail = text ? JSON.parse(text).error : "no text";
    throw Error(`${name}: ${String(detail).split(/\r?\n/).filter(Boolean).at(-1)?.slice(0, 500)}`);
  }
  assert(text);
  return JSON.parse(text);
};
const readReceipt = async (step: string) => JSON.parse(await readFile(join(run, "receipts", `${step}.json`), "utf8"));
const readDesignPage = async (request: Record<string, unknown>, pageId: string) => {
  let offset = 0, body = "", identity: Record<string, string> | undefined;
  for (let pageNumber = 0; pageNumber < 30; pageNumber++) {
    const page = await call("call_editkin_tool", { name: "get_autopilot_design_brief", arguments: {
      projectPath, request, pageId, offset, maxTokens: 900 } });
    assert.equal(page.status, "GREEN");
    const current = { projectSha256: page.projectSha256, sourceSha256: page.sourceSha256,
      briefSha256: page.briefSha256, ...(page.recipeSha256 ? { recipeSha256: page.recipeSha256 } : {}) };
    if (identity) assert.deepEqual(current, identity);
    else identity = current;
    body += page.text;
    if (!page.hasMore) return { ...current, value: JSON.parse(body) };
    assert(page.nextOffset > offset);
    offset = page.nextOffset;
  }
  throw Error(`Design page did not finish: ${pageId}`);
};
try {
  await client.connect(transport);
  const next = await call("run_kit_workflow", { command: "next", run });
  assert.deepEqual(next.ready.map((item: { step: string }) => item.step), ["plan"]);
  const contract = await call("call_editkin_tool", { name: "get_autopilot_contract", arguments: {} });
  assert.equal(contract.status, "GREEN");
  const fixture = createAutopilotV4Fixture(contract.requiredPlanSource);
  const semantic = (await readReceipt("semantics_m01-clip-source")).facts;
  const route = (await readReceipt("route")).facts;
  const beats = [
    { id: "promise", role: "promise", startFrame: 0, endFrame: 40, energy: 0.45, summary: "合成測試影像", primaryFocus: "來源是合成圖樣" },
    { id: "setup", role: "setup", startFrame: 40, endFrame: 80, energy: 0.35, summary: "檢查色彩與節奏", primaryFocus: "觀察動態色塊" },
    { id: "payoff", role: "payoff", startFrame: 80, endFrame: 120, energy: 0.55, summary: "驗證可編輯輸出", primaryFocus: "保留測試來源" },
  ] as const;
  const request = { format: fixture.route.format, domain: fixture.route.domain,
    topic: "FFmpeg 合成測試圖樣的可編輯工程預覽", duration: 4,
    beats: beats.map(beat => ({ id: beat.id,
      role: beat.id === "promise" ? "first_frame" : beat.id === "payoff" ? "payoff" : "chapter",
      energy: beat.energy, subject: beat.primaryFocus })) };
  const context = await readDesignPage(request, "context");
  const recipes: Awaited<ReturnType<typeof readDesignPage>>[] = [];
  for (const beat of beats) recipes.push(await readDesignPage(request, `beat:${beat.id}`));
  for (const recipe of recipes) assert.equal(recipe.briefSha256, context.briefSha256);
  const family = recipes[0].value.route.primary_family;
  assert(recipes.every(recipe => recipe.value.route.primary_family === family));
  const aestheticResult = await call("call_editkin_tool", { name: "get_autopilot_aesthetic_system", arguments: {
    domain: fixture.route.domain, format: fixture.route.format, selectedFamily: family } });
  assert.equal(aestheticResult.status, "GREEN");
  const aesthetic = aestheticResult.aestheticSystem;
  assert.equal(aesthetic.primaryFamily, family);
  const commands: EditorCommand[] = [
    { type: "set_aesthetic_system", aestheticSystem: aesthetic },
    { type: "rename_project", name: "Kit synthetic editing receipt" },
    ...beats.map(beat => ({ type: "add_caption" as const, caption: {
      id: `kit-${beat.id}`, text: beat.summary, start: beat.startFrame / 30,
      duration: (beat.endFrame - beat.startFrame) / 30 } })),
  ];
  const motionTreatment = { schema: "editkin.motion-treatment/v1" as const,
    decisions: MOTION_TREATMENT_FAMILIES.map(treatment => {
      const indexes = commands.flatMap((command, index) => motionCommandFamilies(command).includes(treatment) ? [index] : []);
      return { family: treatment, action: indexes.length ? "use" as const : "omit" as const,
        reason: indexes.length ? "在合成測試片加入可編輯的畫面標記" : "合成測試片不需要這種效果",
        beatIds: indexes.length ? beats.map(beat => beat.id) : [], commandIndexes: indexes };
    }) };
  const planInput = { ...fixture,
    inference: { ...fixture.inference, provider: "other", modelId: "scripted-fixture-no-model", modelTier: "unknown",
      reasoningEffort: "unknown", priority: "quality",
      context: { ...fixture.inference.context, markdownRouterSha256: route.markdown_router_sha256 } },
    budget: { ...fixture.budget, selectedMemoryRuleIds: [], trimmedMemoryRuleCount: 0 },
    aesthetic,
    materialEvidence: { schema: fixture.materialEvidence.schema, receipts: [{
      materialId: semantic.material_id, sourceSha256: semantic.source_sha256,
      assetId: semantic.asset_id, clipId: semantic.clip_id,
      semanticReceiptSha256: semantic.semantic_receipt_sha256 }] },
    editorial: { ...fixture.editorial,
      brief: { audience: "工程驗收人員", premise: "只顯示 FFmpeg 生成的彩色測試圖樣",
        promise: "可重做的四秒合成片編輯", stakes: "驗證編輯命令與來源位元組沒有漂移",
        payoff: "輸出仍可對照原始測試片", firstFramePromise: "第一幀即顯示合成圖樣" },
      narrative: { backbone: "以同一段合成圖樣測試計畫、命令與輸出鏈",
        beats: beats.map(beat => ({ id: beat.id, role: beat.role, range: {
          startFrame: beat.startFrame, endFrame: beat.endFrame }, summary: beat.summary,
          energy: beat.energy, primaryFocus: beat.primaryFocus,
          evidenceRefs: [`material:${semantic.material_id}`] })),
        setupPayoffs: [{ setupBeatId: "setup", payoffBeatId: "payoff" }] },
      packaging: { ...fixture.editorial.packaging,
        hypotheses: [{ id: "engineering-preview", title: "合成測試片的編輯驗收",
          thumbnailPromise: "顯示合成圖樣", openingFulfillment: "第一幀顯示原始圖樣", distinctFromIds: [] }] },
      transitions: [{ id: "chapter-1", atFrame: 40, kind: "clean_cut", motivation: "continuity",
        evidenceRefs: [`material:${semantic.material_id}`] },
        { id: "chapter-2", atFrame: 80, kind: "clean_cut", motivation: "continuity",
          evidenceRefs: [`material:${semantic.material_id}`] }],
      audio: { ...fixture.editorial.audio, layers: [{ id: "silent-source", role: "production_sound",
        purpose: "來源無音軌；此工程片不加配樂或音效", evidenceRefs: ["source:no-audio-stream"] }],
        impactFrames: [], breathFrames: [] },
      motionTreatment },
    designEvidence: { schema: "editkin.autopilot-design-evidence/v1", request,
      projectSha256: context.projectSha256, sourceSha256: context.sourceSha256,
      briefSha256: context.briefSha256,
      decisions: beats.map((beat, index) => ({ beatId: beat.id, recipeSha256: recipes[index].recipeSha256,
        application: `用實際可編輯字幕說明第 ${index + 1} 段合成測試圖樣，保留來源畫面`, commandIndexes: [index + 2] })) },
    commands };
  const plan = parseAutopilotPlan(planInput);
  const planSha256 = autopilotPlanSha256(plan);
  const planPath = join(run, "plan.v4.json");
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  const claim = await call("run_kit_workflow", { command: "claim", run, step: "plan" });
  assert.equal(claim.instruction.tool, "write_v4_plan");
  await call("run_kit_workflow", { command: "complete", run, step: "plan", token: claim.claim_token,
    receiptTemplate: { artifact: planPath, plan_sha256: planSha256 } });
  const after = await call("run_kit_workflow", { command: "next", run });
  assert.deepEqual(after.ready.map((item: { step: string }) => item.step), ["audit"]);
  process.stdout.write(`${JSON.stringify({ status: "PASS", workspace: relative(artifacts, workspace),
    completedStep: "plan", nextStep: "audit", designFamily: family, aestheticFromPackagedTool: true,
    planSha256, commandCount: commands.length })}\n`);
} finally { await client.close(); }
