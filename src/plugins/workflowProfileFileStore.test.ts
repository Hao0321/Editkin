import { access, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { discoverInstalledPlugins, installedSkillPackCandidates } from "./registry";
import {
  assertWorkflowProfileMatchesRegistry,
  readHostWorkflowProfile,
  safeEmptyWorkflowProfile,
  writeHostWorkflowProfileAtomic,
} from "./workflowProfileFileStore";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "editkin-workflow-profile-"));
  roots.push(root);
  const registry = await discoverInstalledPlugins([join(process.cwd(), "plugins")]);
  const skill = installedSkillPackCandidates(registry)[0];
  if (!skill) throw new Error("fixture 缺少 bundled Workflow Skill");
  const profile = {
    ...safeEmptyWorkflowProfile(),
    id: "creator-workflow",
    enabledSkills: [skill.skillId],
    priority: [skill.skillId],
    grants: [{ skillId: skill.skillId, manifestSha256: skill.manifestSha256, packSha256: skill.packSha256, permissions: ["workflow.read" as const] }],
    conflictPolicy: "profile_priority" as const,
  };
  return { root, path: join(root, "workflow-profile.json"), registry, skill, profile };
}

describe("host Workflow Profile file store", () => {
  it("falls back only to an empty fail-closed profile when the host path is absent", async () => {
    await expect(readHostWorkflowProfile("")).resolves.toEqual({ configured: false, profile: safeEmptyWorkflowProfile() });
  });

  it("atomically persists an exact manifest/pack grant and reopens it", async () => {
    const { path, registry, profile } = await fixture();
    const saved = await writeHostWorkflowProfileAtomic(profile, registry, path);
    expect(saved.profile).toEqual(profile);
    await expect(readHostWorkflowProfile(path)).resolves.toMatchObject({ configured: true, profile });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(profile);
  });

  it("rejects stale grants, arbitrary enabled skills and grants for disabled skills", async () => {
    const { registry, profile, skill } = await fixture();
    expect(() => assertWorkflowProfileMatchesRegistry({ ...profile, grants: [{ ...profile.grants[0], packSha256: "0".repeat(64) }] }, registry)).toThrow();
    expect(() => assertWorkflowProfileMatchesRegistry({ ...profile, enabledSkills: ["evil.plugin/arbitrary"], priority: ["evil.plugin/arbitrary"], grants: [{ skillId: "evil.plugin/arbitrary", manifestSha256: "0".repeat(64), packSha256: "1".repeat(64), permissions: ["workflow.read"] }] }, registry)).toThrow();
    expect(() => assertWorkflowProfileMatchesRegistry({ ...profile, enabledSkills: [], priority: [], grants: [{ ...profile.grants[0], skillId: skill.skillId }] }, registry)).toThrow();
  });

  it("rejects symlink profile files instead of following them", async () => {
    const { root, path } = await fixture();
    const target = join(root, "target.json");
    await writeFile(target, JSON.stringify(safeEmptyWorkflowProfile()), "utf8");
    await symlink(target, path, "file");
    await expect(readHostWorkflowProfile(path)).rejects.toThrow(/symlink/);
  });

  it("recovers an interrupted atomic write without overwriting a newer profile", async () => {
    const { path, profile } = await fixture();
    await writeFile(`${path}.previous`, `${JSON.stringify(profile)}\n`, "utf8");
    await expect(readHostWorkflowProfile(path)).resolves.toMatchObject({ configured: true, profile });
    await expect(access(path)).resolves.toBeUndefined();
    await expect(access(`${path}.previous`)).rejects.toThrow();
  });

  it("rejects a forged symlink recovery file", async () => {
    const { root, path } = await fixture();
    const target = join(root, "target.json");
    await writeFile(target, JSON.stringify(safeEmptyWorkflowProfile()), "utf8");
    await symlink(target, `${path}.previous`, "file");
    await expect(readHostWorkflowProfile(path)).rejects.toThrow(/previous recovery/);
  });
});
