import { createHash } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseUpdateManifest, stageUpdate } from "./updateManager";
import { verifyStagedUpdateCache } from "./updateCache";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "editkin-update-cache-test-")));
  roots.push(root);
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "keep.bin"), Buffer.from([0, 127, 128, 255]));
  return { root, cacheRoot: join(root, "cache"), outside };
}
function manifest(bytes = Buffer.from("installer-fixture")) {
  return { schemaVersion: 1, version: "2.0.0", publishedAt: "2026-08-31T00:00:00Z", minimumProjectSchema: 3,
    windowsX64: { url: "https://updates.example/fixture.exe", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } };
}
function paths(cacheRoot: string, input = manifest()) {
  const directory = join(cacheRoot, `sha256-${input.windowsX64.sha256}`);
  return { directory, artifact: join(directory, "installer.exe") };
}
function options(cacheRoot: string, bytes = Buffer.from("installer-fixture")) {
  return { cacheRoot, currentVersion: "1.0.0", currentProjectSchema: 3, fetcher: vi.fn(async () => new Response(bytes)) };
}
async function outsideIntact(outside: string) {
  expect(await readdir(outside)).toEqual(["keep.bin"]);
  expect(await readFile(join(outside, "keep.bin"))).toEqual(Buffer.from([0, 127, 128, 255]));
}

