import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { strict as assert } from "node:assert";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const client = new Client({ name: "shot-selection-smoke", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(root, "node_modules/tsx/dist/cli.mjs"), "src/mcp/server.ts"],
  cwd: root,
  env: Object.fromEntries(Object.entries(process.env).filter((row): row is [string, string] => typeof row[1] === "string")),
});

try {
  await client.connect(transport);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(names.includes("rank_style_shots"));
  const catalog = await client.callTool({ name: "list_creative_presets", arguments: { kind: "cinematic" } });
  assert.equal(catalog.isError, undefined);
  const styles = JSON.parse(String((catalog.content[0] as { text?: string })?.text ?? "{}"))
    .presets.cinematicLanguage.shotSelectionStyles;
  assert.equal(styles.length, 9);
  const result = await client.callTool({ name: "rank_style_shots", arguments: {
    styleId: "vlog", candidates: [{ id: "source-shot", sourceRef: "clip@00:10", rightsApproved: true,
      beatPurposeMatched: true, observations: [{ signal: "first_person_interaction", evidenceRef: "frame:300" }] }],
  } });
  assert.equal(result.isError, undefined);
  const payload = JSON.parse(String((result.content[0] as { text?: string })?.text ?? "{}"));
  assert.equal(payload.directApplyAllowed, false);
  assert.equal(payload.rows[0].status, "DRAFT_RANKING_REVIEW_REQUIRED");
  console.log("shot-selection MCP smoke GREEN");
} finally {
  await client.close();
}
