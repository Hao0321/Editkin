import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("LAN remote server preview and Host handling", () => {
  let root: string;
  let child: ChildProcess;
  let port: number;
  let snapshotPath: string;
  const previewPath = () => join(root, "clip.mp4");
  const credential = "p".repeat(43);

  const allocatePort = () => new Promise<number>((resolvePort, reject) => {
    const allocator = createServer();
    allocator.once("error", reject);
    allocator.listen(0, "127.0.0.1", () => {
      const address = allocator.address();
      allocator.close(() => typeof address === "object" && address ? resolvePort(address.port) : reject(new Error("no port")));
    });
  });
  const get = (path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: Buffer; headers: Record<string, unknown> }>((resolveResponse, reject) => {
    const outgoing = httpRequest({ host: "127.0.0.1", port, path, headers: { cookie: `editkin_remote_device=${credential}`, ...headers } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolveResponse({ status: response.statusCode ?? 0, body: Buffer.concat(chunks), headers: response.headers }));
      response.on("error", reject);
    });
    outgoing.on("error", reject);
    outgoing.end();
  });

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "editkin-preview-"));
    snapshotPath = join(root, "snapshot.json");
    await writeFile(previewPath(), Buffer.from("0123456789abcdefghij"));
    await writeFile(snapshotPath, JSON.stringify({ projectName: "Preview", previewPath: previewPath(), previewKind: "video" }));
    const now = new Date().toISOString();
    const { createHash } = await import("node:crypto");
    await writeFile(join(root, "trusted.json"), JSON.stringify({
      schemaVersion: 1,
      devices: [{ id: "phone", name: "Phone", credentialHash: createHash("sha256").update(credential).digest("hex"), pairedAt: now, lastSeen: now }],
    }));
    const bundle = join(root, "remote.mjs");
    await build({ entryPoints: [resolve("src/remote/server.ts")], bundle: true, platform: "node", target: "node22", format: "esm", outfile: bundle, logLevel: "silent" });
    port = await allocatePort();
    child = spawn(process.execPath, [bundle], {
      stdio: ["ignore", "pipe", "ignore"],
      env: {
        ...process.env,
        EDITKIN_REMOTE_TOKEN: "t".repeat(32),
        EDITKIN_REMOTE_HEALTH_PROBE_ID: "1".repeat(32),
        EDITKIN_REMOTE_PORT: String(port),
        EDITKIN_REMOTE_QUEUE: join(root, "commands"),
        EDITKIN_REMOTE_SNAPSHOT: snapshotPath,
        EDITKIN_REMOTE_DEVICES: join(root, "devices.json"),
        EDITKIN_REMOTE_TRUSTED_DEVICES: join(root, "trusted.json"),
        EDITKIN_REMOTE_ALLOWED_HOSTS: "editkin.example.com",
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
    await chmod(previewPath(), 0o600).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  it("serves the last N bytes for a suffix range and the whole file otherwise", async () => {
    const suffix = await get("/api/preview", { range: "bytes=-5" });
    expect(suffix.status).toBe(206);
    expect(suffix.body.toString()).toBe("fghij");
    expect(suffix.headers["content-range"]).toBe("bytes 15-19/20");
    const middle = await get("/api/preview", { range: "bytes=2-4" });
    expect(middle.body.toString()).toBe("234");
    const whole = await get("/api/preview");
    expect(whole.status).toBe(200);
    expect(whole.body.toString()).toBe("0123456789abcdefghij");
    expect((await get("/api/preview", { range: "bytes=50-" })).status).toBe(416);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("survives a preview file that cannot be opened after stat", async () => {
    await chmod(previewPath(), 0o000);
    await get("/api/preview").catch(() => undefined);
    await chmod(previewPath(), 0o600);
    expect(child.exitCode).toBeNull();
    expect((await get("/api/health")).status).toBe(200);
  });

  it("answers 404 instead of streaming when the preview path is not a regular file", async () => {
    await writeFile(snapshotPath, JSON.stringify({ previewPath: root, previewKind: "video" }));
    expect((await get("/api/preview")).status).toBe(404);
  });

  it("rejects a Host that is neither an IP literal, localhost nor advertised", async () => {
    expect((await get("/api/health", { host: `attacker.example:${port}` })).status).toBe(421);
    expect((await get("/api/health", { host: `editkin.example.com` })).status).toBe(200);
    expect((await get("/api/health", { host: `127.0.0.1:${port}` })).status).toBe(200);
  });
});
