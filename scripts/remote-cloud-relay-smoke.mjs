import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const allocatePort = () => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => typeof address === "object" && address ? resolvePort(address.port) : reject(new Error("port allocation failed")));
  });
});

const waitFor = async (test, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await test()) return; } catch { /* retry */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("relay smoke timeout");
};

const nextMessage = (socket, predicate = () => true, timeoutMs = 8_000) => new Promise((resolveMessage, reject) => {
  const timer = setTimeout(() => { socket.removeEventListener("message", listener); reject(new Error("websocket response timeout")); }, timeoutMs);
  const listener = (event) => {
    const value = JSON.parse(String(event.data));
    if (!predicate(value)) return;
    clearTimeout(timer);
    socket.removeEventListener("message", listener);
    resolveMessage(value);
  };
  socket.addEventListener("message", listener);
});

const openSocket = (url) => new Promise((resolveSocket, reject) => {
  const socket = new WebSocket(url);
  socket.addEventListener("open", () => resolveSocket(socket), { once: true });
  socket.addEventListener("error", reject, { once: true });
});

const nextClose = (socket, timeoutMs = 8_000) => new Promise((resolveClose, reject) => {
  const timer = setTimeout(() => reject(new Error("websocket close timeout")), timeoutMs);
  socket.addEventListener("close", (event) => {
    clearTimeout(timer);
    resolveClose({ code: event.code, reason: event.reason });
  }, { once: true });
});

const requestUntil = (socket, payload, predicate, timeoutMs = 10_000) => new Promise((resolveMessage, reject) => {
  const deadline = Date.now() + timeoutMs;
  const listener = (event) => {
    const value = JSON.parse(String(event.data));
    if (!predicate(value)) return;
    clearInterval(timer);
    socket.removeEventListener("message", listener);
    resolveMessage(value);
  };
  socket.addEventListener("message", listener);
  const send = () => {
    if (Date.now() >= deadline) {
      clearInterval(timer);
      socket.removeEventListener("message", listener);
      reject(new Error("websocket request retry timeout"));
    } else if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  };
  const timer = setInterval(send, 250);
  send();
});

const root = await mkdtemp(join(tmpdir(), "editkin-cloud-relay-"));
const queuePath = join(root, "commands");
const snapshotPath = join(root, "snapshot.json");
const devicesPath = join(root, "devices.json");
const trustedDevicesPath = join(root, "trusted-devices.json");
const relayPort = await allocatePort();
const localPort = await allocatePort();
const room = "0123456789abcdef0123456789abcdef";
const secret = "abcdef0123456789".repeat(4);
const token = "11223344556677889900aabbccddeeff";
const evidencePath = resolve(".rd/benchmarks/editkin-remote-relay-security-negatives.json");
const calibratedNegatives = {};
await writeFile(snapshotPath, `${JSON.stringify({ projectName: "跨網路測試", resolution: "1920×1080", fps: 30, trackCount: 5, playhead: 2.5, playheadLabel: "00:02.50", previewPath: "C:/private.mp4" })}\n`);

