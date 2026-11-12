// Resume the same isolated synthetic run through the original Kit's audit/apply/render gates.
// Usage: npx tsx scripts/review-kit-execute-gateway.ts --workspace <kit-bound-create-*> --portable <preview.exe>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = resolve(import.meta.dirname, "..");
const artifacts = realpathSync(resolve(root, "../artifacts/autopilot-desk"));
const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  assert(index >= 0 && process.argv[index + 1], `Missing ${name}`);
  return realpathSync(resolve(process.argv[index + 1]));
};
const workspace = argument("--workspace");
const portable = argument("--portable");
assert.equal(dirname(workspace).toLowerCase(), artifacts.toLowerCase());
assert.match(basename(workspace), /^kit-bound-create-[a-z0-9]+$/i);
assert.equal(basename(portable).toLowerCase(), "autopilotdesk-community-preview.exe");
const resources = join(dirname(portable), "resources");
const projectPath = join(workspace, "movie.editkin.json");
const sourcePath = join(workspace, "source.mp4");
const run = join(workspace, "videos/_AUTOPILOT/editkin-v4/gateway-smoke");
assert(statSync(projectPath).isFile() && statSync(sourcePath).isFile());
const fixture = JSON.parse(await readFile(join(workspace, "review-report.json"), "utf8"));
assert.equal(fixture.status, "PASS");
assert.equal(fixture.semanticFixtureOnly, true);
const state = JSON.parse(await readFile(join(run, "workflow-state.json"), "utf8"));
const pinnedSkill = realpathSync(state.governance.skill_path);
assert.equal(createHash("sha256").update(await readFile(pinnedSkill)).digest("hex"), state.governance.skill_sha256);
const sourceSha256 = createHash("sha256").update(await readFile(sourcePath)).digest("hex");
const executableOnPath = (name: string) => execFileSync("where.exe", [name], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
const client = new Client({ name: "editkin-kit-execute-review", version: "1" });
const transport = new StdioClientTransport({ command: process.execPath, args: [join(resources, "runtime/agent-gateway.mjs")], cwd: root,
  env: { ...process.env, EDITKIN_AGENT_GATEWAY_TARGET: join(resources, "runtime/mcp.mjs"),
    EDITKIN_WORKSPACE: workspace, EDITKIN_AGENT_PROJECT_PATH: projectPath,
    EDITKIN_VIDEO_AUTOPILOT_SKILL: pinnedSkill,
    HAO_FFMPEG_PATH: executableOnPath("ffmpeg"), HAO_FFPROBE_PATH: executableOnPath("ffprobe"),
    EDITKIN_CACHE_ROOT: join(workspace, "cache"), EDITKIN_PLUGIN_ROOTS: join(root, "plugins"),
  } as Record<string, string>, stderr: "pipe" });
const parse = (result: Awaited<ReturnType<typeof client.callTool>>, tool: string) => {
  const entries = result.content.filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string");
  assert(entries.length);
  let value: Record<string, any>;
  try { value = JSON.parse(entries[0].text); }
  catch { throw Error(`${tool}: ${entries[0].text.split(/\r?\n/).filter(Boolean).at(-1)?.slice(0, 500)}`); }
  if (result.isError) throw Error(`${tool}: ${String(value.error ?? entries[0].text).split(/\r?\n/).filter(Boolean).at(-1)?.slice(0, 500)}`);
  return { value, reference: entries.length > 1 ? JSON.parse(entries.at(-1)!.text) : undefined };
};
const workflow = async (args: Record<string, unknown>) => parse(await client.callTool({ name: "run_kit_workflow", arguments: { run, ...args } }), "run_kit_workflow").value;
const advance = async (step: string, expectedTool: string, nextStep: string) => {
  const ready = await workflow({ command: "next" });
  assert.deepEqual(ready.ready.map((item: { step: string }) => item.step), [step]);
  const claim = await workflow({ command: "claim", step });
  assert.equal(claim.instruction?.tool, expectedTool);
  const executed = parse(await client.callTool({ name: "call_editkin_tool", arguments: {
    name: expectedTool, arguments: claim.instruction.request, retainResult: true, run,
    ...(step === "apply" || step === "render" ? { claimToken: claim.claim_token } : {}),
  } }), expectedTool);
  assert(executed.reference?.resultRef, `No retained ${step} result`);
  if (step === "apply" || step === "render") {
    await writeFile(join(workspace, `review-${step}-tool-result.json`), `${JSON.stringify(executed.value, null, 2)}\n`);
  }
  await workflow({ command: "complete", step, token: claim.claim_token,
    receiptTemplate: { $resultRef: executed.reference.resultRef } });
  const after = await workflow({ command: "next" });
  assert.deepEqual(after.ready.map((item: { step: string }) => item.step), [nextStep]);
  return executed.value;
};
const verifyFinalRender = async (rendered: Record<string, any>) => {
  assert.equal(rendered.status, "GREEN");
  const project = JSON.parse(await readFile(projectPath, "utf8"));
  assert(Array.isArray(project.captions) && project.captions.length > 0);
  const plan = JSON.parse(await readFile(join(run, "plan.v4.json"), "utf8"));
  const expectedCaptions = plan.commands.filter((command: any) => command.type === "add_caption").map((command: any) => command.caption.text);
  for (const expected of expectedCaptions) assert(project.captions.some((caption: any) => caption.text === expected));
  const output = realpathSync(rendered.outputPath);
  const outputRelative = relative(workspace, output);
  assert(outputRelative && !outputRelative.startsWith("..") && !outputRelative.includes(":"));
  const probe = JSON.parse(execFileSync(executableOnPath("ffprobe"), ["-v", "error", "-show_entries",
    "format=duration,size:stream=codec_name,codec_type,width,height", "-of", "json", output], { encoding: "utf8" }));
  assert(probe.streams.some((stream: { codec_type: string }) => stream.codec_type === "video"));
  assert(Number(probe.format.duration) > 3.8 && Number(probe.format.duration) < 4.2);
  execFileSync(executableOnPath("ffmpeg"), ["-v", "error", "-i", output, "-f", "null", "-"],
    { timeout: 60_000, stdio: "ignore" });
  assert.equal(createHash("sha256").update(await readFile(sourcePath)).digest("hex"), sourceSha256);
  const next = await workflow({ command: "next" });
  assert.deepEqual(next.ready.map((item: { step: string }) => item.step), ["human-review"]);
  const report = { status: "PASS", syntheticFixtureOnly: true, sourceUnchanged: true, editableCaptions: project.captions.length,
    output: outputRelative, outputSha256: createHash("sha256").update(await readFile(output)).digest("hex"),
    duration: Number(probe.format.duration), videoDecoded: true, nextStep: "human-review" };
  await writeFile(join(workspace, "kit-through-render-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ status: report.status, workspace: relative(artifacts, workspace),
    output: report.output, duration: report.duration, videoDecoded: report.videoDecoded, nextStep: report.nextStep })}\n`);
};
try {
  await client.connect(transport);
  if (process.argv.includes("--through-render")) {
    const audit = await advance("audit", "audit_autopilot_plan", "apply");
    assert.equal(audit.status, "ACCEPTED");
    const applied = await advance("apply", "apply_autopilot_plan", "render");
    assert.equal(applied.status, "REVIEW_REQUIRED");
    assert.equal(createHash("sha256").update(await readFile(sourcePath)).digest("hex"), sourceSha256);
    const rendered = await advance("render", "render_project", "human-review");
    await verifyFinalRender(rendered);
  } else if (process.argv.includes("--from-apply-through-render")) {
    const applied = await advance("apply", "apply_autopilot_plan", "render");
    assert.equal(applied.status, "REVIEW_REQUIRED");
    assert.equal(createHash("sha256").update(await readFile(sourcePath)).digest("hex"), sourceSha256);
    const rendered = await advance("render", "render_project", "human-review");
    await verifyFinalRender(rendered);
  } else if (process.argv.includes("--audit-only")) {
    const audit = await advance("audit", "audit_autopilot_plan", "apply");
    assert.equal(audit.status, "ACCEPTED");
    assert.equal(createHash("sha256").update(await readFile(sourcePath)).digest("hex"), sourceSha256);
    process.stdout.write(`${JSON.stringify({ status: "PASS", workspace: relative(artifacts, workspace), audit: "ACCEPTED", nextStep: "apply", sourceUnchanged: true })}\n`);
  } else if (process.argv.includes("--qc-only")) {
    await verifyFinalRender(JSON.parse(await readFile(join(workspace, "review-render-tool-result.json"), "utf8")));
  } else if (process.argv.includes("--qc-from-state")) {
    const finalState = JSON.parse(await readFile(join(run, "workflow-state.json"), "utf8"));
    for (const step of ["plan", "audit", "apply", "render"]) assert.equal(finalState.steps[step].status, "completed");
    const outputPath = join(workspace, finalState.binding.output_path);
    await verifyFinalRender({ status: "GREEN", outputPath });
  } else throw Error("Pass --audit-only, --through-render, --from-apply-through-render, --qc-only or --qc-from-state");
} finally { await client.close(); }
