// Read the final answer of an isolated OpenCode/Qwen review session without sending a new prompt.
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { OpenCodeAcp } from "../src/service/openCodeAcp";

const root = resolve(import.meta.dirname, "..");
const at = (flag: string) => { const index = process.argv.indexOf(flag); assert(index >= 0 && process.argv[index + 1]); return realpathSync(process.argv[index + 1]); };
const workspace = at("--workspace"), portable = at("--portable"), reportPath = at("--report");
assert.equal(dirname(workspace).toLowerCase(), realpathSync(resolve(root, "../artifacts/autopilot-desk")).toLowerCase());
assert.match(basename(workspace), /^kit-bound-create-[a-z0-9]+$/i);
const report = JSON.parse(await readFile(reportPath, "utf8"));
assert(typeof report.sessionId === "string" && report.sessionId.startsWith("ses_"));
const saved = JSON.parse(await readFile(join(process.env.APPDATA || "", "studio.hao.autopilotdesk.communitypreview", "local-story", "origin.json"), "utf8"));
const origin = new URL(saved.origin);
assert.equal(origin.protocol, "http:");
assert(/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/u.test(origin.hostname));
const executable = join(dirname(portable), "resources/agent-runtime-v3/opencode.exe");
const agent = new OpenCodeAcp();
try {
  await agent.start({ workspace, opencodeExecutable: executable, modelOrigin: origin.origin });
  await agent.loadSession(report.sessionId, String(report.model));
  const snapshot = agent.status(0);
  const events = snapshot.events;
  const messages = events.filter(event => event.kind === "message" && event.text?.trim());
  const tailKinds = events.slice(-12).map(event => ({ kind: event.kind, status: event.status,
    text: event.kind === "tool" ? event.text?.slice(0, 60) : undefined }));
  const turns = events.filter(event => event.kind === "turn").map(event => event.status);
  const last = messages.at(-1)?.text || "";
  const sanitized = last.replaceAll(origin.origin, "<model-origin>").replaceAll(workspace, "<fixture>")
    .replaceAll(dirname(portable), "<packaged-preview>").replaceAll(root, "<repository>");
  process.stdout.write(`${JSON.stringify({ status: "READ_ONLY", messageCount: messages.length,
    lastMessage: sanitized.slice(-2400), lastMessageTruncated: sanitized.length > 2400,
    usage: snapshot.usage, turns, tailKinds })}\n`);
} finally { agent.close(); }
