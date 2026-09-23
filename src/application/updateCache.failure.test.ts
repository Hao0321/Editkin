import { createHash } from "node:crypto";
import { mkdtemp, readdir, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stageUpdate } from "./updateManager";

const fault = vi.hoisted(() => ({ kind: "" as "" | "lock-stat" | "temp-stat" | "published-missing", closes: [] as string[] }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const path = String(args[0]);
      const selected = (fault.kind === "lock-stat" && path.endsWith(".stage.lock"))
        || (fault.kind === "temp-stat" && /\.download-.*\.tmp$/u.test(path));
      if (!selected) return handle;
      return new Proxy(handle, { get(target, property) {
        if (property === "stat") return async () => { throw new Error(`fixture-${fault.kind}`); };
        if (property === "close") return async () => { fault.closes.push(path); await target.close(); };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      await actual.link(...args);
      if (fault.kind === "published-missing") await actual.unlink(args[1]);
    },
  };
});

const roots: string[] = [];
afterEach(async () => {
  fault.kind = "";
  fault.closes.length = 0;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("updater cache I/O failures", () => {
  async function setup() {
    const root = await realpath(await mkdtemp(join(tmpdir(), "editkin-update-io-failure-")));
    roots.push(root);
    const bytes = Buffer.from("fixture-installer");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const input = { schemaVersion: 1, version: "2.0.0", publishedAt: "2026-08-31T00:00:00Z", minimumProjectSchema: 3,
      windowsX64: { url: "https://updates.example/fixture.exe", size: bytes.length, sha256 } };
    const fetcher = vi.fn(async () => new Response(bytes));
    return { root, directory: join(root, `sha256-${sha256}`), input,
      config: { cacheRoot: root, currentVersion: "1.0.0", currentProjectSchema: 3, fetcher } };
  }

  it.each(["lock-stat", "temp-stat"] as const)("closes newly opened handles when %s fails and preserves unidentified files", async (kind) => {
    const { directory, input, config } = await setup();
    fault.kind = kind;
    const error = await stageUpdate(input, config).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(`fixture-${kind}`);
    expect((error as Error & { cleanupFailure: Error }).cleanupFailure.message).toMatch(/身分未能確認/);
    expect(config.fetcher).not.toHaveBeenCalled();
    expect(fault.closes).toHaveLength(1);
    const entries = await readdir(directory);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatch(kind === "lock-stat" ? /^\.stage.lock$/u : /^\.download-.*\.tmp$/u);
    // The retained file has no confirmed identity, so the updater must not
    // delete it. A real rename here also checks there is no leaked Windows handle.
    await rename(join(directory, entries[0]), join(directory, "retained-for-inspection"));
  });

  it("does not report ready when the atomically published artifact disappears", async () => {
    const { directory, input, config } = await setup();
    fault.kind = "published-missing";
    await expect(stageUpdate(input, config)).rejects.toThrow(/更新檔遺失/);
    expect(await readdir(directory)).toEqual([]);
  });
});