describe("updater cache containment and ownership", () => {
  it("rejects a digest trailing newline before creating a cache directory", async () => {
    const { root, cacheRoot } = await fixture();
    const input = manifest();
    input.windowsX64.sha256 += "\n";
    const config = options(cacheRoot);
    const before = await readdir(root);
    await expect(stageUpdate(input, config)).rejects.toThrow(/欄位/);
    expect(config.fetcher).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(before);
  });
  it.each(["2.0.0-/../../escaped", "2.0.0-../../../../outside-cache", "2.0.0-..\\..\\outside", "2.0.0+%2f..", "2.0.0-C:evil", "2.0.0\n", "2.0.0-01", "02.0.0"])("rejects invalid version before any I/O: %j", async (version) => {
    const { root, cacheRoot } = await fixture();
    const input = { ...manifest(), version };
    const config = options(cacheRoot);
    const before = await readdir(root);
    expect(() => parseUpdateManifest(input)).toThrow(/SemVer/);
    await expect(stageUpdate(input, config)).rejects.toThrow(/SemVer/);
    expect(config.fetcher).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual(before);
  });

  it("uses a digest directory and fixed basename, with repeatable verified cache hits", async () => {
    const { cacheRoot } = await fixture();
    const bytes = Buffer.from("preview-installer");
    const input = { ...manifest(bytes), version: "2.0.0-rc.11+build.008" };
    const config = options(cacheRoot, bytes);
    const first = await stageUpdate(input, config);
    expect(first).toMatchObject({ artifactPath: paths(cacheRoot, input).artifact, size: bytes.length, cacheHit: false });
    expect((await lstat(first!.artifactPath)).nlink).toBe(1);
    expect(await readdir(paths(cacheRoot, input).directory)).toEqual(["installer.exe"]);
    const second = await stageUpdate(input, config);
    expect(second).toMatchObject({ artifactPath: first!.artifactPath, cacheHit: true });
    expect(config.fetcher).toHaveBeenCalledTimes(1);
  });

  it("revalidates staged bytes without writing or fetching before launch", async () => {
    const { cacheRoot } = await fixture();
    const config = options(cacheRoot);
    const staged = (await stageUpdate(manifest(), config))!;
    const before = await lstat(staged.artifactPath);
    await expect(verifyStagedUpdateCache(cacheRoot, staged)).resolves.toBeUndefined();
    expect((await lstat(staged.artifactPath)).mtimeMs).toBe(before.mtimeMs);
    expect(await readdir(paths(cacheRoot).directory)).toEqual(["installer.exe"]);
    expect(config.fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["changed-bytes", "missing", "hardlink", "wrong-path", "wrong-size", "bad-digest"])("refuses a staged %s at launch without repairing unknown files", async (kind) => {
    const { cacheRoot, outside } = await fixture();
    const staged = (await stageUpdate(manifest(), options(cacheRoot)))!;
    const sibling = join(outside, "installer.exe");
    if (kind === "changed-bytes") await writeFile(staged.artifactPath, "X".repeat(staged.size));
    if (kind === "missing") await rm(staged.artifactPath);
    if (kind === "hardlink") await link(staged.artifactPath, sibling);
    if (kind === "wrong-path") {
      await writeFile(sibling, "installer-fixture");
      staged.artifactPath = sibling;
    }
    if (kind === "wrong-size") staged.size += 1;
    if (kind === "bad-digest") staged.sha256 += "\n";
    const beforeCache = await readdir(paths(cacheRoot).directory);
    const beforeOutside = await readdir(outside);
    await expect(verifyStagedUpdateCache(cacheRoot, staged)).rejects.toThrow(/SHA-256|遺失|hardlink|路徑|大小不符|身分不合法/);
    expect(await readdir(paths(cacheRoot).directory)).toEqual(beforeCache);
    expect(await readdir(outside)).toEqual(beforeOutside);
    if (kind === "changed-bytes") expect(await readFile(staged.artifactPath, "utf8")).toBe("X".repeat(staged.size));
    if (kind === "wrong-path") expect(await readFile(sibling, "utf8")).toBe("installer-fixture");
  });

  it.each(["root", "ancestor", "digest-directory"])("rejects a %s junction before network or outside writes", async (kind) => {
    const { cacheRoot, outside, root } = await fixture();
    let selectedRoot = cacheRoot;
    if (kind === "root") await symlink(outside, cacheRoot, "junction");
    if (kind === "ancestor") {
      const alias = join(root, "alias");
      await symlink(outside, alias, "junction");
      selectedRoot = join(alias, "missing-child", "updates");
    }
    if (kind === "digest-directory") {
      await mkdir(cacheRoot);
      await symlink(outside, paths(cacheRoot).directory, "junction");
    }
    const config = options(selectedRoot);
    await expect(stageUpdate(manifest(), config)).rejects.toThrow(/junction/);
    expect(config.fetcher).not.toHaveBeenCalled();
    await outsideIntact(outside);
  });

  it.each(["hardlink", "file-symlink", "directory-junction"])("rejects cached artifact %s without removing it", async (kind) => {
    const { cacheRoot, outside } = await fixture();
    const input = manifest();
    const { directory, artifact } = paths(cacheRoot, input);
    const original = join(outside, "installer.exe");
    await writeFile(original, "installer-fixture");
    await mkdir(directory, { recursive: true });
    if (kind === "hardlink") await link(original, artifact);
    if (kind === "file-symlink") await symlink(original, artifact, "file");
    if (kind === "directory-junction") await symlink(outside, artifact, "junction");
    const before = await lstat(artifact);
    const config = options(cacheRoot);
    await expect(stageUpdate(input, config)).rejects.toThrow(/連結|hardlink/);
    expect(config.fetcher).not.toHaveBeenCalled();
    expect((await lstat(artifact)).ino).toBe(before.ino);
    expect(await readFile(original, "utf8")).toBe("installer-fixture");
    expect(await readdir(directory)).toEqual(["installer.exe"]);
  });

  it("preserves unknown/corrupted cached bytes instead of deleting and replacing them", async () => {
    const { cacheRoot } = await fixture();
    const { directory, artifact } = paths(cacheRoot);
    await mkdir(directory, { recursive: true });
    await writeFile(artifact, "unknown-user-file");
    const config = options(cacheRoot);
    await expect(stageUpdate(manifest(), config)).rejects.toThrow(/大小不符|SHA-256/);
    expect(await readFile(artifact, "utf8")).toBe("unknown-user-file");
    expect(config.fetcher).not.toHaveBeenCalled();
  });

  it("never clobbers a destination that appears while a download is pending", async () => {
    const { cacheRoot } = await fixture();
    const { directory, artifact } = paths(cacheRoot);
    await expect(stageUpdate(manifest(), { ...options(cacheRoot), fetcher: async () => {
      await writeFile(artifact, "appeared-during-download", { flag: "wx" });
      return new Response("installer-fixture");
    } })).rejects.toThrow(/EEXIST/);
    expect(await readFile(artifact, "utf8")).toBe("appeared-during-download");
    expect(await readdir(directory)).toEqual(["installer.exe"]);
  });

  it("serializes identical digests with an exclusive lock without taking over another run", async () => {
    const { cacheRoot } = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolveWait) => { release = resolveWait; });
    const started = new Promise<void>((resolveStart) => { entered = resolveStart; });
    const first = stageUpdate(manifest(), { ...options(cacheRoot), fetcher: async () => {
      entered(); await waiting; return new Response("installer-fixture");
    } });
    try {
      await started;
      const secondOptions = options(cacheRoot);
      await expect(stageUpdate(manifest(), secondOptions)).rejects.toThrow(/使用中/);
      expect(secondOptions.fetcher).not.toHaveBeenCalled();
    } finally { release(); }
    expect((await first)?.cacheHit).toBe(false);
    expect((await stageUpdate(manifest(), options(cacheRoot)))?.cacheHit).toBe(true);
  });

  it("keeps same-version different-digest receipts valid after concurrent staging", async () => {
    const { cacheRoot } = await fixture();
    const a = Buffer.from("candidate-A");
    const b = Buffer.from("candidate-B");
    const [first, second] = await Promise.all([
      stageUpdate(manifest(a), options(cacheRoot, a)), stageUpdate(manifest(b), options(cacheRoot, b)),
    ]);
    expect(first!.artifactPath).not.toBe(second!.artifactPath);
    expect(await readFile(first!.artifactPath)).toEqual(a);
    expect(await readFile(second!.artifactPath)).toEqual(b);
  });

  it("rejects network-await directory substitution without outside writes (OS lock or canonical guard)", async () => {
    const { cacheRoot, outside, root } = await fixture();
    const { directory } = paths(cacheRoot);
    let renameFailure: NodeJS.ErrnoException | undefined;
    let substituted = false;
    const failure = await stageUpdate(manifest(), { ...options(cacheRoot), fetcher: async () => {
      try { await rename(directory, join(root, "owned-directory-moved")); }
      catch (error) { renameFailure = error as NodeJS.ErrnoException; throw error; }
      await symlink(outside, directory, "junction");
      substituted = true;
      return new Response("installer-fixture");
    } }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    await outsideIntact(outside);
    if (substituted) {
      expect((failure as Error).message).toMatch(/junction/);
      expect((await lstat(directory)).isSymbolicLink()).toBe(true);
    } else {
      // An open owned handle can prevent this attack on Windows before the
      // guard is reached. This is OS protection, not proof of that guard branch.
      expect(process.platform).toBe("win32");
      expect(renameFailure?.code).toBe("EPERM");
      expect(await readdir(directory)).toEqual([]);
    }
  });

  it.each(["short", "overflow", "hash", "interrupted"])("cleans only its own temporary bytes after %s download", async (kind) => {
    const { cacheRoot } = await fixture();
    const input = manifest(Buffer.from("0123456789"));
    const fetcher = async () => {
      if (kind !== "interrupted") return new Response(kind === "short" ? "012" : kind === "overflow" ? "01234567890" : "ABCDEFGHIJ");
      let calls = 0;
      return new Response(new ReadableStream({ pull(controller) {
        if (calls++ === 0) controller.enqueue(new TextEncoder().encode("012"));
        else controller.error(new Error("fixture-stream-interrupted"));
      } }));
    };
    await expect(stageUpdate(input, { ...options(cacheRoot), fetcher })).rejects.toThrow(/大小不符|超過 manifest|SHA-256|fixture-stream-interrupted/);
    expect(await readdir(paths(cacheRoot, input).directory)).toEqual([]);
  });

  it("preserves foreign lock bytes and refuses relative, dot-alias and file cache roots", async () => {
    const { cacheRoot, root } = await fixture();
    const { directory } = paths(cacheRoot);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, ".stage.lock"), "foreign-lock");
    await expect(stageUpdate(manifest(), options(cacheRoot))).rejects.toThrow(/使用中/);
    expect(await readFile(join(directory, ".stage.lock"), "utf8")).toBe("foreign-lock");
    const fileRoot = join(root, "file");
    await writeFile(fileRoot, "keep");
    for (const invalid of ["relative-cache", join(root, "trailing."), fileRoot]) {
      await expect(stageUpdate(manifest(), options(invalid))).rejects.toThrow(/絕對路徑|別名|非正規/);
    }
    expect(await readFile(fileRoot, "utf8")).toBe("keep");
    expect(resolve(cacheRoot)).toBe(cacheRoot);
  });
});
