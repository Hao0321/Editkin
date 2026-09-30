// One bounded native OpenCode/Qwen attempt to author the original Kit's v4 plan.
// Usage: npx tsx scripts/review-opencode-kit-qwen-plan.ts --workspace <kit-bound-create-*> --portable <preview.exe>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { OpenCodeAcp } from "../src/service/openCodeAcp";
import { parseAutopilotPlan } from "../src/application/autopilotPlan";

const root = resolve(import.meta.dirname, "..");
const artifactRoot = realpathSync(resolve(root, "../artifacts/autopilot-desk"));
const arg = (key: string) => {
  const at = process.argv.indexOf(key);
  assert(at >= 0 && process.argv[at + 1], `Missing ${key}`);
  return realpathSync(resolve(process.argv[at + 1]));
};
const workspace = arg("--workspace");
const portable = arg("--portable");
const useSourceGateway = process.argv.includes("--source-gateway");
const focusDraft = process.argv.includes("--focus-draft");
const useSeed = process.argv.includes("--source-bound-seed");
const highLevelDraft = process.argv.includes("--high-level-draft");
const naturalIntent = process.argv.includes("--natural-intent");
const naturalFull = process.argv.includes("--natural-full");
const naturalCut = process.argv.includes("--natural-cut");
const resumeReport = process.argv.includes("--resume-report") ? arg("--resume-report") : null;
assert.equal(dirname(workspace).toLowerCase(), artifactRoot.toLowerCase());
assert.match(basename(workspace), /^kit-bound-create-[a-z0-9]+$/i);
assert.equal(basename(portable).toLowerCase(), "autopilotdesk-community-preview.exe");
const resources = join(dirname(portable), "resources");
const openCode = join(resources, "agent-runtime-v3/opencode.exe");
const gateway = useSourceGateway ? join(root, "src/mcp/agentGateway.ts") : join(resources, "runtime/agent-gateway.mjs");
const mcpTarget = join(resources, "runtime/mcp.mjs");
const packagedSkill = join(resources, "video-autopilot-kit/SKILL.md");
for (const path of [openCode, gateway, mcpTarget, packagedSkill]) assert(existsSync(path), `Missing packaged runtime: ${basename(path)}`);
const projectPath = join(workspace, "movie.editkin.json");
const run = join(workspace, "videos/_AUTOPILOT/editkin-v4/gateway-smoke");
const statePath = join(run, "workflow-state.json");
const sourcePath = join(workspace, "source.mp4");
const fixture = JSON.parse(await readFile(join(workspace, "review-report.json"), "utf8"));
assert.equal(fixture.status, "PASS");
assert.equal(fixture.semanticFixtureOnly, true);
const initial = JSON.parse(await readFile(statePath, "utf8"));
assert.equal(initial.steps.plan.status, "pending");
assert.equal(initial.steps.audit.status, "pending");
const existingDraft = existsSync(join(run, "plan.v4.json"));
const skill = realpathSync(initial.governance.skill_path);
assert.equal(basename(skill), "SKILL.md");
assert(relative(artifactRoot, skill).startsWith("portable-preview-"), "Pinned Kit source must be an artifact preview");
const skillSha256 = createHash("sha256").update(await readFile(skill)).digest("hex");
assert.equal(skillSha256, initial.governance.skill_sha256);
assert.equal(createHash("sha256").update(await readFile(packagedSkill)).digest("hex"), skillSha256);
const sourceSha256 = createHash("sha256").update(await readFile(sourcePath)).digest("hex");
const savedOriginPath = join(process.env.APPDATA || "", "studio.hao.autopilotdesk.communitypreview", "local-story", "origin.json");
const saved = JSON.parse(await readFile(savedOriginPath, "utf8"));
const origin = new URL(saved.origin);
assert.equal(origin.protocol, "http:");
assert(/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u.test(origin.hostname));
assert(origin.port && origin.pathname === "/");
const reportRoot = await mkdtemp(join(artifactRoot, "qwen-kit-plan-"));
const agentState = join(reportRoot, "agent-state");
await mkdir(agentState, { recursive: true });
const executable = (name: string) => execFileSync("where.exe", [name], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
const env = Object.entries({
  EDITKIN_AGENT_GATEWAY_TARGET: mcpTarget,
  EDITKIN_WORKSPACE: workspace,
  EDITKIN_AGENT_PROJECT_PATH: projectPath,
  EDITKIN_AGENT_STATE_ROOT: agentState,
  EDITKIN_VIDEO_AUTOPILOT_SKILL: skill,
  HAO_FFMPEG_PATH: executable("ffmpeg"),
  HAO_FFPROBE_PATH: executable("ffprobe"),
  EDITKIN_CACHE_ROOT: join(workspace, "cache"),
  EDITKIN_PLUGIN_ROOTS: join(root, "plugins"),
}).map(([name, value]) => ({ name, value }));
const agent = new OpenCodeAcp();
const report: Record<string, unknown> = { status: "BLOCK", model: "pny/qwen3.8-27b-nvfp4", fixtureOnly: true,
  run: relative(workspace, run).replaceAll("\\", "/"), reportRoot, planStepBefore: "pending", existingDraft,
  focusDraft, useSeed, highLevelDraft, naturalIntent, naturalFull, naturalCut, sourceGateway: useSourceGateway };
let previousCount = -1;
const startedAt = Date.now();
try {
  const started = await agent.start({ workspace, projectPath, opencodeExecutable: openCode,
    modelOrigin: origin.origin, mcp: { command: process.execPath,
      args: useSourceGateway ? [join(root, "node_modules/tsx/dist/cli.mjs"), gateway] : [gateway], env } });
  const selected = started.configOptions.find(option => option.id === "model")?.currentValue;
  assert.equal(selected, report.model);
  if (resumeReport) {
    const previous = JSON.parse(await readFile(resumeReport, "utf8"));
    assert.equal(previous.run, report.run);
    assert.equal(previous.model, report.model);
    assert(typeof previous.sessionId === "string" && previous.sessionId.startsWith("ses_"));
    await agent.loadSession(previous.sessionId, String(report.model));
    report.resumedSession = true;
  }
  const prompt = naturalCut
    ? `目前 Editkin 專案檔：${projectPath}。只用本 session 的 editkin MCP 讀取或修改此專案。已有原 Video Autopilot Kit run：${report.run}，素材證據步驟已完成。先呼叫 get_kit_plan_context(run) 讀來源與語意片段；這份隔離素材由紅、綠、藍三段構成。若要裁切，先確認片段邊界及影格證據，再呼叫 editkin_draft_kit_single_clip_plan，keepRanges 只能填與已審閱語意片段完全相同的保留區間。草稿有效後，使用者要求完成影片時呼叫 editkin_finish_kit_single_clip_edit，讓原 Kit 審核、套用、渲染，停止於真人審片。不要把 gateway 工具傳給 call_editkin_tool。回覆以繁體中文簡述實際成果。\n\n使用者：這段六秒的紅綠藍合成測試片，把中間綠色段剪掉，只留紅色和藍色；加一行可編輯字幕標明是合成測試圖樣，輸出給我看。`
    : naturalFull
    ? `目前 Editkin 專案檔：${projectPath}。只用本 session 的 editkin MCP 讀取或修改此專案，不用檔案工具直接改專案。已有原 Video Autopilot Kit run：${report.run}，八個素材證據步驟已完成。先呼叫 get_kit_plan_context(run) 取得已驗證的精簡索引；若只有一段 visual-only 素材且 savedDraft 為 MISSING，可呼叫 MCP 工具 editkin_draft_kit_single_clip_plan 讓 Editkin 組裝固定證據與設計欄位。savedDraft 為 VALID、使用者要求完成影片時，直接呼叫 editkin_finish_kit_single_clip_edit 依原 Kit 審計、套用並輸出，停止在真人審片；不要把 gateway 工具誤傳給 call_editkin_tool。字幕和節拍敘述必須有素材證據，索引不能替代實際畫面判讀。回覆以繁體中文簡述實際成果。\n\n使用者：把這段四秒的無聲合成測試畫面剪成讓人一眼看懂素材性質的簡短影片，標明它是合成測試圖樣，保留可編輯字幕，完成輸出讓我看片。`
    : naturalIntent
    ? `目前 Editkin 專案檔：${projectPath}。只用本 session 的 editkin MCP 讀取或修改此專案，不用檔案工具直接改專案。已有原 Video Autopilot Kit run：${report.run}，八個素材證據步驟已完成，現在只做 v4 起稿。先呼叫 get_kit_plan_context(run) 取得已驗證的精簡索引；若只有一段 visual-only 素材，可直接呼叫 MCP 工具 editkin_draft_kit_single_clip_plan 讓 Editkin 組裝固定證據與設計欄位，不要把它誤傳給 call_editkin_tool。字幕和節拍敘述必須有素材證據，索引不能替代實際畫面判讀。只寫可供檢查的草稿，不 claim、audit、apply 或 render。回覆以繁體中文簡述實際成果。\n\n使用者：把這段四秒的無聲合成測試畫面剪成讓人一眼看懂素材性質的簡短示範，請標明這是合成測試圖樣。先給我可編輯的剪輯草稿。`
    : highLevelDraft
    ? `在隔離 Editkin run ${report.run}，直接呼叫已提供的 MCP 工具 editkin_draft_kit_single_clip_plan 起草單片段 v4 計畫。不要呼叫 editkin_call_editkin_tool、editkin_discover_editkin_tools 或任何工具搜尋。參數：run=${report.run}；captionText=合成測試圖樣；topic=FFmpeg 合成測試圖樣的剪輯驗證；beatSummary=以可編輯字幕標明合成來源；subject=動態測試色塊；audience=剪輯台測試人員；format=shorts；domain=general。這是已知的 FFmpeg 合成測試影片，無音軌。工具會自己取得 Kit 證據與設計配方；不要展開 schema、搜尋檔案或自己寫 v4 JSON。工具回報 DRAFT_WRITTEN 後即可停止；不要 claim、audit、apply 或 render。若工具失敗，直接報告錯誤。`
    : useSeed
    ? `請在隔離 Editkin run ${report.run} 完成原 Kit 的 plan 步驟。先呼叫 get_kit_plan_context；其中 sourceBoundSeed 已從本 run 經 SHA 驗證的收據提供 source、materialEvidence、projectSummary、語意摘要和路由證據，請直接用這些欄位，不要重讀 workflow-state 或逐一掃收據。呼叫 planStructureTool 取得短版 v4 格式，向 Editkin 設計工具取得一個 0–120 幀 proof beat 的 design brief／recipe hash 和 aesthetic system。真正畫面命令用 add_caption，文字「合成測試圖樣」，開始 0 秒、長 4 秒，designEvidence 要指向該命令；其他效果若無證據就省略。實際執行你的模型是 Qwen 3.8 27B NVFP4，routeRecommendation 只是推薦，不得把它的 Codex 模型當成實際執行者。輸出完整 plan.v4.json，呼叫 planValidationTool 修到 GREEN_DRAFT_SCHEMA，然後依 Kit claim/complete 封存。來源是無音軌的 FFmpeg 測試片；不可虛構對白、人物或審片。只做 plan，停止於 audit 之前。`
    : focusDraft
    ? `延續同一個隔離 Kit run：${report.run}。前一回合已讀來源收據、route、設計配方與其 hash，但停在查 schema；現在停止搜尋檔案與列舉 schema，直接完成草稿。用 get_kit_plan_context 的 planStructureTool 所給結構範例作骨架，所有內容和 hash 必須換成本 run 的收據。只做一個 0–120 幀的 proof beat，實際可見動作請用 add_caption 命令標示「合成測試圖樣」，caption.start=0、duration=4，來源無音軌，不編造人物或對白。designEvidence.commandIndexes 指向 add_caption，不可指向 metadata；motionTreatment 依實際命令填寫。若缺具體 receipt 或 recipe hash，只讀那一筆，不再總覽 schema。把完整 JSON 寫到 Kit 指定的 plan.v4.json，呼叫 planValidationTool 修到 GREEN_DRAFT_SCHEMA，然後用原 Kit claim/complete 封存 plan。不要 audit、apply、render。若確實缺必要資料，明確指出。`
    : existingDraft
    ? `在目前隔離的 Editkin 測試專案中，接續原 Video Autopilot Kit run：${report.run}。八個素材證據步驟已完成，現在只做 plan。已有 plan.v4.json 草稿，但它沒有通過 Editkin 驗證。請先用 get_kit_plan_context(run) 的 planValidationTool 對 planPath 驗證，再根據錯誤修改草稿並重驗，直到 GREEN_DRAFT_SCHEMA。需有與素材證據相符的實際可見剪輯動作，designEvidence 的 commandIndexes 必須指向它；不得把 set_aesthetic_system 或空 patch 當成可見動作。再用原 Kit 的 run_kit_workflow claim/complete 封存 plan。這是 4 秒 FFmpeg 合成測試圖樣、無音軌；不要虛構人物、對白、模型判讀或真人審片。只在這個工作區處理。plan 完成就停下，絕不進入 audit、apply 或 render。若做不到，指出精確卡點。`
    : `在目前隔離的 Editkin 測試專案中，接續原 Video Autopilot Kit run：${report.run}。八個素材證據步驟已完成，現在只做 plan。先用 get_kit_plan_context(run) 取得本次證據索引，按原 Kit 規則讀必要素材語意與設計配方。這是 4 秒 FFmpeg 合成測試圖樣、無音軌；請設計一個讓觀看者知道這是合成測試圖樣的簡潔可見編輯，寫成來源綁定的 v4 plan.v4.json。不要虛構人物、對白、真人審片或模型判讀；不要用空 patch、與原值相同的設定或純 metadata 充當編輯。呼叫 planValidationTool 驗證並修正到 GREEN_DRAFT_SCHEMA，再透過原 Kit claim/complete 封存 plan。只在本工作區處理；完成 plan 就停下，不進入 audit、apply、render。若做不到，指出精確卡點。`;
  const beforeTurnSeq = agent.status(0).seq;
  agent.prompt(`${prompt} 範例只供格式參考，所有內容與雜湊必須改用本 run 的證據；需要時才依 planSchemaLookup 精查單一欄位。編輯命令只查你決定實際採用的種類，不必列舉全部 alternatives；不要用 glob、grep 或其他檔案工具搜尋工作區外的程式碼或範例；若缺資料，明確回報。`,
    projectPath, "接續隔離 Kit 測試 run，產生 v4 計畫；完成後停止");
  const draftOnly = highLevelDraft || naturalIntent;
  const deadline = Date.now() + (draftOnly ? 180_000 : naturalFull || naturalCut ? 240_000 : 480_000);
  let turn = false;
  let permission = false;
  while (Date.now() < deadline) {
    const snapshot = agent.status(0);
    const tools = snapshot.events.filter(event => event.kind === "tool");
    if (tools.length !== previousCount && Date.now() - startedAt > 5000) {
      previousCount = tools.length;
      process.stdout.write(`${JSON.stringify({ stage: "agent", elapsedSec: Math.round((Date.now() - startedAt) / 1000),
        toolEvents: tools.length, lastTool: tools.at(-1)?.text?.slice(0, 60), busy: snapshot.busy })}\n`);
    }
    if (snapshot.pendingPermissionIds.length) { permission = true; break; }
    if (snapshot.events.some(event => event.kind === "turn" && event.seq > beforeTurnSeq) && !snapshot.busy) { turn = true; break; }
    await new Promise(done => setTimeout(done, 1000));
  }
  const snapshot = agent.status(0);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const planPath = join(run, "plan.v4.json");
  report.turnCompleted = turn;
  report.turnStatus = snapshot.events.filter(event => event.kind === "turn" && event.seq > beforeTurnSeq).at(-1)?.status ?? null;
  report.permissionPending = permission;
  report.elapsedMs = Date.now() - startedAt;
  report.planStepAfter = state.steps.plan.status;
  report.auditStepAfter = state.steps.audit.status;
  report.applyStepAfter = state.steps.apply.status;
  report.renderStepAfter = state.steps.render.status;
  report.renderFileExists = existsSync(join(run, "render/current.mp4"));
  report.planFileExists = existsSync(planPath);
  let currentParserAccepted = false;
  let cutCommandPresent = false;
  if (report.planFileExists) {
    try {
      const plan = parseAutopilotPlan(JSON.parse(await readFile(planPath, "utf8")));
      currentParserAccepted = true;
      cutCommandPresent = plan.commands.some(command => command.type === "smart_cut_clip"
        && command.keepRanges.length === 2 && command.keepRanges[0].start === 0 && command.keepRanges[0].end === 2
        && command.keepRanges[1].start === 4 && command.keepRanges[1].end === 6);
    }
    catch (error) { report.planValidationError = String(error instanceof Error ? error.message : error).slice(0, 300); }
  }
  report.currentParserAccepted = currentParserAccepted;
  report.cutCommandPresent = cutCommandPresent;
  report.toolTitles = snapshot.events.filter(event => event.seq > beforeTurnSeq && event.kind === "tool").map(event => event.text).slice(-80);
  report.lastMessages = snapshot.events.filter(event => event.seq > beforeTurnSeq && event.kind === "message").map(event => event.text?.slice(0, 800)).slice(-4);
  report.errorCount = snapshot.events.filter(event => event.kind === "error").length;
  report.sessionId = snapshot.sessionId;
  const isInside = (base: string, path: string) => {
    const rel = relative(base, resolve(path));
    return rel === "" || rel !== ".." && !rel.startsWith("..\\") && !rel.startsWith("../");
  };
  report.permissionRequests = snapshot.events.filter(event => event.kind === "permission" && event.requestId !== undefined
      && snapshot.pendingPermissionIds.includes(event.requestId))
    .map(event => ({ toolName: event.toolName, toolKind: event.toolKind,
      optionKinds: event.options?.map(option => option.kind) || [],
      pathsInsideFixture: event.locations?.map(location => isInside(workspace, location.path)) || [],
      pathsInsideRepository: event.locations?.map(location => isInside(root, location.path)) || [],
      pathsInsidePackagedKit: event.locations?.map(location => isInside(dirname(skill), location.path)) || [],
      actionKind: /\b(glob|grep|read|write|edit)\b/i.exec(String(event.text || ""))?.[1]?.toLowerCase() || "other" })).slice(-3);
  report.sourceUnchanged = createHash("sha256").update(await readFile(sourcePath)).digest("hex") === sourceSha256;
  const expectedPlanStep = draftOnly ? "pending" : "completed";
  const startedWithoutDraft = !draftOnly || !existingDraft;
  const expectedExecution = naturalFull || naturalCut ? state.steps.audit.status === "completed" && state.steps.apply.status === "completed"
    && state.steps.render.status === "completed" && report.renderFileExists === true
    : state.steps.audit.status === "pending" && state.steps.apply.status === "pending" && state.steps.render.status === "pending";
  report.status = startedWithoutDraft && state.steps.plan.status === expectedPlanStep && expectedExecution
    && report.planFileExists === true && currentParserAccepted && (!naturalCut || cutCommandPresent)
    && report.sourceUnchanged === true && !permission ? "PASS" : "BLOCK";
  if (!turn && !permission) report.reason = `Bounded ${draftOnly ? "three" : naturalFull || naturalCut ? "four" : "eight"}-minute turn elapsed; inspect run before retrying`;
  if (permission) report.reason = "OpenCode requested permission; no automatic approval was given";
} catch (error) {
  report.error = String(error instanceof Error ? error.message : error).replaceAll(origin.origin, "<private-model-origin>").slice(0, 700);
} finally {
  agent.close();
  await writeFile(join(reportRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: report.status, reportRoot, elapsedMs: report.elapsedMs,
    planStepAfter: report.planStepAfter, permissionPending: report.permissionPending, error: report.error })}\n`);
}
if (report.status !== "PASS") process.exitCode = 1;
