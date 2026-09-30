import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEVICE_IDLE_LIFETIME_MS, deviceIdleExpired, PairingWindow } from "./pairingPolicy";

describe("pairing window", () => {
  it("is single use and gives the token back only on release", () => {
    const window = new PairingWindow(10_000);
    expect(window.claim(1)).toBe(true);
    expect(window.isConsumed).toBe(true);
    expect(window.claim(2)).toBe(false);
    window.release();
    expect(window.isConsumed).toBe(false);
    expect(window.claim(3)).toBe(true);
  });

  it("expires at its deadline even when unused", () => {
    const window = new PairingWindow(10_000);
    expect(window.claim(10_001)).toBe(false);
    expect(window.isConsumed).toBe(false);
    expect(window.claim(10_000)).toBe(true);
  });
});

describe("device credential lifetime", () => {
  it("fails closed for invalid or future last-seen times", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(deviceIdleExpired("invalid-date", now)).toBe(true);
    expect(deviceIdleExpired("2026-01-02T00:00:00Z", now)).toBe(true);
    expect(deviceIdleExpired("2026-01-01T00:00:00Z", Number.NaN)).toBe(true);
  });
  it("expires after the idle lifetime, not before", () => {
    const seen = "2026-01-01T00:00:00.000Z";
    const base = Date.parse(seen);
    expect(deviceIdleExpired(seen, base + DEVICE_IDLE_LIFETIME_MS)).toBe(false);
    expect(deviceIdleExpired(seen, base + DEVICE_IDLE_LIFETIME_MS + 1)).toBe(true);
  });
});

describe("LAN remote server pairing", () => {
  const token = "0123456789abcdef0123456789abcdef";
  let root: string;
  let child: ChildProcess;
  let origin: string;
  let trustedPath: string;

  const allocatePort = () => new Promise<number>((resolvePort, reject) => {
    const allocator = createServer();
    allocator.once("error", reject);
    allocator.listen(0, "127.0.0.1", () => {
      const address = allocator.address();
      allocator.close(() => typeof address === "object" && address ? resolvePort(address.port) : reject(new Error("no port")));
    });
  });
  const pair = (deviceId: string, secret = token) => fetch(`${origin}/api/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ token: secret, deviceId, name: "Phone" }),
  });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "editkin-pairing-"));
    trustedPath = join(root, "trusted-devices.json");
    const bundle = join(root, "remote.mjs");
    await build({ entryPoints: [resolve("src/remote/server.ts")], bundle: true, platform: "node", target: "node22", format: "esm", outfile: bundle, logLevel: "silent" });
    await writeFile(join(root, "snapshot.json"), `${JSON.stringify({ projectName: "Pairing Test" })}\n`);
    const port = await allocatePort();
    origin = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [bundle], {
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...process.env,
        EDITKIN_REMOTE_TOKEN: token,
        EDITKIN_REMOTE_HEALTH_PROBE_ID: "1".repeat(32),
        EDITKIN_REMOTE_PORT: String(port),
        EDITKIN_REMOTE_QUEUE: join(root, "commands"),
        EDITKIN_REMOTE_SNAPSHOT: join(root, "snapshot.json"),
        EDITKIN_REMOTE_DEVICES: join(root, "devices.json"),
        EDITKIN_REMOTE_TRUSTED_DEVICES: trustedPath,
      },
    });
    const ready = Promise.withResolvers<void>();
    let output = "";
    child.stdout!.on("data", (chunk) => {
      output += chunk;
      if (output.includes('"status":"READY"')) ready.resolve();
    });
    child.once("exit", (code) => ready.reject(new Error(`remote server exited early: ${code}`)));
    await ready.promise;
  });

  afterAll(async () => {
    child?.kill();
    await rm(root, { recursive: true, force: true });
  });

  it("pairs exactly one device when the same token is submitted concurrently, then rejects replays", async () => {
    const attempts = await Promise.all(["phone-a", "phone-b", "phone-c"].map((id) => pair(id)));
    expect(attempts.map((response) => response.status).sort()).toEqual([201, 401, 401]);
    const winner = attempts.find((response) => response.status === 201)!;

    expect((await pair("phone-late")).status).toBe(401);
    const trusted = JSON.parse(await readFile(trustedPath, "utf8")) as { devices: Array<{ id: string }> };
    expect(trusted.devices).toHaveLength(1);
    expect(trusted.devices[0].id).not.toBe("phone-late");
    const devices = JSON.parse(await readFile(join(root, "devices.json"), "utf8")) as { pairingConsumed: boolean };
    expect(devices.pairingConsumed).toBe(true);

    const cookie = winner.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`Max-Age=${DEVICE_IDLE_LIFETIME_MS / 1000}`);
    expect(cookie).not.toContain("Secure");
    const status = await fetch(`${origin}/api/status`, { headers: { cookie: cookie.split(";", 1)[0] } });
    expect(status.status).toBe(200);
    expect(status.headers.get("set-cookie")).toContain(`Max-Age=${DEVICE_IDLE_LIFETIME_MS / 1000}`);
  });

  it("drops a device that was idle past the credential lifetime", async () => {
    const credential = "x".repeat(43);
    const stale = new Date(Date.now() - DEVICE_IDLE_LIFETIME_MS - 60_000).toISOString();
    await writeFile(trustedPath, `${JSON.stringify({
      schemaVersion: 1,
      devices: [{ id: "stale-phone", name: "Stale", credentialHash: createHash("sha256").update(credential).digest("hex"), pairedAt: stale, lastSeen: stale }],
    })}\n`);
    const denied = await fetch(`${origin}/api/status`, { headers: { cookie: `editkin_remote_device=${credential}` } });
    expect(denied.status).toBe(401);
    const trusted = JSON.parse(await readFile(trustedPath, "utf8")) as { devices: unknown[] };
    expect(trusted.devices).toEqual([]);
  });
});
