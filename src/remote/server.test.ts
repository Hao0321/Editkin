import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const room = "0123456789abcdef0123456789abcdef";
const bootstrapToken = "bootstrap-token-for-tests-0123456789";
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

let workspace: string;
let bundle: string;
beforeAll(async () => {
  workspace = await mkdtemp(join(tmpdir(), "editkin-remote-test-"));
  bundle = join(workspace, "remote.mjs");
  await build({ entryPoints: ["src/remote/server.ts"], bundle: true, platform: "node", target: "node22", format: "esm", outfile: bundle, logLevel: "silent" });
}, 60_000);
afterAll(async () => { await rm(workspace, { recursive: true, force: true }); });

async function freePort(): Promise<number> {
  const probe = createTcpServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const { port } = probe.address() as { port: number };
  await new Promise((done) => probe.close(done));
  return port;
}

/** Minimal RFC 6455 text-frame relay: enough to drive the desktop's WebSocket client. */
class FakeRelay {
  readonly server: Server;
  sockets: Socket[] = [];
  received: Array<Record<string, unknown>> = [];
  closes: number[] = [];
  private inbox: Array<Record<string, unknown>> = [];
  private waiters: Array<(message: Record<string, unknown>) => void> = [];
  private connectionWaiters: Array<() => void> = [];
  private closeWaiters: Array<(code: number) => void> = [];

