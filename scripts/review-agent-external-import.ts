// Isolated acceptance: a bundled Agent edits the open project while its original source is outside the project folder.
// Usage: npx tsx scripts/review-agent-external-import.ts --portable <preview.exe>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createDemoProject } from "../src/domain/demo";

const root = resolve(import.meta.dirname, "..");
const previewIndex = process.argv.indexOf("--portable");
assert(previewIndex >= 0 && process.argv[previewIndex + 1], "Provide --portable <preview.exe>");
const preview = resolve(process.argv[previewIndex + 1]);
assert.equal(basename(preview).toLowerCase(), "autopilotdesk-community-preview.exe");
const resources = join(dirname(preview), "resources", "runtime");
const artifactRoot = resolve(root, "../artifacts/autopilot-desk");
await mkdir(artifactRoot, { recursive: true });
const fixture = await mkdtemp(join(artifactRoot, "agent-external-import-"));
const workspace = join(fixture, "project");
const media = join(fixture, "imported-media");
await mkdir(workspace);
await mkdir(media);
const source = join(media, "original.mp4");
const otherSource = join(media, "unapproved.mp4");
const ffmpeg = execFileSync("where.exe", ["ffmpeg"], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30:duration=2",
  "-vf", "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv",
  "-c:v", "libx264", "-preset", "ultrafast", "-crf", "32", "-color_primaries", "bt709", "-color_trc", "bt709",
  "-colorspace", "bt709", "-an", "-y", source], { timeout: 60_000, stdio: "ignore" });
await writeFile(otherSource, "unapproved fixture");
const sourceHash = createHash("sha256").update(await readFile(source)).digest("hex");
const projectPath = join(workspace, "external.editkin.json");
const project = createDemoProject();
project.id = "external-import-review";
project.name = "External import review";
project.assets[0].id = "asset-source";
project.assets[0].name = "Original source";
project.assets[0].uri = source;
project.assets[0].duration = 2;
project.tracks[0].clips[0].assetId = "asset-source";
project.tracks[0].clips[0].duration = 2;
await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`);

const client = new Client({ name: "editkin-external-import-review", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(resources, "agent-gateway.mjs")],
  cwd: root,
  env: {
    ...process.env,
    EDITKIN_AGENT_GATEWAY_TARGET: join(resources, "mcp.mjs"),
    EDITKIN_WORKSPACE: workspace,
    EDITKIN_AGENT_PROJECT_PATH: projectPath,
    HAO_FFMPEG_PATH: ffmpeg,
    EDITKIN_CACHE_ROOT: join(workspace, "cache"),
  } as Record<string, string>,
  stderr: "pipe",
});
const call = async (name: string, arguments_: Record<string, unknown>) => client.callTool({ name: "call_editkin_tool",
  arguments: { name, arguments: arguments_ } });
try {
  await client.connect(transport);
  const summary = await call("get_project_summary", { projectPath });
  assert.equal(summary.isError, undefined, JSON.stringify(summary.content).slice(0, 500));
  const prepared = await call("prepare_ai_material", { projectPath, clipId: project.tracks[0].clips[0].id,
    includeTranscript: false, maxKeyframes: 2, keyframeTimes: [0.5], execution: "sync" });
  assert.equal(prepared.isError, undefined, JSON.stringify(prepared.content).slice(0, 500));
  const materialText = prepared.content.find((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string");
  assert(materialText, "Missing prepared material receipt");
  const material = JSON.parse(materialText.text);
  assert(["GREEN", "PARTIAL"].includes(material.status), `Material preparation returned ${material.status}`);
  assert.equal(material.packet?.source?.assetId, "asset-source");
  const edited = await call("apply_edit_commands", { projectPath, commands: [{ type: "rename_project", name: "Agent edited external import" }] });
  assert.equal(edited.isError, undefined, JSON.stringify(edited.content).slice(0, 500));
  const saved = JSON.parse(await readFile(projectPath, "utf8"));
  assert.equal(saved.name, "Agent edited external import");
  assert.equal(saved.assets[0].uri, source);
  const blocked = await call("apply_edit_commands", { projectPath, commands: [{ type: "import_asset", asset: {
    id: "unapproved", name: "Unapproved", kind: "video", uri: otherSource, duration: 2,
  } }] });
  assert.equal(blocked.isError, true, "A new outside source must remain blocked");
  assert.equal(JSON.parse(await readFile(projectPath, "utf8")).revision, saved.revision);
  assert.equal(createHash("sha256").update(await readFile(source)).digest("hex"), sourceHash);
  const report = { status: "PASS", bundledGateway: true, externalSourceAnalyzed: true, originalExternalSourcePreserved: true,
    editedProject: true, newExternalSourceBlocked: true, originalSourceUnchanged: true };
  await writeFile(join(fixture, "review-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ...report, report: join(fixture, "review-report.json") })}\n`);
} finally {
  await client.close();
}