const wranglerCli = process.env.APPDATA ? resolve(process.env.APPDATA, "npm/node_modules/wrangler/bin/wrangler.js") : "wrangler";
const worker = spawn(process.execPath, [wranglerCli, "dev", "--local", "--port", String(relayPort), "--ip", "127.0.0.1"], { cwd: resolve("relay"), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let remote;
let mobile;
let malformedRemote;
let mockRelay;
let workerLog = "";
let remoteLog = "";
let phase = "worker-start";
worker.stdout.on("data", (chunk) => { workerLog = `${workerLog}${chunk}`.slice(-12_000); });
worker.stderr.on("data", (chunk) => { workerLog = `${workerLog}${chunk}`.slice(-12_000); });
try {
  await waitFor(async () => (await fetch(`http://127.0.0.1:${relayPort}/r/${room}`)).ok, 30_000);
  const pageResponse = await fetch(`http://127.0.0.1:${relayPort}/r/${room}`);
  const pageText = await pageResponse.text();
  const csp = pageResponse.headers.get("content-security-policy") ?? "";
  const claimResponse = await fetch(`http://127.0.0.1:${relayPort}/claim/${room}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: `http://127.0.0.1:${relayPort}`, "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ credential: "credential-for-cookie-smoke-test-1234567890", deviceId: "cookie-smoke-phone" }),
  });
  const claimCookie = claimResponse.headers.get("set-cookie") ?? "";
  remote = spawn(process.execPath, [resolve("desktop-dist/remote.mjs")], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env,
    EDITKIN_REMOTE_TOKEN: token,
    EDITKIN_REMOTE_HEALTH_PROBE_ID: "4".repeat(32),
    EDITKIN_REMOTE_PORT: String(localPort),
    EDITKIN_REMOTE_QUEUE: queuePath,
    EDITKIN_REMOTE_SNAPSHOT: snapshotPath,
    EDITKIN_REMOTE_DEVICES: devicesPath,
    EDITKIN_REMOTE_TRUSTED_DEVICES: trustedDevicesPath,
    EDITKIN_REMOTE_RELAY_WS_URL: `ws://127.0.0.1:${relayPort}/ws/${room}`,
    EDITKIN_REMOTE_RELAY_ROOM: room,
    EDITKIN_REMOTE_RELAY_SECRET: secret,
  } });
  remote.stdout.on("data", (chunk) => { remoteLog = `${remoteLog}${chunk}`.slice(-8_000); });
  remote.stderr.on("data", (chunk) => { remoteLog = `${remoteLog}${chunk}`.slice(-8_000); });
  phase = "desktop-connect";
  await waitFor(async () => {
    try { const socket = await new Promise((resolveSocket, reject) => { const candidate = new WebSocket(`ws://127.0.0.1:${relayPort}/ws/${room}`); candidate.onopen = () => resolveSocket(candidate); candidate.onerror = reject; }); socket.close(); return true; } catch { return false; }
  });
  mobile = new WebSocket(`ws://127.0.0.1:${relayPort}/ws/${room}`);
  await new Promise((resolveOpen, reject) => { mobile.onopen = resolveOpen; mobile.onerror = reject; });
  mobile.send(JSON.stringify({ type: "mobile-hello", clientId: "cross-network-phone" }));
  phase = "pair";
  const paired = await requestUntil(mobile, { type: "pair", token, deviceId: "permanent-phone", name: "5G iPhone" }, (value) => value.type === "paired");
  phase = "status";
  const statusPromise = nextMessage(mobile, (value) => value.type === "status");
  mobile.send(JSON.stringify({ type: "status", deviceId: "permanent-phone", credential: paired.credential }));
  const status = await statusPromise;
  phase = "command";
  const commandPromise = nextMessage(mobile, (value) => value.type === "accepted");
  mobile.send(JSON.stringify({ type: "command", deviceId: "permanent-phone", credential: paired.credential, instruction: "智慧成片" }));
  const command = await commandPromise;
  await waitFor(async () => (await readdir(queuePath)).some((name) => name.endsWith(".json")));
  const queueFile = (await readdir(queuePath)).find((name) => name.endsWith(".json"));
  const queued = JSON.parse(await readFile(join(queuePath, queueFile), "utf8"));
  const stored = await readFile(trustedDevicesPath, "utf8");
  const credentialAbsentAtRest = !stored.includes(paired.credential);
  const badPromise = nextMessage(mobile, (value) => value.type === "unauthorized");
  phase = "invalid-credential";
  mobile.send(JSON.stringify({ type: "status", deviceId: "permanent-phone", credential: `${paired.credential}x` }));
  const bad = await badPromise;
  phase = "relay-frame-negatives";
  const oversized = await openSocket(`ws://127.0.0.1:${relayPort}/ws/${room}`);
  const oversizedClosePromise = nextClose(oversized);
  oversized.send(JSON.stringify({ type: "mobile-hello", clientId: "oversized-client", padding: "x".repeat(40_000) }));
  const oversizedClose = await oversizedClosePromise;
  calibratedNegatives.oversizedFrame = { rejected: oversizedClose.code === 1009, closeCode: oversizedClose.code, expectedCloseCode: 1009 };

  const malformed = await openSocket(`ws://127.0.0.1:${relayPort}/ws/${room}`);
  const malformedClosePromise = nextClose(malformed);
  malformed.send("{");
  const malformedClose = await malformedClosePromise;
  calibratedNegatives.malformedFrame = { rejected: malformedClose.code === 1003, closeCode: malformedClose.code, expectedCloseCode: 1003 };

  const rateFlood = await openSocket(`ws://127.0.0.1:${relayPort}/ws/${room}`);
  rateFlood.send(JSON.stringify({ type: "mobile-hello", clientId: "rate-flood-client" }));
  const rateClosePromise = nextClose(rateFlood);
  for (let index = 0; index < 35; index += 1) rateFlood.send(JSON.stringify({ type: "status", deviceId: "rate-flood-device", credential: "x".repeat(32) }));
  const rateClose = await rateClosePromise;
  calibratedNegatives.perClientRate = { rejected: rateClose.code === 1008, closeCode: rateClose.code, expectedCloseCode: 1008 };

  phase = "relay-pair-rate";
  const pairFlood = await openSocket(`ws://127.0.0.1:${relayPort}/ws/${room}`);
  pairFlood.send(JSON.stringify({ type: "mobile-hello", clientId: "pair-flood-client" }));
  await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  const pairFloodResponses = [];
  for (let index = 0; index < 11; index += 1) {
    const responsePromise = nextMessage(pairFlood, (value) => value.type === "error");
    pairFlood.send(JSON.stringify({ type: "pair", token: `${token}-invalid`, deviceId: "pair-flood-device", name: "Flood Phone" }));
    pairFloodResponses.push(await responsePromise);
  }
  pairFlood.close();
  const pairFloodLimited = pairFloodResponses.at(-1)?.error === "配對嘗試過多，請稍後再試"
    && pairFloodResponses.slice(0, 10).every((response) => response.error === "配對碼無效或已過期");
  calibratedNegatives.relayPairFlood = { rejected: pairFloodLimited, allowedAttempts: 10, rejectedAttempt: 11, responses: pairFloodResponses.map((response) => response.error) };

  phase = "malformed-upstream";
  const remoteExited = new Promise((resolveExit) => remote.once("exit", resolveExit));
  remote.kill();
  await remoteExited;
  remote = undefined;
  const require = createRequire(import.meta.url);
  const wranglerRoot = dirname(dirname(wranglerCli));
  const { WebSocketServer } = require(resolve(wranglerRoot, "node_modules/ws"));
  const mockRelayPort = await allocatePort();
  const malformedLocalPort = await allocatePort();
  mockRelay = new WebSocketServer({ host: "127.0.0.1", port: mockRelayPort });
  await new Promise((resolveListening, reject) => {
    if (mockRelay.address()) resolveListening();
    else {
      mockRelay.once("listening", resolveListening);
      mockRelay.once("error", reject);
    }
  });
  const upstreamRejected = new Promise((resolveRejected, reject) => {
    const timer = setTimeout(() => reject(new Error("malformed upstream was not rejected")), 8_000);
    mockRelay.once("connection", (socket) => {
      socket.once("message", (data) => {
        let authenticated = false;
        try { authenticated = JSON.parse(String(data)).type === "desktop-auth"; } catch { /* fail below */ }
        socket.once("close", (code, reason) => {
          clearTimeout(timer);
          resolveRejected({ authenticated, code, reason: String(reason) });
        });
        socket.send("{");
      });
    });
  });
  malformedRemote = spawn(process.execPath, [resolve("desktop-dist/remote.mjs")], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: {
    ...process.env,
    EDITKIN_REMOTE_TOKEN: token,
    EDITKIN_REMOTE_HEALTH_PROBE_ID: "5".repeat(32),
    EDITKIN_REMOTE_PORT: String(malformedLocalPort),
    EDITKIN_REMOTE_QUEUE: queuePath,
    EDITKIN_REMOTE_SNAPSHOT: snapshotPath,
    EDITKIN_REMOTE_DEVICES: devicesPath,
    EDITKIN_REMOTE_TRUSTED_DEVICES: trustedDevicesPath,
    EDITKIN_REMOTE_RELAY_WS_URL: `ws://127.0.0.1:${mockRelayPort}/ws/${room}`,
    EDITKIN_REMOTE_RELAY_ROOM: room,
    EDITKIN_REMOTE_RELAY_SECRET: secret,
  } });
  const upstreamClose = await upstreamRejected;
  calibratedNegatives.malformedUpstream = { rejected: upstreamClose.authenticated && upstreamClose.code === 4008, closeCode: upstreamClose.code, expectedCloseCode: 4008, desktopAuthenticatedFirst: upstreamClose.authenticated };
  malformedRemote.kill();
  malformedRemote = undefined;
  await new Promise((resolveClose) => mockRelay.close(resolveClose));
  mockRelay = undefined;

  const calibratedNegativeCount = Object.values(calibratedNegatives).filter((entry) => entry.rejected).length;
  const green = pageText.includes("手機與電腦可在不同網路")
    && pageText.includes("/claim/") && !pageText.includes(":credential'") && !pageText.includes(":credential\"")
    && claimResponse.status === 201 && claimCookie.includes("HttpOnly") && claimCookie.includes("Secure") && claimCookie.includes("SameSite=Strict")
    && csp.includes("script-src 'nonce-") && !csp.includes("unsafe-inline")
    && paired.permanent === true && paired.credential.length >= 32
    && status.projectName === "跨網路測試" && status.previewPath === undefined && status.transport === "cloud-relay"
    && command.commandId === queued.id && queued.instruction === "智慧成片"
    && credentialAbsentAtRest && bad.type === "unauthorized"
    && calibratedNegativeCount === 5;
  const report = { schema: "editkin.remote-relay-security-negatives/v1", status: green ? "GREEN" : "BLOCK", measuredAt: new Date().toISOString(), scope: "local-wrangler-and-loopback-mock-only", productionDeploymentVerified: false, productionRelayStatus: "blocked_external", transport: status.transport, permanent: paired.permanent, stableRoom: room, command: queued.instruction, credentialAbsentAtRest, credentialAbsentFromLocalStorage: !pageText.includes(":credential'"), httpOnlyCookie: claimCookie.includes("HttpOnly") && claimCookie.includes("Secure") && claimCookie.includes("SameSite=Strict"), relayCspNonce: csp.includes("script-src 'nonce-") && !csp.includes("unsafe-inline"), privatePathHidden: status.previewPath === undefined, calibratedNegativeCount, calibratedNegatives };
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...report, evidencePath }, null, 2));
  if (!green) process.exitCode = 1;
} catch (error) {
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify({ schema: "editkin.remote-relay-security-negatives/v1", status: "BLOCK", measuredAt: new Date().toISOString(), scope: "local-wrangler-and-loopback-mock-only", productionDeploymentVerified: false, productionRelayStatus: "blocked_external", phase, calibratedNegatives, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`, "utf8");
  console.error(JSON.stringify({ phase, error: error instanceof Error ? error.message : String(error), workerLog, remoteLog }, null, 2));
  throw error;
} finally {
  mobile?.close();
  remote?.kill();
  malformedRemote?.kill();
  if (mockRelay) await new Promise((resolveClose) => mockRelay.close(resolveClose));
  worker.kill();
  await rm(root, { recursive: true, force: true });
}
