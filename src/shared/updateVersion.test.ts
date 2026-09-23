import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_UPDATE_VERSION_LENGTH, compareUpdateVersions, parseUpdateVersion } from "./updateVersion.mjs";

const invalidVersions: unknown[] = [
  undefined, null, 1, true, {}, [], new String("1.2.3"), "", "1", "1.2", "1.2.3.4", "v1.2.3",
  "01.2.3", "1.02.3", "1.2.03", "1.2.3-01", "1.2.3-alpha.01", "1.2.3-", "1.2.3+",
  "1.2.3-alpha..beta", "1.2.3+build..sha", "1.2.3-.alpha", "1.2.3+build.", "1.2.3+a+b",
  "../1.2.3", "1.2.3-../../escape", "1.2.3+../../escape", "1.2.3-..", "1.2.3+..",
  "1.2.3-..\\escape", "1.2.3+..\\escape", "1.2.3-C:escape", "1.2.3+file:stream",
  "1.2.3-%2fescape", "1.2.3+%5cescape", "1.2.3-%2e%2e", "1.2.3-alpha_beta",
  "1.2.3\n", "1.2.3\r\n", "1.2.3-alpha\n", "1.2.3+build\n", "1.2.3\0", "1.2.3-\talpha",
  " 1.2.3", "1.2.3 ", "1.2.3+build space", "１.2.3", "1.2.3-α", "1.2.3+更新", "1.2.3-😀",
  "1.2.3-\u2028", "1.2.3-\u2029", "1.2.3-\ufeff", "1.2.3-\u200b", "1.2.3+" + "a".repeat(251),
];

describe("bounded strict update SemVer", () => {
  it.each(invalidVersions.map((value, index) => ({ value, index })))("rejects invalid input $index without coercion", ({ value }) => {
    expect(() => parseUpdateVersion(value, "test version")).toThrow(/test version.*SemVer 2\.0/u);
  });

  it("parses core, prerelease and build without losing identifiers", () => {
    expect(parseUpdateVersion("12.34.56-alpha.0.01a.-+001.sha--.ABC")).toEqual({
      core: ["12", "34", "56"], prerelease: ["alpha", "0", "01a", "-"], build: ["001", "sha--", "ABC"],
    });
    expect(parseUpdateVersion("0.0.0")).toEqual({ core: ["0", "0", "0"], prerelease: [], build: [] });
    expect(parseUpdateVersion("1.0.0-x-y-z.--").prerelease).toEqual(["x-y-z", "--"]);
    expect(parseUpdateVersion("1.0.0+21AF26D3----117B344092BD").build).toEqual(["21AF26D3----117B344092BD"]);
  });

  it("enforces the explicit 256-character update-policy boundary", () => {
    expect(MAX_UPDATE_VERSION_LENGTH).toBe(256);
    const exact = "1.2.3+" + "a".repeat(250);
    expect(exact).toHaveLength(256);
    expect(parseUpdateVersion(exact).build[0]).toHaveLength(250);
    expect(() => parseUpdateVersion(exact + "a")).toThrow(/SemVer 2\.0/u);
  });

  it("matches the official SemVer precedence chain in both directions", () => {
    const chain = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "2.0.0", "2.1.0", "2.1.1"];
    for (let left = 0; left < chain.length; left += 1) {
      for (let right = 0; right < chain.length; right += 1) {
        expect(compareUpdateVersions(chain[left], chain[right])).toBe(left === right ? 0 : left < right ? -1 : 1);
      }
    }
  });

  it.each([
    ["9007199254740992.0.0", "9007199254740993.0.0"],
    ["0.9007199254740992.0", "0.9007199254740993.0"],
    ["0.0.9007199254740992", "0.0.9007199254740993"],
    ["1.0.0-9007199254740992", "1.0.0-9007199254740993"],
    ["1.0.0-9", "1.0.0-10"], ["1.0.0-99999999999999999999", "1.0.0-100000000000000000000"],
    ["1.0.0-999999999999999999999", "1.0.0--"], ["1.0.0-Z", "1.0.0-a"], ["1.0.0-a", "1.0.0-a.0"],
    ["1".repeat(251) + ".0.0", "1".repeat(252) + ".0.0"],
  ])("orders %s below %s without Number precision loss", (left, right) => {
    expect(compareUpdateVersions(left, right)).toBe(-1);
    expect(compareUpdateVersions(right, left)).toBe(1);
  });

  it("ignores build metadata for precedence but still validates it", () => {
    expect(compareUpdateVersions("1.2.3+a", "1.2.3+b")).toBe(0);
    expect(compareUpdateVersions("1.2.3-rc.1+001", "1.2.3-rc.1")).toBe(0);
    expect(() => compareUpdateVersions("1.2.3", "1.2.3+..")).toThrow(/SemVer 2\.0/u);
    expect(() => compareUpdateVersions("01.2.3", "1.2.3")).toThrow(/SemVer 2\.0/u);
  });
});

async function inventory(root: string): Promise<unknown[]> {
  const entries: unknown[] = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) entries.push({ name: entry.name, directory: await inventory(path) });
    else entries.push({ name: entry.name, sha256: createHash("sha256").update(await readFile(path)).digest("hex") });
  }
  return entries;
}

describe("update channel CLI version boundary", () => {
  it("rejects malformed versions before artifact inspection or output mutation and accepts an inert positive fixture", async () => {
    const root = await mkdtemp(join(tmpdir(), "editkin-update-version-"));
    const appRoot = fileURLToPath(new URL("../../", import.meta.url));
    const node = resolve(appRoot, "vendor/node/win32-x64/node.exe");
    const script = resolve(appRoot, "scripts/update-channel.mjs");
    const output = resolve(root, "existing-output.json");
    try {
      await writeFile(output, "existing user bytes must survive\n");
      await mkdir(resolve(root, "keep"));
      await writeFile(resolve(root, "keep/sentinel.bin"), Buffer.from([0, 17, 128, 255]));
      const before = await inventory(root);
      for (const version of invalidVersions.filter((value): value is string => typeof value === "string" && !value.includes("\0"))) {
        const result = spawnSync(node, [script, "--version", version, "--artifact", resolve(root, "missing-installer.exe"),
          "--artifact-url", "https://example.invalid/installer.exe", "--published-at", "2026-08-31T00:00:00Z", "--output", output],
        { cwd: root, shell: false, windowsHide: true, encoding: "utf8", timeout: 5_000 });
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/--version must be a strict SemVer 2\.0/u);
        expect(result.stderr).not.toMatch(/ENOENT|Authenticode/u);
        expect(await inventory(root)).toEqual(before);
      }
      const artifact = resolve(root, "inert-fixture.bin");
      await writeFile(artifact, "inert version boundary fixture");
      const positiveOutput = resolve(root, "positive/channel.json");
      const positive = spawnSync(node, [script, "--version", "1.2.3-rc.1+001", "--artifact", artifact,
        "--artifact-url", "https://example.invalid/installer.exe", "--published-at", "2026-08-31T00:00:00Z", "--output", positiveOutput],
      { cwd: root, shell: false, windowsHide: true, encoding: "utf8", timeout: 5_000 });
      expect(positive.error).toBeUndefined();
      expect(positive.status, positive.stderr).toBe(0);
      expect(JSON.parse(positive.stdout).status).toBe("INTERNAL_ONLY_UNSIGNED");
      expect(JSON.parse(await readFile(positiveOutput, "utf8")).version).toBe("1.2.3-rc.1+001");
      expect(await readFile(output, "utf8")).toBe("existing user bytes must survive\n");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
