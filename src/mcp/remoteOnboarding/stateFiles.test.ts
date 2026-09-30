import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_JSON_BYTES } from "./constants";
import { ProposalAlreadyExistsError, readJson, remoteSetupPaths, writeJsonAtomic, writeJsonCreateNew } from "./stateFiles";

const temporaryRoot = () => mkdtemp(join(tmpdir(), "editkin-remote-state-"));

describe("remote onboarding state files", () => {
  it("derives receipt paths only from an absolute agent-runtime-v3 state root", async () => {
    const root = await temporaryRoot();
    const paths = remoteSetupPaths({ EDITKIN_AGENT_STATE_ROOT: join(root, "agent-runtime-v3") });
    expect(paths.root).toBe(join(root, "mobile-remote"));
    expect(paths.pendingRenewing).toBe(`${paths.pending}.renewing`);
    expect(() => remoteSetupPaths({})).toThrow("state root");
    expect(() => remoteSetupPaths({ EDITKIN_AGENT_STATE_ROOT: "relative/agent-runtime-v3" })).toThrow("state root");
    expect(() => remoteSetupPaths({ EDITKIN_AGENT_STATE_ROOT: join(root, "agent-runtime-v2") })).toThrow("generation");
  });

  it("reads missing files as absent but rejects symlinks and oversized files", async () => {
    const root = await temporaryRoot();
    const file = join(root, "receipt.json");
    expect(await readJson(file)).toBeUndefined();
    await writeFile(file, '{"ok":true}');
    expect(await readJson(file)).toEqual({ ok: true });
    await symlink(file, join(root, "link.json"));
    await expect(readJson(join(root, "link.json"))).rejects.toThrow("symlink");
    await writeFile(join(root, "big.json"), " ".repeat(MAX_JSON_BYTES + 1));
    await expect(readJson(join(root, "big.json"))).rejects.toThrow();
  });

  it("publishes create-new receipts without replacing an existing one or leaving temporaries", async () => {
    const root = await temporaryRoot();
    const file = join(root, "state", "pending.json");
    await writeJsonCreateNew(file, { revision: 1 });
    await expect(writeJsonCreateNew(file, { revision: 2 })).rejects.toBeInstanceOf(ProposalAlreadyExistsError);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ revision: 1 });
    expect(await readdir(join(root, "state"))).toEqual(["pending.json"]);
    await expect(writeJsonCreateNew(join(root, "state", "huge.json"), "x".repeat(MAX_JSON_BYTES))).rejects.toThrow("大小");
    expect(await readdir(join(root, "state"))).toEqual(["pending.json"]);
  });

  it("atomically replaces regular files but refuses symlink destinations and symlinked parents", async () => {
    const root = await temporaryRoot();
    const file = join(root, "config.json");
    await writeJsonAtomic(file, { revision: 1 });
    await writeJsonAtomic(file, { revision: 2 });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ revision: 2 });
    await symlink(file, join(root, "link.json"));
    await expect(writeJsonAtomic(join(root, "link.json"), { revision: 3 })).rejects.toThrow("symlink");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ revision: 2 });
    await mkdir(join(root, "real"));
    await symlink(join(root, "real"), join(root, "parent-link"));
    await expect(writeJsonAtomic(join(root, "parent-link", "x.json"), {})).rejects.toThrow("symlink");
    expect(await readdir(join(root, "real"))).toEqual([]);
  });
});
