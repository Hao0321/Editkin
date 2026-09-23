import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const allocatePort = () => new Promise((resolvePort, reject) => {
  const allocator = createServer();
  allocator.once("error", reject);
  allocator.listen(0, "127.0.0.1", () => {
    const address = allocator.address();
    allocator.close(() => typeof address === "object" && address ? resolvePort(address.port) : reject(new Error("無法配置測試連接埠")));
  });
});
const port = await allocatePort();
const root = await mkdtemp(join(tmpdir(), "editkin-remote-smoke-"));
const queuePath = join(root, "commands");
const snapshotPath = join(root, "snapshot.json");
const devicesPath = join(root, "devices.json");
const trustedDevicesPath = join(root, "trusted-devices.json");
const token = "0123456789abcdef0123456789abcdef";
await writeFile(snapshotPath, `${JSON.stringify({ projectName: "Remote Smoke", resolution: "640×360", fps: 30, trackCount: 4, playhead: 1.25, playheadLabel: "00:01.25", status: "ready", previewPath: "C:\\private\\clip.mp4" })}\n`);

const child = spawn(process.execPath, [resolve("desktop-dist/remote.mjs")], {
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    EDITKIN_REMOTE_TOKEN: token,
    EDITKIN_REMOTE_HEALTH_PROBE_ID: "1".repeat(32),
    EDITKIN_REMOTE_PORT: String(port),
    EDITKIN_REMOTE_QUEUE: queuePath,
    EDITKIN_REMOTE_SNAPSHOT: snapshotPath,
    EDITKIN_REMOTE_DEVICES: devicesPath,
    EDITKIN_REMOTE_TRUSTED_DEVICES: trustedDevicesPath,
  },
});

