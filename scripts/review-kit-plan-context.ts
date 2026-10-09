// Check the compact Kit plan index and optional draft/plan transitions against an isolated packaged-run fixture.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { autopilotPlanSha256, parseAutopilotPlan } from "../src/application/autopilotPlan";

const root = resolve(import.meta.dirname, "..");
const artifacts = realpathSync(resolve(root, "../artifacts/autopilot-desk"));
const value = (flag: string) => { const at = process.argv.indexOf(flag); assert(at >= 0 && process.argv[at + 1]); return realpathSync(process.argv[at + 1]); };
const workspace = value("--workspace"), portable = process.argv.includes("--portable") ? value("--portable") : undefined;
const packagedGateway = process.argv.includes("--packaged-gateway");
if (packagedGateway && !portable) throw Error("Packaged gateway requires a portable preview");
const draftCut = process.argv.includes("--draft-cut");
assert.equal(dirname(workspace).toLowerCase(), artifacts.toLowerCase());
assert.match(basename(workspace), /^kit-bound-create-[a-z0-9]+$/i);
const resources = portable ? join(dirname(portable), "resources") : undefined;
const run = "videos/_AUTOPILOT/editkin-v4/gateway-smoke";
const state = JSON.parse(await readFile(join(workspace, run, "workflow-state.json"), "utf8"));
const pinnedSkill = realpathSync(state.governance.skill_path);
assert.equal(createHash("sha256").update(await readFile(pinnedSkill)).digest("hex"), state.governance.skill_sha256);
const executable = (name: string) => execFileSync("where.exe", [name], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
const client = new Client({ name: "editkin-plan-context-review", version: "1" });
const transport = new StdioClientTransport({ command: process.execPath,
  args: packagedGateway ? [join(resources!, "runtime/agent-gateway.mjs")] : [join(root, "node_modules/tsx/dist/cli.mjs"), join(root, "src/mcp/agentGateway.ts")], cwd: root,
  env: { ...process.env, EDITKIN_AGENT_GATEWAY_TARGET: portable ? join(resources!, "runtime/mcp.mjs") : join(root, "community-desktop-dist/mcp.mjs"), EDITKIN_WORKSPACE: workspace,
    EDITKIN_AGENT_PROJECT_PATH: join(workspace, "movie.editkin.json"), EDITKIN_VIDEO_AUTOPILOT_SKILL: pinnedSkill,
    HAO_FFMPEG_PATH: executable("ffmpeg"), HAO_FFPROBE_PATH: executable("ffprobe"), EDITKIN_CACHE_ROOT: join(workspace, "cache"),
    EDITKIN_PLUGIN_ROOTS: join(root, "plugins") } as Record<string, string>, stderr: "pipe" });
try {
  await client.connect(transport);
  const response = await client.callTool({ name: "get_kit_plan_context", arguments: { run } });
  assert.notEqual(response.isError, true);
  const item = response.content.find((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string");
  assert(item);
  const packet = JSON.parse(item.text);
  assert.equal(packet.run, run);
  assert.equal(packet.planStep, state.steps.plan.status);
  const expectedReady = ["plan", "audit", "apply", "render", "human-review"]
    .find(step => state.steps[step]?.status === "pending");
  assert(expectedReady);
  assert.deepEqual(packet.ready, [expectedReady]);
  assert.equal(packet.bindingSha256, state.binding.binding_sha256);
  assert.equal(packet.materials.length, 1);
  assert.equal(packet.materials[0].semanticReceiptSha256,
    JSON.parse(await readFile(join(workspace, run, "receipts/semantics_m01-clip-source.json"), "utf8")).facts.semantic_receipt_sha256);
  assert.equal(packet.requiredPlanSource.skillSha256, state.binding.skill_sha256);
  assert.equal(packet.planSchemaLookup.path, "/properties/plan/anyOf/0");
  assert.equal(packet.planStructureTool.name, "get_autopilot_plan_structure");
  assert.equal(packet.planValidationTool.name, "validate_autopilot_plan_draft");
  assert.equal(packet.planDraftTool.gateway, "draft_kit_single_clip_plan");
  assert.equal(packet.planDraftTool.openCodeName, "editkin_draft_kit_single_clip_plan");
  assert.equal(packet.planDraftTool.finishOpenCodeName, "editkin_finish_kit_single_clip_edit");
  assert.equal(packet.savedDraft.status === "MISSING", !existsSync(join(workspace, run, "plan.v4.json")));
  assert.equal(packet.sourceBoundSeed.status, "EVIDENCE_ONLY");
  assert.deepEqual(packet.sourceBoundSeed.source, packet.requiredPlanSource);
  assert.equal(packet.sourceBoundSeed.materialEvidence.receipts[0].semanticReceiptSha256, packet.materials[0].semanticReceiptSha256);
  assert.match(packet.sourceBoundSeed.submittedSemanticOutlines[0].overallTopic, /test pattern/i);
  assert.equal(packet.sourceBoundSeed.projectSummary.clipCount, 1);
  assert.equal(packet.sourceBoundSeed.routerSha256?.length, 64);
  assert.equal(packet.authoringCalls.designBrief.name, "get_autopilot_design_brief");
  assert.equal(packet.authoringCalls.aesthetic.name, "get_autopilot_aesthetic_system");
  assert.equal(packet.authoringCalls.factualCaptionCommandShape.type, "add_caption");
  assert(Buffer.byteLength(item.text) < 9_000);
  if (process.argv.includes("--draft-single-clip") || draftCut) {
    const sourceHashBefore = createHash("sha256").update(await readFile(join(workspace, "source.mp4"))).digest("hex");
    const draftCall = await client.callTool({ name: "draft_kit_single_clip_plan", arguments: {
      run, captionText: "合成測試圖樣", topic: "FFmpeg 合成測試圖樣的剪輯驗證",
      beatSummary: "以可編輯字幕標明合成來源", subject: "動態測試色塊", audience: "剪輯台測試人員",
      format: "shorts", domain: "general",
      ...(draftCut ? { keepRanges: [{ start: 0, end: 2 }, { start: 4, end: 6 }] } : {}) } });
    const draftText = draftCall.content.find((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string");
    if (draftCall.isError) throw Error(`Single clip draft failed: ${draftText?.text?.slice(0, 850)}`);
    assert(draftText && JSON.parse(draftText.text).status === "DRAFT_WRITTEN");
    const plan = parseAutopilotPlan(JSON.parse(await readFile(join(workspace, run, "plan.v4.json"), "utf8")));
    assert.equal(plan.schema, "hao.video-autopilot.edit-plan/v4");
    assert(plan.commands.some(command => command.type === "add_caption" && command.caption.text === "合成測試圖樣"));
    if (draftCut) {
      const cut = plan.commands.find(command => command.type === "smart_cut_clip");
      assert(cut && cut.keepRanges.length === 2);
      assert.equal(plan.editorial.narrative.beats.at(-1)?.range.endFrame, 120);
    }
    assert.equal(plan.materialEvidence.receipts[0].semanticReceiptSha256, packet.materials[0].semanticReceiptSha256);
    assert.equal(createHash("sha256").update(await readFile(join(workspace, "source.mp4"))).digest("hex"), sourceHashBefore);
    const after = JSON.parse(await readFile(join(workspace, run, "workflow-state.json"), "utf8"));
    assert.equal(after.steps.plan.status, "pending");
  }
  if (process.argv.includes("--reject-duplicate-draft")) {
    const planPath = join(workspace, run, "plan.v4.json");
    const before = createHash("sha256").update(await readFile(planPath)).digest("hex");
    const duplicate = await client.callTool({ name: "draft_kit_single_clip_plan", arguments: {
      run, captionText: "不應覆蓋", topic: "隔離合成來源的重複起稿檢查",
      beatSummary: "保護已經存在的草稿", subject: "動態測試色塊", audience: "剪輯台測試人員" } });
    assert.equal(duplicate.isError, true);
    assert.equal(createHash("sha256").update(await readFile(planPath)).digest("hex"), before);
    const after = JSON.parse(await readFile(join(workspace, run, "workflow-state.json"), "utf8"));
    assert.equal(after.steps.plan.status, "pending");
  }
  if (process.argv.includes("--finish-single-clip")) {
    const sourceHashBefore = createHash("sha256").update(await readFile(join(workspace, "source.mp4"))).digest("hex");
    const plan = parseAutopilotPlan(JSON.parse(await readFile(join(workspace, run, "plan.v4.json"), "utf8")));
    const finished = await client.callTool({ name: "finish_kit_single_clip_edit", arguments: { run } });
    const finishedText = finished.content.find((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string");
    if (finished.isError) throw Error(`Single clip finish failed: ${finishedText?.text?.slice(0, 900)}`);
    assert(finishedText);
    const result = JSON.parse(finishedText.text);
    assert.equal(result.status, "RENDERED_AWAITING_HUMAN_REVIEW");
    assert.equal(result.nextStep, "human-review");
    const after = JSON.parse(await readFile(join(workspace, run, "workflow-state.json"), "utf8"));
    for (const step of ["plan", "audit", "apply", "render"]) assert.equal(after.steps[step].status, "completed");
    const project = JSON.parse(await readFile(join(workspace, "movie.editkin.json"), "utf8"));
    assert(plan.commands.some(command => command.type === "add_caption"
      && project.captions.some((caption: { text: string }) => caption.text === command.caption.text)));
    const output = realpathSync(join(workspace, result.outputPath));
    const outputRelative = relative(workspace, output);
    assert(outputRelative && !outputRelative.startsWith("..") && !outputRelative.includes(":"));
    const probe = JSON.parse(execFileSync(executable("ffprobe"), ["-v", "error", "-show_entries", "format=duration,size", "-of", "json", output], { encoding: "utf8" }));
    assert(Number(probe.format.duration) > 3.8 && Number(probe.format.duration) < 4.2);
    if (draftCut) {
      assert.equal(project.tracks.flatMap((track: { clips: unknown[] }) => track.clips).length, 2);
      const centerPixel = (at: number) => {
        const pixels = execFileSync(executable("ffmpeg"), ["-v", "error", "-ss", String(at), "-i", output,
          "-frames:v", "1", "-vf", "crop=2:2:(iw-2)/2:(ih-2)/2", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
          { timeout: 60_000, maxBuffer: 4096 });
        return [pixels[0], pixels[1], pixels[2]];
      };
      const first = centerPixel(0.5), last = centerPixel(2.5);
      assert(first[0] > first[1] * 1.5 && first[0] > first[2] * 1.5, `First kept frame is not red: ${first}`);
      assert(last[2] > last[0] * 1.5 && last[2] > last[1] * 1.5, `Last kept frame is not blue: ${last}`);
    }
    execFileSync(executable("ffmpeg"), ["-v", "error", "-i", output, "-f", "null", "-"], { timeout: 60_000, stdio: "ignore" });
    assert.equal(createHash("sha256").update(await readFile(join(workspace, "source.mp4"))).digest("hex"), sourceHashBefore);
  }
  if (process.argv.includes("--reject-repeat-finish")) {
    const projectPath = join(workspace, "movie.editkin.json");
    const outputPath = join(workspace, run, "render/current.mp4");
    const projectBefore = createHash("sha256").update(await readFile(projectPath)).digest("hex");
    const outputBefore = createHash("sha256").update(await readFile(outputPath)).digest("hex");
    const repeated = await client.callTool({ name: "finish_kit_single_clip_edit", arguments: { run } });
    assert.equal(repeated.isError, true, "A completed Kit run must refuse a second apply/render");
    assert.equal(createHash("sha256").update(await readFile(projectPath)).digest("hex"), projectBefore);
    assert.equal(createHash("sha256").update(await readFile(outputPath)).digest("hex"), outputBefore);
  }
  if (process.argv.includes("--complete-existing-draft")) {
    const planPath = join(workspace, run, "plan.v4.json");
    const plan = parseAutopilotPlan(JSON.parse(await readFile(planPath, "utf8")));
    const claim = await client.callTool({ name: "run_kit_workflow", arguments: { command: "claim", run, step: "plan" } });
    assert.notEqual(claim.isError, true);
    const token = JSON.parse(String(claim.content.find((part) => part.type === "text")?.text)).claim_token;
    assert(typeof token === "string");
    const completed = await client.callTool({ name: "run_kit_workflow", arguments: { command: "complete", run,
      step: "plan", token, receiptTemplate: { artifact: planPath, plan_sha256: autopilotPlanSha256(plan) } } });
    const completedText = completed.content.find((part) => part.type === "text")?.text;
    if (completed.isError) throw Error(`Kit plan completion failed: ${String(completedText).slice(0, 850)}`);
    const after = JSON.parse(await readFile(join(workspace, run, "workflow-state.json"), "utf8"));
    assert.equal(after.steps.plan.status, "completed");
    assert.equal(after.steps.audit.status, "pending");
  }
  const outside = await client.callTool({ name: "get_kit_plan_context", arguments: { run: "../outside-run" } });
  assert.equal(outside.isError, true, "run lookup outside the bound workflow must fail");
  let planSchemaOutline: unknown;
  let planStructureBytes: number | undefined;
  let draftValidation: string | undefined;
  if (process.argv.includes("--inspect-plan-structure")) {
    const sampleCall = await client.callTool({ name: "call_editkin_tool", arguments: {
      name: packet.planStructureTool.name, arguments: packet.planStructureTool.arguments } });
    assert.notEqual(sampleCall.isError, true);
    const sampleText = sampleCall.content.find((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string");
    assert(sampleText);
    const sample = JSON.parse(sampleText.text);
    assert.equal(sample.status, "EXAMPLE_ONLY");
    assert.equal(sample.example.schema, packet.planSchema);
    assert.notEqual(sample.example.source.skillSha256, packet.requiredPlanSource.skillSha256);
    assert(sample.addFromCurrentDesignBrief.includes("designEvidence"));
    planStructureBytes = Buffer.byteLength(sampleText.text);
    assert(planStructureBytes < 16_000);
    if (process.argv.includes("--validate-draft")) {
      const valid = await client.callTool({ name: "call_editkin_tool", arguments: {
        name: "validate_autopilot_plan_draft", arguments: { plan: sample.example } } });
      if (valid.isError) throw Error(`Structural example validation failed: ${String(valid.content.find((part) => part.type === "text")?.text || "").slice(0, 500)}`);
      const validText = valid.content.find((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string");
      if (!validText) throw Error(`Structural validation gave no text: ${JSON.stringify(valid).slice(0, 900)}`);
      assert.equal(JSON.parse(validText.text).status, "GREEN_DRAFT_SCHEMA");
      const blocked = await client.callTool({ name: "call_editkin_tool", arguments: {
        name: "validate_autopilot_plan_draft", arguments: packet.planValidationTool.arguments } });
      assert.equal(blocked.isError, true);
      const blockedText = blocked.content.find((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string");
      if (!blockedText) throw Error(`Draft rejection gave no text: ${JSON.stringify(blocked).slice(0, 900)}`);
      const draftError = String(JSON.parse(blockedText.text).error);
      assert(/empty patch|Design beat .*actual visual\/audio commands/u.test(draftError), draftError);
      if (state.steps.plan.status === "completed" && draftError.includes("empty patch")) {
        const refused = await client.callTool({ name: "run_kit_workflow", arguments: {
          command: "complete", run, step: "plan", token: "review-invalid-token",
          receipt: `${run}/receipts/plan.json` } });
        assert.equal(refused.isError, true, "Kit bridge must reject an empty edit before calling the controller");
        assert(String(refused.content.find((part) => part.type === "text")?.text).includes("empty patch"));
      }
      draftValidation = `valid example accepted; saved draft rejected (${draftError.includes("empty patch") ? "empty patch" : "metadata-only"})`;
    }
  }
  if (process.argv.includes("--inspect-plan-schema")) {
    const schemaCall = await client.callTool({ name: "inspect_editkin_tool", arguments: {
      name: "audit_autopilot_plan", path: "/properties/plan", limit: 8 } });
    assert.notEqual(schemaCall.isError, true);
    const schemaText = schemaCall.content.find((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string");
    assert(schemaText);
    const schema = JSON.parse(schemaText.text);
    const currentCall = await client.callTool({ name: "inspect_editkin_tool", arguments: {
      name: "audit_autopilot_plan", path: "/properties/plan/anyOf/0", limit: 12 } });
    assert.notEqual(currentCall.isError, true);
    const currentText = currentCall.content.find((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string");
    assert(currentText);
    const current = JSON.parse(currentText.text);
    const schemaFieldCall = await client.callTool({ name: "inspect_editkin_tool", arguments: {
      name: "audit_autopilot_plan", path: `${packet.planSchemaLookup.path}/properties/schema` } });
    assert.notEqual(schemaFieldCall.isError, true);
    const schemaFieldText = schemaFieldCall.content.find((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string");
    assert(schemaFieldText);
    const schemaField = JSON.parse(schemaFieldText.text);
    assert.equal(schemaField.inputSchema.const, "hao.video-autopilot.edit-plan/v4");
    planSchemaOutline = { bytes: schema.schemaBytes, keys: schema.children?.map((child: { key: string }) => child.key),
      currentBytes: current.schemaBytes, currentKeys: current.children?.map((child: { key: string }) => child.key),
      directKeys: Object.keys(current.inputSchema || {}) };
  }
  process.stdout.write(`${JSON.stringify({ status: "PASS", workspace: relative(artifacts, workspace), packagedGateway, planStep: packet.planStep,
    materialCount: packet.materials.length, packetBytes: Buffer.byteLength(item.text), planStructureBytes, draftValidation, planSchemaOutline })}\n`);
} finally { await client.close(); }
