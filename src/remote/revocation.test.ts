import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEVICE_IDLE_LIFETIME_MS } from "./pairingPolicy";

const token = "0123456789abcdef0123456789abcdef";

interface Device { id: string; name: string; credentialHash: string; pairedAt: string; lastSeen: string }
interface Run { child: ChildProcess; origin: string; directory: string; trusted: string; revoked: string; status: string; readyAt: number }

let root: string;
let bundle: string;
let run: Run | undefined;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "editkin-revocation-"));
  bundle = join(root, "remote.mjs");
  await build({ entryPoints: [resolve("src/remote/server.ts")], bundle: true, platform: "node", target: "node22", format: "esm", outfile: bundle, logLevel: "silent" });
}, 60_000);
afterAll(async () => { await rm(root, { recursive: true, force: true }); });
afterEach(async () => {
  const current = run;
  run = undefined;
  if (!current || current.child.exitCode !== null || current.child.signalCode !== null) return;
  const exited = new Promise((done) => current.child.once("exit", done));
  current.child.kill("SIGKILL");
  await exited;
});

const credential = (seed: string) => seed.repeat(43);
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
function device(id: string, seed: string, lastSeen = minutesAgo(2)): Device {
  return { id, name: id, credentialHash: createHash("sha256").update(credential(seed)).digest("hex"), pairedAt: lastSeen, lastSeen };
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`);
  await rename(temporary, path);
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => typeof address === "object" && address ? resolvePort(address.port) : reject(new Error("no port")));
    });
  });
}

async function start(devices: Device[], revokedHashes?: string[]): Promise<Run> {
  const directory = await mkdtemp(join(root, "run-"));
  const trusted = join(directory, "trusted-devices.json");
  const revoked = join(directory, "revoked-devices.json");
  await writeJsonAtomic(trusted, { schemaVersion: 1, devices });
  if (revokedHashes) await writeJsonAtomic(revoked, { schemaVersion: 1, credentialHashes: revokedHashes });
  await writeFile(join(directory, "snapshot.json"), `${JSON.stringify({ projectName: "Revocation Test" })}\n`);
  await mkdir(join(directory, "commands"));
  const port = await freePort();
  const child = spawn(process.execPath, [bundle], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH ?? "",
      EDITKIN_REMOTE_TOKEN: token,
      EDITKIN_REMOTE_HEALTH_PROBE_ID: "2".repeat(32),
      EDITKIN_REMOTE_PORT: String(port),
      EDITKIN_REMOTE_QUEUE: join(directory, "commands"),
      EDITKIN_REMOTE_SNAPSHOT: join(directory, "snapshot.json"),
      EDITKIN_REMOTE_DEVICES: join(directory, "devices.json"),
      EDITKIN_REMOTE_TRUSTED_DEVICES: trusted,
    },
  });
  const ready = Promise.withResolvers<void>();
  let output = "";
  let errors = "";
  child.stdout!.on("data", (chunk) => { output += chunk; if (output.includes('"status":"READY"')) ready.resolve(); });
  child.stderr!.on("data", (chunk) => { errors += chunk; });
  child.once("exit", (code) => ready.reject(new Error(`remote server exited early (${code}): ${errors}`)));
  run = { child, origin: `http://127.0.0.1:${port}`, directory, trusted, revoked, status: join(directory, "devices.json"), readyAt: 0 };
  await ready.promise;
  run.readyAt = Date.now();
  return run;
}

/** The desktop's `revoke_mobile_device`: list the credential as revoked, then drop the device. */
async function revokeLikeDesktop(current: Run, revoked: Device, remaining: Device[], { listRevocation = true } = {}): Promise<void> {
  if (listRevocation) await writeJsonAtomic(current.revoked, { schemaVersion: 1, credentialHashes: [revoked.credentialHash] });
  await writeJsonAtomic(current.trusted, { schemaVersion: 1, devices: remaining });
}

async function status(current: Run, seed: string): Promise<number> {
  const response = await fetch(`${current.origin}/api/status`, { headers: { cookie: `editkin_remote_device=${credential(seed)}` } });
  await response.arrayBuffer();
  return response.status;
}

async function command(current: Run, seed: string): Promise<number> {
  const response = await fetch(`${current.origin}/api/command`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: current.origin, cookie: `editkin_remote_device=${credential(seed)}` },
    body: JSON.stringify({ instruction: "undo" }),
  });
  await response.arrayBuffer();
  return response.status;
}