  constructor(readonly port: number) {
    this.server = createServer();
    this.server.on("upgrade", (request, socket: Socket) => {
      const key = String(request.headers["sec-websocket-key"]);
      socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${createHash("sha1").update(key + GUID).digest("base64")}`, "", ""].join("\r\n"));
      this.sockets.push(socket);
      let buffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        for (;;) {
          const frame = this.parse(buffer);
          if (!frame) break;
          buffer = buffer.subarray(frame.consumed);
          if (frame.opcode === 0x8) {
            const code = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
            this.closes.push(code);
            this.closeWaiters.shift()?.(code);
          }
          if (frame.opcode === 0x1) {
            const message = JSON.parse(frame.payload.toString("utf8")) as Record<string, unknown>;
            this.received.push(message);
            const waiter = this.waiters.shift();
            if (waiter) waiter(message); else this.inbox.push(message);
          }
        }
      });
      socket.on("error", () => undefined);
      this.connectionWaiters.shift()?.();
    });
  }

  private parse(buffer: Buffer): { opcode: number; payload: Buffer; consumed: number } | undefined {
    if (buffer.length < 2) return undefined;
    let length = buffer[1] & 0x7f;
    let offset = 2;
    if (length === 126) { if (buffer.length < 4) return undefined; length = buffer.readUInt16BE(2); offset = 4; }
    else if (length === 127) { if (buffer.length < 10) return undefined; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
    const masked = (buffer[1] & 0x80) !== 0;
    const total = offset + (masked ? 4 : 0) + length;
    if (buffer.length < total) return undefined;
    const mask = masked ? buffer.subarray(offset, offset + 4) : undefined;
    const payload = Buffer.from(buffer.subarray(offset + (masked ? 4 : 0), total));
    if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    return { opcode: buffer[0] & 0x0f, payload, consumed: total };
  }

  start(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.server.listen(this.port, "127.0.0.1", resolve);
    return promise;
  }
  stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.server.close(() => resolve());
    return promise;
  }
  /** Resolves with the next unread frame; a frame that already arrived is not lost. */
  nextMessage(): Promise<Record<string, unknown>> {
    const ready = this.inbox.shift();
    if (ready) return Promise.resolve(ready);
    const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
    this.waiters.push(resolve);
    return promise;
  }
  nextConnection(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.connectionWaiters.push(resolve);
    return promise;
  }
  nextClose(): Promise<number> {
    const { promise, resolve } = Promise.withResolvers<number>();
    this.closeWaiters.push(resolve);
    return promise;
  }
  get connection(): Socket { return this.sockets.at(-1)!; }

  sendText(text: string): void {
    const payload = Buffer.from(text, "utf8");
    const header = payload.length < 126 ? Buffer.from([0x81, payload.length])
      : payload.length < 65_536 ? Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff])
        : (() => { const value = Buffer.alloc(10); value[0] = 0x81; value[1] = 127; value.writeBigUInt64BE(BigInt(payload.length), 2); return value; })();
    this.connection.write(Buffer.concat([header, payload]));
  }

  /** Send a mobile message and return the desktop's response for that client. */
  async ask(clientId: string, payload: Record<string, unknown>): Promise<Record<string, any>> {
    const reply = this.nextMessage();
    this.sendText(JSON.stringify({ type: "mobile-message", clientId, payload }));
    const message = await reply;
    expect(message.type).toBe("desktop-response");
    expect(message.clientId).toBe(clientId);
    return message.payload as Record<string, any>;
  }
}

interface Harness {
  child: ChildProcess;
  relay: FakeRelay;
  httpPort: number;
  queue: string;
  trusted: string;
  snapshot: string;
  stderr: () => string;
  auth: Record<string, unknown>;
}

let harness: Harness;

async function launch(overrides: Record<string, string> = {}, waitForReady = true): Promise<Harness> {
  const directory = await mkdtemp(join(workspace, "run-"));
  const queue = join(directory, "queue");
  const snapshot = join(directory, "snapshot.json");
  const trusted = join(directory, "trusted.json");
  await mkdir(queue, { recursive: true });
  await writeFile(snapshot, JSON.stringify({
    projectName: "My film", resolution: "1920×1080", fps: 30, trackCount: 3, playhead: 1, playheadLabel: "00:01.00", status: "ready",
    previewId: "asset-1", previewKind: "video", previewPath: "/Users/someone/private/clip.mp4", secretPath: "/etc/shadow",
  }));
  const relay = new FakeRelay(await freePort());
  await relay.start();
  const httpPort = await freePort();
  const connected = relay.nextConnection();
  const child = spawn(process.execPath, [bundle], {
    env: {
      PATH: process.env.PATH ?? "", EDITKIN_REMOTE_TOKEN: bootstrapToken, EDITKIN_REMOTE_PORT: String(httpPort), EDITKIN_REMOTE_QUEUE: queue,
      EDITKIN_REMOTE_SNAPSHOT: snapshot, EDITKIN_REMOTE_DEVICES: join(directory, "devices.json"), EDITKIN_REMOTE_TRUSTED_DEVICES: trusted,
      EDITKIN_REMOTE_HEALTH_PROBE_ID: "f".repeat(32), EDITKIN_REMOTE_RELAY_WS_URL: `ws://127.0.0.1:${relay.port}/ws/${room}`,
      EDITKIN_REMOTE_RELAY_ROOM: room, EDITKIN_REMOTE_RELAY_SECRET: "s".repeat(48), ...overrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  child.stderr!.on("data", (chunk) => { errors += chunk; });
  let auth: Record<string, unknown> = {};
  if (waitForReady) {
    const ready = Promise.withResolvers<void>();
    child.stdout!.on("data", (chunk) => { if (String(chunk).includes("READY")) ready.resolve(); });
    child.once("exit", (code) => ready.reject(new Error(`remote server exited early (${code}): ${errors}`)));
    await ready.promise;
    await connected;
    auth = await relay.nextMessage();
  }
  return { child, relay, httpPort, queue, trusted, snapshot, stderr: () => errors, auth };
}

async function queued(): Promise<string[]> { return (await readdir(harness.queue)).filter((name) => name.endsWith(".json")); }
async function stop(current: Harness): Promise<void> {
  const exited = Promise.withResolvers<void>();
  if (current.child.exitCode !== null || current.child.signalCode !== null) exited.resolve(); else current.child.once("exit", () => exited.resolve());
  current.child.kill("SIGKILL");
  await exited.promise;
  await current.relay.stop();
}

describe("cloud relay authorization", () => {
  beforeEach(async () => { harness = await launch(); }, 20_000);
  afterEach(async () => { await stop(harness); });

  it("authenticates to the relay with its room secret before serving mobile messages", async () => {
    expect(harness.auth).toEqual({ type: "desktop-auth", room, secret: "s".repeat(48) });
  });

  it("rejects status and command from an unknown device without touching the queue", async () => {
    expect((await harness.relay.ask("c1", { type: "status", deviceId: "ghost", credential: "x".repeat(40) })).type).toBe("unauthorized");
    expect((await harness.relay.ask("c1", { type: "command", deviceId: "ghost", credential: "x".repeat(40), instruction: "undo" })).type).toBe("unauthorized");
    expect((await harness.relay.ask("c2", { type: "command", deviceId: "ghost", instruction: "undo" })).type).toBe("unauthorized");
    expect(await queued()).toEqual([]);
  });

  it("denies pairing with a wrong bootstrap token and stores no device", async () => {
    const denied = await harness.relay.ask("c1", { type: "pair", token: "wrong-token-of-any-length", deviceId: "phone-1" });
    expect(denied).toMatchObject({ type: "error" });
    expect(denied.credential).toBeUndefined();
    expect(await readFile(harness.trusted, "utf8").catch(() => "")).not.toContain("phone-1");
    expect((await harness.relay.ask("c1", { type: "status", deviceId: "phone-1" })).type).toBe("unauthorized");
  });

  it("rate limits pairing attempts across client ids the relay may rotate", async () => {
    let limited = false;
    for (let attempt = 0; attempt < 14; attempt += 1) {
      const reply = await harness.relay.ask(`rotating-${attempt}`, { type: "pair", token: "wrong-token-of-any-length", deviceId: "phone-1" });
      if (String(reply.error).includes("過多")) limited = true;
    }
    expect(limited).toBe(true);
  });

  it("queues a command only after pairing, and reveals only the allowlisted status fields", async () => {
    const paired = await harness.relay.ask("c1", { type: "pair", token: bootstrapToken, deviceId: "phone-1", name: "Phone" });
    expect(paired.type).toBe("paired");
    const credential = String(paired.credential);
    const accepted = await harness.relay.ask("c1", { type: "command", deviceId: "phone-1", credential, instruction: "undo" });
    expect(accepted.type).toBe("accepted");
    const files = await queued();
    expect(files).toHaveLength(1);
    expect(JSON.parse(await readFile(join(harness.queue, files[0]), "utf8"))).toMatchObject({ instruction: "undo" });

    const status = await harness.relay.ask("c1", { type: "status", deviceId: "phone-1", credential });
    expect(Object.keys(status).sort()).toEqual(["deviceName", "fps", "permanentlyPaired", "playhead", "playheadLabel", "previewAvailable", "projectName", "resolution", "status", "trackCount", "transport", "type"]);
    expect(status.previewAvailable).toBe(false);
    expect(JSON.stringify(status)).not.toMatch(/Users|shadow|asset-1|previewPath/);
  });

  it("rate limits commands per device even when the relay rotates client ids", async () => {
    const paired = await harness.relay.ask("c1", { type: "pair", token: bootstrapToken, deviceId: "phone-1" });
    const credential = String(paired.credential);
    const first = harness.relay.nextMessage();
    const second = harness.relay.nextMessage();
    for (const clientId of ["burst-a", "burst-b"]) {
      harness.relay.sendText(JSON.stringify({ type: "mobile-message", clientId, payload: { type: "command", deviceId: "phone-1", credential, instruction: "undo" } }));
    }
    const replies = [(await first).payload, (await second).payload] as Array<{ type: string }>;
    expect(replies.map((reply) => reply.type).sort()).toEqual(["accepted", "error"]);
    expect(await queued()).toHaveLength(1);
  });

  it("stops honouring a credential once the device is revoked", async () => {
    const paired = await harness.relay.ask("c1", { type: "pair", token: bootstrapToken, deviceId: "phone-1" });
    const credential = String(paired.credential);
    expect((await harness.relay.ask("c1", { type: "status", deviceId: "phone-1", credential })).type).toBe("status");
    await writeFile(harness.trusted, JSON.stringify({ schemaVersion: 1, devices: [] }));
    expect((await harness.relay.ask("c1", { type: "status", deviceId: "phone-1", credential })).type).toBe("unauthorized");
    expect((await harness.relay.ask("c1", { type: "command", deviceId: "phone-1", instruction: "undo" })).type).toBe("unauthorized");
    expect(await queued()).toEqual([]);
  });

  it("enforces the idle deadline for a remembered relay client", async () => {
    const paired = await harness.relay.ask("c1", { type: "pair", token: bootstrapToken, deviceId: "phone-1" });
    const credential = String(paired.credential);
    expect((await harness.relay.ask("c1", { type: "status", deviceId: "phone-1", credential })).type).toBe("status");
    const trusted = JSON.parse(await readFile(harness.trusted, "utf8"));
    trusted.devices[0].lastSeen = "2020-01-01T00:00:00Z";
    await writeFile(harness.trusted, JSON.stringify(trusted));
    expect((await harness.relay.ask("c1", { type: "status", deviceId: "phone-1" })).type).toBe("unauthorized");
    expect(JSON.parse(await readFile(harness.trusted, "utf8")).devices).toEqual([]);
    expect(await queued()).toEqual([]);
  });

  it("persists activity for a remembered relay client", async () => {
    const paired = await harness.relay.ask("c1", { type: "pair", token: bootstrapToken, deviceId: "phone-1" });
    const credential = String(paired.credential);
    await harness.relay.ask("c1", { type: "status", deviceId: "phone-1", credential });
    const trusted = JSON.parse(await readFile(harness.trusted, "utf8"));
    const before = new Date(Date.now() - 120_000).toISOString();
    trusted.devices[0].lastSeen = before;
    await writeFile(harness.trusted, JSON.stringify(trusted));
    expect((await harness.relay.ask("c1", { type: "status", deviceId: "phone-1" })).type).toBe("status");
    expect(Date.parse(JSON.parse(await readFile(harness.trusted, "utf8")).devices[0].lastSeen)).toBeGreaterThan(Date.parse(before));
  });

  it("does not let a client id remembered on one relay connection authorize on the next", async () => {
    const paired = await harness.relay.ask("c1", { type: "pair", token: bootstrapToken, deviceId: "phone-1" });
    const credential = String(paired.credential);
    // Same connection: after one credentialed request the desktop remembers the client id for credential-less follow-ups.
    expect((await harness.relay.ask("c1", { type: "status", deviceId: "phone-1", credential })).type).toBe("status");
    expect((await harness.relay.ask("c1", { type: "status", deviceId: "phone-1" })).type).toBe("status");
    const reconnected = harness.relay.nextConnection();
    harness.relay.connection.destroy();
    await reconnected;
    expect((await harness.relay.nextMessage()).type).toBe("desktop-auth");
    // New connection, same client id and device id, no credential: must not inherit the old session.
    expect((await harness.relay.ask("c1", { type: "command", deviceId: "phone-1", instruction: "undo" })).type).toBe("unauthorized");
    expect(await queued()).toEqual([]);
    // The real credential still works after reconnect.
    expect((await harness.relay.ask("c1", { type: "status", deviceId: "phone-1", credential })).type).toBe("status");
  }, 15_000);

  it("survives a WebSocket protocol error and reconnects without authorizing a device", async () => {
    const reconnected = harness.relay.nextConnection();
    const exited = new Promise<never>((_resolve, reject) => {
      harness.child.once("exit", (code) => reject(new Error(`remote crashed (${code}): ${harness.stderr()}`)));
    });
    // Server frames must not be masked. Drive the actual Node WebSocket error path.
    harness.relay.connection.write(Buffer.from([0x81, 0x80, 0, 0, 0, 0]));
    await Promise.race([reconnected, exited]);
    expect((await harness.relay.nextMessage()).type).toBe("desktop-auth");
    expect((await harness.relay.ask("c1", { type: "command", deviceId: "ghost", instruction: "undo" })).type).toBe("unauthorized");
    expect(await queued()).toEqual([]);
    expect(harness.stderr()).not.toMatch(/RangeError|Maximum call stack/);
  }, 15_000);

  it("keeps HTTP alive when the relay disappears and connection retries are refused", async () => {
    const exited = new Promise<never>((_resolve, reject) => {
      harness.child.once("exit", (code) => reject(new Error(`remote crashed (${code}): ${harness.stderr()}`)));
    });
    await harness.relay.stop();
    await Promise.race([new Promise((resolve) => setTimeout(resolve, 2_000)), exited]);
    expect(harness.child.exitCode).toBeNull();
    expect((await fetch(`http://127.0.0.1:${harness.httpPort}/api/status`)).status).toBe(401);
    expect(await queued()).toEqual([]);
    expect(harness.stderr()).not.toMatch(/RangeError|Maximum call stack/);
  }, 15_000);

  it.each([
    ["malformed JSON", () => "{not json"],
    ["unknown envelope", () => JSON.stringify({ type: "admin" })],
    ["oversized envelope", () => JSON.stringify({ type: "mobile-message", clientId: "c1", payload: { type: "command", deviceId: "d", instruction: "x", padding: "p".repeat(40_000) } })],
  ])("closes the relay connection on a %s and queues nothing", async (_name, message) => {
    const closed = harness.relay.nextClose();
    harness.relay.sendText(message());
    expect(await closed).toBe(4008);
    expect(await queued()).toEqual([]);
  });
});

describe("relay URL enforcement at startup", () => {
  it.each([
    ["a plain ws relay on a remote host", { EDITKIN_REMOTE_RELAY_WS_URL: `ws://relay.example.com/ws/${room}` }],
    ["a relay URL for a different room", { EDITKIN_REMOTE_RELAY_WS_URL: `wss://relay.example.com/ws/${"b".repeat(32)}` }],
    ["a relay URL that embeds credentials", { EDITKIN_REMOTE_RELAY_WS_URL: `wss://user:pw@relay.example.com/ws/${room}` }],
  ])("refuses to start with %s", async (_name, overrides) => {
    const attempt = await launch(overrides, false);
    const exited = Promise.withResolvers<number | null>();
    if (attempt.child.exitCode !== null) exited.resolve(attempt.child.exitCode); else attempt.child.once("exit", (value) => exited.resolve(value));
    const code = await exited.promise;
    await stop(attempt);
    expect(code).not.toBe(0);
    expect(attempt.stderr()).toMatch(/relay/);
  }, 20_000);
});

describe("LAN HTTP authorization", () => {
  beforeEach(async () => { harness = await launch(); }, 20_000);
  afterEach(async () => { await stop(harness); });

  const base = () => `http://127.0.0.1:${harness.httpPort}`;
  const json = (body: unknown, headers: Record<string, string> = {}) => ({
    method: "POST", headers: { "content-type": "application/json", origin: base(), ...headers }, body: JSON.stringify(body),
  });

  it("rejects commands and status without a device cookie and queues nothing", async () => {
    expect((await fetch(`${base()}/api/command`, json({ instruction: "undo" }))).status).toBe(401);
    expect((await fetch(`${base()}/api/status`)).status).toBe(401);
    expect((await fetch(`${base()}/api/command`, json({ instruction: "undo" }, { cookie: `editkin_remote_device=${"z".repeat(43)}` }))).status).toBe(401);
    expect(await queued()).toEqual([]);
  });

  it("rejects pairing with a wrong token or a cross-origin request", async () => {
    expect((await fetch(`${base()}/api/pair`, json({ token: "wrong-token-of-any-length", deviceId: "phone-1" }))).status).toBe(401);
    expect((await fetch(`${base()}/api/pair`, json({ token: bootstrapToken, deviceId: "phone-1" }, { origin: "http://evil.example" }))).status).toBe(403);
    expect(await readFile(harness.trusted, "utf8").catch(() => "")).not.toContain("phone-1");
  });

  it("pairs with the bootstrap token, then serves only the LAN status contract", async () => {
    const pair = await fetch(`${base()}/api/pair`, json({ token: bootstrapToken, deviceId: "phone-1", name: "Phone" }));
    expect(pair.status).toBe(201);
    const cookie = String(pair.headers.get("set-cookie")).split(";")[0];
    const command = await fetch(`${base()}/api/command`, json({ instruction: "undo" }, { cookie }));
    expect(command.status).toBe(202);
    expect(await queued()).toHaveLength(1);
    const status = await (await fetch(`${base()}/api/status`, { headers: { cookie } })).json() as Record<string, unknown>;
    expect(status).toMatchObject({ projectName: "My film", previewId: "asset-1", previewKind: "video", previewAvailable: true });
    expect(JSON.stringify(status)).not.toMatch(/Users|shadow|previewPath|secretPath/);
  });
});