const ready = new Promise((resolveReady, reject) => {
  let output = "";
  const timer = setTimeout(() => reject(new Error("Editkin Remote 啟動逾時")), 5_000);
  child.stdout.on("data", (chunk) => {
    output += chunk;
    if (output.includes('"status":"READY"')) { clearTimeout(timer); resolveReady(); }
  });
  child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Editkin Remote 提前結束：${code}`)); });
});

let reconnectChild;

try {
  await ready;
  const origin = `http://127.0.0.1:${port}`;
  const page = await fetch(`${origin}/`);
  const pageText = await page.text();
  const csp = page.headers.get("content-security-policy") ?? "";
  const unauthorized = await fetch(`${origin}/api/status`);
  const bootstrapCannotControl = await fetch(`${origin}/api/status?token=${token}`);
  const crossOriginPair = await fetch(`${origin}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://attacker.invalid" },
    body: JSON.stringify({ token, deviceId: "evil", name: "Cross Site" }),
  });
  const missingOriginPair = await fetch(`${origin}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, deviceId: "missing-origin", name: "Missing Origin" }),
  });
  const invalidTokenPair = await fetch(`${origin}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ token: `${token}x`, deviceId: "invalid-token", name: "Invalid Token" }),
  });
  const pairSamplesMs = [];
  let pairResponse;
  let localCookie = "";
  for (let index = 0; index < 8; index += 1) {
    const started = performance.now();
    pairResponse = await fetch(`${origin}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ token, deviceId: "smoke-phone", name: "Smoke iPhone" }),
    });
    pairSamplesMs.push(performance.now() - started);
    localCookie = (pairResponse.headers.get("set-cookie") ?? "").split(";", 1)[0] ?? "";
    if (pairResponse.status !== 201) break;
  }
  if (!pairResponse) throw new Error("pair response missing");
  const tunnelOrigin = origin.replace(/^http:/, "https:");
  const tunnelPair = await fetch(`${origin}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: tunnelOrigin, "x-forwarded-proto": "https" },
    body: JSON.stringify({ token, deviceId: "tunnel-phone", name: "Tunnel iPhone" }),
  });
  const tunnelSetCookie = tunnelPair.headers.get("set-cookie") ?? "";
  const rateLimitedPair = await fetch(`${origin}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ token, deviceId: "rate-limited", name: "Rate Limited" }),
  });
  const statusResponse = await fetch(`${origin}/api/status`, { headers: { cookie: localCookie } });
  const status = await statusResponse.json();
  const crossOriginCommand = await fetch(`${origin}/api/command`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: localCookie, origin: "https://attacker.invalid" },
    body: JSON.stringify({ instruction: "刪除全部" }),
  });
  const wrongContentTypeCommand = await fetch(`${origin}/api/command`, {
    method: "POST",
    headers: { "content-type": "text/plain", cookie: localCookie, origin },
    body: JSON.stringify({ instruction: "刪除全部" }),
  });
  const commandStarted = performance.now();
  const commandResponse = await fetch(`${origin}/api/command`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: localCookie, origin },
    body: JSON.stringify({ instruction: "在目前播放頭分割" }),
  });
  const commandLatencyMs = performance.now() - commandStarted;
  const commandBody = await commandResponse.json();
  const queueFiles = (await readdir(queuePath)).filter((name) => name.endsWith(".json"));
  const queued = JSON.parse((await readFile(join(queuePath, queueFiles[0]), "utf8")).trim());
  const devices = JSON.parse(await readFile(devicesPath, "utf8"));
  const trustedBeforeRestart = JSON.parse(await readFile(trustedDevicesPath, "utf8"));
  const childExited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill();
  await childExited;
  const reconnectPort = await allocatePort();
  reconnectChild = spawn(process.execPath, [resolve("desktop-dist/remote.mjs")], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      EDITKIN_REMOTE_TOKEN: "fedcba9876543210fedcba9876543210",
      EDITKIN_REMOTE_HEALTH_PROBE_ID: "2".repeat(32),
      EDITKIN_REMOTE_PORT: String(reconnectPort),
      EDITKIN_REMOTE_QUEUE: queuePath,
      EDITKIN_REMOTE_SNAPSHOT: snapshotPath,
      EDITKIN_REMOTE_DEVICES: devicesPath,
      EDITKIN_REMOTE_TRUSTED_DEVICES: trustedDevicesPath,
    },
  });
  await new Promise((resolveReady, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Editkin Remote 重啟逾時")), 5_000);
    reconnectChild.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes('"status":"READY"')) { clearTimeout(timer); resolveReady(); }
    });
    reconnectChild.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Editkin Remote 重啟提前結束：${code}`)); });
  });
  const reconnectOrigin = `http://127.0.0.1:${reconnectPort}`;
  const reconnectResponse = await fetch(`${reconnectOrigin}/api/status`, { headers: { cookie: localCookie } });
  const reconnectStatus = await reconnectResponse.json();
  const credential = localCookie.split("=", 2)[1] ?? "";
  const secretAbsentAtRest = credential.length > 0 && !(await readFile(trustedDevicesPath, "utf8")).includes(credential);
  trustedBeforeRestart.devices = trustedBeforeRestart.devices.filter((device) => device.id !== "smoke-phone");
  await writeFile(trustedDevicesPath, `${JSON.stringify(trustedBeforeRestart)}\n`, "utf8");
  const revokedResponse = await fetch(`${reconnectOrigin}/api/status`, { headers: { cookie: localCookie } });
  const green = page.ok
    && pageText.includes("Editkin Remote")
    && pageText.includes("history.replaceState")
    && pageText.includes("智慧成片")
    && csp.includes("script-src 'sha256-")
    && csp.includes("style-src 'sha256-")
    && !csp.includes("unsafe-inline")
    && unauthorized.status === 401
    && bootstrapCannotControl.status === 401
    && crossOriginPair.status === 403
    && missingOriginPair.status === 403
    && invalidTokenPair.status === 401
    && pairResponse.status === 201
    && pairSamplesMs.length === 8
    && localCookie.startsWith("editkin_remote_device=")
    && tunnelPair.status === 201
    && /; Secure/i.test(tunnelSetCookie)
    && rateLimitedPair.status === 429
    && statusResponse.ok
    && status.projectName === "Remote Smoke"
    && status.previewPath === undefined
    && status.previewAvailable === true
    && status.deviceName === "Smoke iPhone"
    && crossOriginCommand.status === 403
    && wrongContentTypeCommand.status === 403
    && commandResponse.status === 202
    && queueFiles.length === 1
    && commandBody.commandId === queued.id
    && pairSamplesMs.every((sample) => sample < 250)
    && commandLatencyMs < 250
    && devices.connectedCount === 2
    && devices.trustedCount === 2
    && devices.devices.some((device) => device.name === "Smoke iPhone")
    && devices.devices.some((device) => device.name === "Tunnel iPhone")
    && reconnectResponse.status === 200
    && reconnectStatus.permanentlyPaired === true
    && secretAbsentAtRest
    && revokedResponse.status === 401
    && queued.instruction === "在目前播放頭分割";
  const sortedPairSamples = [...pairSamplesMs].sort((a, b) => a - b);
  const pairP95Ms = sortedPairSamples[Math.ceil(sortedPairSamples.length * 0.95) - 1];
  process.stdout.write(`${JSON.stringify({ status: green ? "GREEN" : "BLOCK", port, page: page.status, cspHashed: csp.includes("script-src 'sha256-") && !csp.includes("unsafe-inline"), unauthorized: unauthorized.status, bootstrapCannotControl: bootstrapCannotControl.status, crossOriginPair: crossOriginPair.status, missingOriginPair: missingOriginPair.status, invalidTokenPair: invalidTokenPair.status, pair: pairResponse.status, repeatedPairCount: pairSamplesMs.length, pairP95Ms: Number(pairP95Ms.toFixed(2)), rateLimitedPair: rateLimitedPair.status, permanentDeviceCookie: localCookie.startsWith("editkin_remote_device="), autoReconnectAfterServerRestart: reconnectResponse.status, revocationEnforced: revokedResponse.status, secretAbsentAtRest, secureCookieThroughTunnel: /; Secure/i.test(tunnelSetCookie), crossOriginCommand: crossOriginCommand.status, wrongContentTypeCommand: wrongContentTypeCommand.status, connected: devices.connectedCount, trusted: devices.trustedCount, command: commandResponse.status, commandLatencyMs: Number(commandLatencyMs.toFixed(2)), atomicQueueFiles: queueFiles.length, privatePathHidden: status.previewPath === undefined, queued: queued.instruction })}\n`);
  if (!green) process.exitCode = 1;
} finally {
  child.kill();
  reconnectChild?.kill();
  await rm(root, { recursive: true, force: true });
}
