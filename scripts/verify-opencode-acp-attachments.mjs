// Optional local integration check: OPENCODE_EXECUTABLE=<official binary> node scripts/verify-opencode-acp-attachments.mjs
// Uses a short-lived loopback model stub; no user model or paid provider is contacted.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const executable = process.env.OPENCODE_EXECUTABLE;
if (!executable) throw new Error("Set OPENCODE_EXECUTABLE to the official local OpenCode binary");
const workspace = mkdtempSync(join(tmpdir(), "editkin-acp-attachment-"));
const marker = "EDITKIN_ACP_LYRIC_ATTACHMENT_4831";
const pixel = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
let child;
let server;
let modelRequest;
const requestBodies = [];
const updates = [];
let turnOutcome = "pending";

try {
  server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    if (request.method === "POST") {
      requestBodies.push(body);
      if (body.includes(marker) && body.includes(pixel)) modelRequest?.();
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end('data: {"id":"editkin-test","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"附件收到"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = server.address().port;
  const config = {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    model: "acptest/tiny",
    provider: { acptest: { npm: "@ai-sdk/openai-compatible", name: "ACP Attachment Test", options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "local-test" }, models: { tiny: { name: "Tiny Test Model", modalities: { input: ["text", "image"], output: ["text"] } } } } },
  };
  child = spawn(executable, ["acp"], {
    cwd: workspace,
    env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_AUTO_SHARE: "0" },
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  child.stderr.resume();
  let nextId = 0;
  let stdout = "";
  const pending = new Map();
  const write = (frame) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n");
  const rpc = (method, params) => new Promise((resolveReply, rejectReply) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); rejectReply(new Error(`${method} timed out`)); }, 20_000);
    pending.set(id, { resolveReply, rejectReply, timer });
    write({ id, method, params });
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    for (;;) {
      const index = stdout.indexOf("\n");
      if (index < 0) break;
      const line = stdout.slice(0, index).trim();
      stdout = stdout.slice(index + 1);
      if (!line) continue;
      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      if (typeof frame.id === "number" && !frame.method) {
        const target = pending.get(frame.id);
        if (!target) continue;
        clearTimeout(target.timer);
        pending.delete(frame.id);
        if (frame.error) target.rejectReply(new Error(frame.error.message));
        else target.resolveReply(frame.result);
      } else if (typeof frame.id === "number") {
        write({ id: frame.id, result: { outcome: { outcome: "cancelled" } } });
      } else if (frame.method === "session/update") {
        updates.push(String(frame.params?.update?.sessionUpdate || "unknown"));
      }
    }
  });
  child.on("exit", (code) => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.rejectReply(new Error(`OpenCode exited: ${code}`)); }
    pending.clear();
  });
  const init = await rpc("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "editkin-acp-check", version: "0.1.0" } });
  if (init?.protocolVersion !== 1) throw new Error("Unexpected ACP protocol version");
  const session = await rpc("session/new", { cwd: workspace, mcpServers: [] });
  await rpc("session/set_config_option", { sessionId: session.sessionId, configId: "model", value: "acptest/tiny" });
  let seenTimer;
  const seen = new Promise((resolveSeen, rejectSeen) => {
    modelRequest = () => { clearTimeout(seenTimer); resolveSeen(); };
    seenTimer = setTimeout(() => rejectSeen(new Error(`OpenCode did not forward both attachments (text=${requestBodies.some((body) => body.includes(marker))}, image=${requestBodies.some((body) => body.includes(pixel))}, imageUrl=${requestBodies.some((body) => body.includes("image_url"))}, inputImage=${requestBodies.some((body) => body.includes("input_image"))}, pngData=${requestBodies.some((body) => body.includes("data:image/png"))}, turn=${turnOutcome}, updates=${updates.slice(-8).join(",")})`)), 8_000);
  });
  void rpc("session/prompt", { sessionId: session.sessionId, prompt: [
    { type: "text", text: "Read the attached lyric sheet and answer briefly." },
    { type: "resource", resource: { uri: "editkin-attachment://local/lyrics.lrc", mimeType: "text/plain", text: marker } },
    { type: "image", mimeType: "image/png", data: pixel, uri: "file:///editkin-attachment/reference.png" },
  ] }).then((result) => { turnOutcome = JSON.stringify(result).slice(0, 200); }).catch((error) => { turnOutcome = String(error.message).slice(0, 200); });
  await seen;
  process.stdout.write(JSON.stringify({ status: "PASS", protocolVersion: init.protocolVersion, textReachedModel: true, imageReachedModel: true }) + "\n");
} finally {
  if (child && child.exitCode === null) {
    const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
    child.kill();
    await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 5_000))]);
  }
  await new Promise((resolveClose) => server?.close(resolveClose) ?? resolveClose());
  const tempRoot = resolve(tmpdir());
  const target = resolve(workspace);
  if (target.startsWith(tempRoot + sep) && target.includes("editkin-acp-attachment-")) rmSync(target, { recursive: true, force: true });
}
