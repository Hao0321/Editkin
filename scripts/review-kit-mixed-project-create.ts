// Copy a saved project and prove that all real images/videos bind without model-supplied paths or policies.
// Usage: npx tsx scripts/review-kit-mixed-project-create.ts --project <saved project> --portable <preview.exe>
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = resolve(import.meta.dirname, "..");
const at = (flag: string) => { const index = process.argv.indexOf(flag); assert(index >= 0 && process.argv[index + 1]);
  return resolve(process.argv[index + 1]); };
const source = at("--project"), portable = at("--portable");
assert.equal(basename(portable).toLowerCase(), "autopilotdesk-community-preview.exe");
const artifacts = resolve(root, "../artifacts/autopilot-desk");
await mkdir(artifacts, { recursive: true });
const workspace = await mkdtemp(join(artifacts, "kit-mixed-project-"));
const projectPath = join(workspace, "movie.editkin.json");
const sourceBytes = await readFile(source);
const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
const project = JSON.parse(sourceBytes.toString("utf8"));
const assets = new Map(project.assets.map((asset: any) => [asset.id, asset]));
const expected = project.tracks.flatMap((track: any) => track.clips)
  .filter((clip: any) => clip.assetId !== "asset-demo");
assert(expected.length > 1 && expected.length <= 32);
await writeFile(projectPath, sourceBytes);
const resources = join(dirname(portable), "resources");
const executable = (name: string) => execFileSync("where.exe", [name], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
const client = new Client({ name: "editkin-mixed-project-review", version: "1" });
const transport = new StdioClientTransport({ command: process.execPath,
  args: [join(resources, "runtime/agent-gateway.mjs")], cwd: root,
  env: { ...process.env, EDITKIN_AGENT_GATEWAY_TARGET: join(resources, "runtime/mcp.mjs"),
    EDITKIN_WORKSPACE: workspace, EDITKIN_AGENT_PROJECT_PATH: projectPath,
    EDITKIN_VIDEO_AUTOPILOT_SKILL: join(resources, "video-autopilot-kit/SKILL.md"),
    HAO_FFMPEG_PATH: executable("ffmpeg"), HAO_FFPROBE_PATH: executable("ffprobe"),
    EDITKIN_CACHE_ROOT: join(workspace, "cache"), EDITKIN_PLUGIN_ROOTS: join(root, "plugins") } as Record<string, string>,
  stderr: "pipe" });
try {
  await client.connect(transport);
  const created = await client.callTool({ name: "run_kit_workflow", arguments: { command: "create", runId: "all-materials" } });
  const body = created.content.find((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")?.text;
  if (created.isError || !body) throw Error(String(body || "Kit did not create a run").slice(0, 500));
  const result = JSON.parse(body);
  assert(typeof result.run_dir === "string");
  const state = JSON.parse(await readFile(join(result.run_dir, "workflow-state.json"), "utf8"));
  assert.equal(state.binding.materials.length, expected.length);
  const imageIds = new Set(expected.filter((clip: any) => (assets.get(clip.assetId) as any)?.kind === "image")
    .map((clip: any) => clip.id));
  for (const material of state.binding.materials) if (imageIds.has(material.clip_id))
    assert.equal(material.transcript_policy, "visual-only");
  const projectUnchanged = sourceHash === createHash("sha256").update(await readFile(projectPath)).digest("hex")
    && sourceHash === createHash("sha256").update(await readFile(source)).digest("hex");
  assert(projectUnchanged);
  const report = { status: "PASS", workspace, materialCount: expected.length, imageCount: imageIds.size,
    imagePoliciesAutomatic: true, projectUnchanged, runCreated: true };
  await writeFile(join(workspace, "mixed-create-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally { await client.close(); }