async function pair(current: Run, deviceId: string): Promise<number> {
  const response = await fetch(`${current.origin}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: current.origin },
    body: JSON.stringify({ token, deviceId, name: "New phone" }),
  });
  await response.arrayBuffer();
  return response.status;
}

async function trustedIds(current: Run): Promise<string[]> {
  return (JSON.parse(await readFile(current.trusted, "utf8")) as { devices: Device[] }).devices.map((item) => item.id).sort();
}

async function listedIds(current: Run): Promise<string[]> {
  return (JSON.parse(await readFile(current.status, "utf8")) as { devices: Array<{ id: string }> }).devices.map((item) => item.id).sort();
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * The server also re-reads the trusted-device file for its status file every
 * 3 s, starting 3 s after READY. Begin a race only in that quiet stretch, so the
 * request under test is the only reader of the FIFO.
 */
async function quietStretch(current: Run): Promise<void> {
  if (Date.now() - current.readyAt < 1_000) return;
  const before = (await stat(current.status)).mtimeMs;
  for (const deadline = Date.now() + 5_000; (await stat(current.status)).mtimeMs === before;) {
    if (Date.now() > deadline) throw new Error("the device status file was not refreshed");
    await sleep(10);
  }
}

/** Opens the FIFO for writing once the server has opened it for reading. */
async function openWhenRead(fifo: string): Promise<FileHandle> {
  for (const deadline = Date.now() + 5_000; ;) {
    try {
      return await open(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENXIO" || Date.now() > deadline) throw error;
      await sleep(5);
    }
  }
}

/**
 * Makes `revoke` land between the server reading the trusted-device file and
 * acting on it. The file is swapped for a FIFO, so the server's next read stays
 * open until the test closes it; the server then receives `seen`, the store as it
 * was before the revoke, while the revoke is already on disk.
 */
async function revokeDuring(current: Run, seen: Device[], request: (current: Run) => Promise<number>, revoke: () => Promise<void>): Promise<number> {
  await quietStretch(current);
  const fifo = join(current.directory, "trusted.fifo");
  execFileSync("mkfifo", [fifo]);
  await rename(fifo, current.trusted);
  const [answer] = await Promise.all([request(current), (async () => {
    const writer = await openWhenRead(current.trusted);
    try {
      await writer.write(JSON.stringify({ schemaVersion: 1, devices: seen }));
      await revoke();
    } finally {
      await writer.close();
    }
  })()]);
  return answer;
}

describe.skipIf(process.platform === "win32")("revocation racing a trusted-device write", () => {
  const phone = device("phone", "p");
  const tablet = device("tablet", "t");
  const idle = device("idle-phone", "i", minutesAgo(DEVICE_IDLE_LIFETIME_MS / 60_000 + 60));

  it.each([
    {
      name: "another device's activity is recorded",
      before: [tablet, phone],
      after: [tablet],
      request: (current: Run) => status(current, "t"),
      answer: 200,
      kept: ["tablet"],
    },
    {
      name: "the revoked device's own activity is recorded",
      before: [tablet, phone],
      after: [tablet],
      request: (current: Run) => status(current, "p"),
      answer: undefined,
      kept: ["tablet"],
    },
    {
      name: "a new device pairs",
      before: [phone],
      after: [],
      request: (current: Run) => pair(current, "new-phone"),
      answer: 201,
      kept: ["new-phone"],
    },
    {
      name: "an idle device expires",
      before: [idle, phone],
      after: [idle],
      request: (current: Run) => status(current, "i"),
      answer: 401,
      kept: [],
    },
  ])("does not restore a device revoked while $name", async ({ before, after, request, answer, kept }) => {
    const current = await start(before);
    const reply = await revokeDuring(current, before, request, () => revokeLikeDesktop(current, phone, after));
    if (answer !== undefined) expect(reply).toBe(answer);
    expect(await status(current, "p")).toBe(401);
    expect(await command(current, "p")).toBe(401);
    expect(await readdir(join(current.directory, "commands"))).toEqual([]);
    expect(await trustedIds(current)).toEqual(kept);
  }, 20_000);

  it("rewrites the trusted-device file only from what is on disk, even without the revocation list", async () => {
    const current = await start([tablet, phone]);
    expect(await revokeDuring(current, [tablet, phone], (target) => status(target, "t"), () => revokeLikeDesktop(current, phone, [tablet], { listRevocation: false }))).toBe(200);
    expect(await status(current, "p")).toBe(401);
    expect(await trustedIds(current)).toEqual(["tablet"]);
  }, 20_000);
});

describe("revoked Remote devices", () => {
  it("rejects a revoked device on its next request", async () => {
    const phone = device("phone", "p");
    const tablet = device("tablet", "t");
    const current = await start([tablet, phone]);
    expect(await status(current, "p")).toBe(200);
    await revokeLikeDesktop(current, phone, [tablet]);
    expect(await status(current, "p")).toBe(401);
    expect(await command(current, "p")).toBe(401);
    expect(await readdir(join(current.directory, "commands"))).toEqual([]);
    expect(await status(current, "t")).toBe(200);
    expect(await trustedIds(current)).toEqual(["tablet"]);
  }, 20_000);

  it("keeps refusing a revoked credential that reappears in the trusted-device file", async () => {
    const phone = device("phone", "p");
    const tablet = device("tablet", "t");
    const current = await start([tablet, phone], [phone.credentialHash]);
    expect(await status(current, "p")).toBe(401);
    expect(await command(current, "p")).toBe(401);
    expect(await status(current, "t")).toBe(200);
    expect(await listedIds(current)).toEqual(["tablet"]);
    expect(await trustedIds(current)).toEqual(["tablet"]);
  }, 20_000);

  it("refuses every device and changes nothing while the revocation list cannot be read", async () => {
    const current = await start([device("tablet", "t")]);
    await writeFile(current.revoked, "not json");
    expect(await status(current, "t")).toBe(401);
    expect(await pair(current, "new-phone")).toBe(500);
    expect(await trustedIds(current)).toEqual(["tablet"]);
  }, 20_000);
});
