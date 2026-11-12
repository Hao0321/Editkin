import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../src/domain/types";

const appRoot = resolve(import.meta.dirname, "..");
if (!process.env.EDITKIN_WORKSPACE || !process.env.EDITKIN_VIDEO_AUTOPILOT_SKILL) {
  throw new Error("Set EDITKIN_WORKSPACE and EDITKIN_VIDEO_AUTOPILOT_SKILL before probing");
}
const client = new Client({ name: "autopilot-contract-probe", version: "0.15.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(appRoot, "node_modules/tsx/dist/cli.mjs"), "src/mcp/server.ts"],
  cwd: appRoot,
  env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
  stderr: "pipe",
});
try {
  await client.connect(transport);
  const result = await client.callTool({ name: "get_autopilot_contract", arguments: {} });
  const content = result.content.find((item) => item.type === "text");
  const payload = JSON.parse(content?.type === "text" ? content.text : "{}") as Record<string, unknown>;
  if (result.isError || payload.status !== "GREEN") throw new Error("Live v4 contract probe failed");
  const identity = payload.liveInvocation as Record<string, unknown> | undefined;
  const source = payload.requiredPlanSource as Record<string, unknown> | undefined;
  if (!identity?.bindingSha256 || source?.invocationBindingSha256 !== identity.bindingSha256) {
    throw new Error("Contract source binding mismatch");
  }
  process.stdout.write(JSON.stringify({ status: payload.status, bindingSha256: identity.bindingSha256,
    contractKeys: Object.keys((payload.contract ?? {}) as object), sourceBound: true }) + "\n");
  if (process.argv.includes("--setup-synthetic")) {
    const projectPath = process.env.EDITKIN_TEST_PROJECT;
    const sourcePath = process.env.EDITKIN_TEST_SOURCE;
    if (!projectPath || !sourcePath || existsSync(resolve(process.env.EDITKIN_WORKSPACE, projectPath))) {
      throw new Error("Synthetic project/source missing or target project already exists");
    }
    const sourceSha256 = createHash("sha256").update(readFileSync(sourcePath)).digest("hex");
    const create = await client.callTool({ name: "create_project", arguments: {
      projectPath, name: "Synthetic Material Evidence Probe", width: 640, height: 360, fps: 30,
    } });
    if (create.isError) throw new Error("Could not create synthetic project");
    const importResult = await client.callTool({ name: "apply_edit_commands", arguments: {
      projectPath, commands: [
        { type: "import_asset", asset: { id: "asset-source", name: "Tagged synthetic footage", kind: "video", uri: sourcePath,
          duration: 4, width: 960, height: 540, derivatives: { sourceSha256, generatedAt: new Date().toISOString() } } },
        { type: "add_clip", clip: { id: "clip-source", assetId: "asset-source", trackId: "video-main", timelineStart: 0,
          sourceStart: 0, duration: 4, volume: 1, transform: DEFAULT_TRANSFORM, color: DEFAULT_COLOR, keyframes: [] } },
      ],
    } });
    if (importResult.isError) throw new Error("Could not import synthetic source into project");
    process.stdout.write(JSON.stringify({ syntheticProjectCreated: true, sourceBound: true }) + "\n");
  }
  if (process.argv.includes("--prepare-synthetic")) {
    const projectPath = process.env.EDITKIN_TEST_PROJECT;
    if (!projectPath) throw new Error("Set EDITKIN_TEST_PROJECT for synthetic material probe");
    const sessionResult = await client.callTool({ name: "start_ai_editing_session", arguments: { projectPath } });
    const sessionText = sessionResult.content.find((item) => item.type === "text");
    const session = JSON.parse(sessionText?.type === "text" ? sessionText.text : "{}") as Record<string, unknown>;
    const clips = session.clips as Array<{ clipId: string }> | undefined;
    if (sessionResult.isError || session.status !== "GREEN" || !clips?.[0]?.clipId) throw new Error("Synthetic project session unavailable");
    const preparedResult = await client.callTool({ name: "prepare_ai_material", arguments: {
      projectPath, clipId: clips[0].clipId, includeTranscript: false, maxKeyframes: 4, execution: "sync",
    } });
    const preparedText = preparedResult.content.find((item) => item.type === "text");
    const prepared = JSON.parse(preparedText?.type === "text" ? preparedText.text : "{}") as Record<string, unknown>;
    const packet = prepared.packet as Record<string, unknown> | undefined;
    if (preparedResult.isError || !["GREEN", "PARTIAL"].includes(String(prepared.status)) || !packet?.materialId) {
      throw new Error(`Material preparation failed: ${JSON.stringify(prepared).slice(0, 500)}`);
    }
    process.stdout.write(JSON.stringify({ materialStatus: prepared.status, cacheHit: prepared.cacheHit,
      materialId: packet.materialId, frameCount: Array.isArray(packet.keyframes) ? packet.keyframes.length : null,
      transcriptState: (packet.transcript as Record<string, unknown> | undefined)?.state ?? null }) + "\n");
  }
} finally {
  await client.close();
}
