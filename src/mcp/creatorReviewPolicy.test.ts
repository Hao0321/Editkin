import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeReviewPolicy } from "../domain/reviewPolicy";
import { sha256Canonical } from "../application/autopilotInvocationIdentity";
import { readCreatorReviewPolicy, assertCreatorReviewPolicyCurrent, assertProjectReviewPolicy } from "./creatorReviewPolicy";
import { createEmptyProject } from "../domain/editGraph";
import { resolveAestheticSystemForDomain } from "../application/editkinAesthetic";
import { parseProject, acquireProjectLock, writeProjectFileAtomic } from "../application/projectFiles";

const roots: string[] = [];
async function fixture() { const root = await mkdtemp(join(tmpdir(), "editkin-policy-")); roots.push(root); return root; }
async function configure(root: string, input: unknown) {
  await mkdir(join(root, ".autopilot"), { recursive: true });
  await writeFile(join(root, ".autopilot", "creator-review-policy.json"), JSON.stringify(input));
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const policy = { mode: "agent_reference_comparison" as const, authorization: "明確授權 agent 自行完整對照參考審查" };

describe("workspace creator authority", () => {
  it("defaults to human only for absent configuration and preserves no completion claim", async () => {
    const root = await fixture();
    expect(await readCreatorReviewPolicy(root)).toEqual({ policy: { mode: "human" }, policySha256: sha256Canonical({ mode: "human" }) });
    await mkdir(join(root, ".autopilot"));
    expect((await readCreatorReviewPolicy(root)).policy).toEqual({ mode: "human" });
  });
  it("loads normalized Unicode authority and invalidates an earlier identity after revocation", async () => {
    const root = await fixture(); await configure(root, { ...policy, authorization: ` ${policy.authorization} ` });
    const first = await readCreatorReviewPolicy(root);
    expect(first).toEqual({ policy, policySha256: sha256Canonical(policy) });
    await configure(root, { mode: "human" });
    await expect(assertCreatorReviewPolicyCurrent(first, root)).rejects.toThrow(/changed/);
  });
  it("matches canonical Python Unicode whitespace rather than Javascript-only trim", () => {
    expect(normalizeReviewPolicy({ ...policy, authorization: `\u0085\u001c${policy.authorization}\u001f` })).toEqual(policy);
    expect(normalizeReviewPolicy({ ...policy, authorization: "\ufeff" })).toEqual({ ...policy, authorization: "\ufeff" });
    expect(normalizeReviewPolicy({ mode: "human", authorization: "\u0085" })).toEqual({ mode: "human" });
  });
  it.each([null, {}, { ...policy, authorization: " " }, { ...policy, extra: true }, { ...policy, authorization: "x".repeat(2001) }, { ...policy, authorization: ` ${"x".repeat(2000)} ` }, { mode: "invented" }])("rejects invalid policy instead of substituting human", async input => {
    const root = await fixture(); await configure(root, input);
    await expect(readCreatorReviewPolicy(root)).rejects.toThrow();
  });
  it("rejects malformed, oversized, and non-regular configuration", async () => {
    const root = await fixture(); await configure(root, policy);
    const path = join(root, ".autopilot", "creator-review-policy.json");
    await writeFile(path, "{"); await expect(readCreatorReviewPolicy(root)).rejects.toThrow();
    await writeFile(path, Buffer.concat([Buffer.from('{"mode":"human","authorization":"'), Buffer.from([0xff]), Buffer.from('"}') ]));
    await expect(readCreatorReviewPolicy(root)).rejects.toThrow();
    await writeFile(path, " ".repeat(8193)); await expect(readCreatorReviewPolicy(root)).rejects.toThrow();
    await rm(path); await mkdir(path); await expect(readCreatorReviewPolicy(root)).rejects.toThrow();
  });
  it("rejects a linked configuration directory even when its target is a workspace directory", async () => {
    const root = await fixture(), target = join(root, "different-authority"); await mkdir(target);
    await writeFile(join(target, "creator-review-policy.json"), JSON.stringify(policy));
    await symlink(target, join(root, ".autopilot"), process.platform === "win32" ? "junction" : "dir");
    await expect(readCreatorReviewPolicy(root)).rejects.toThrow(/real workspace/);
  });
  it("rejects a linked workspace root before using its policy", async () => {
    const root = await fixture(), target = join(root, "actual-workspace"), alias = join(root, "linked-workspace");
    await mkdir(target); await configure(target, policy);
    await symlink(target, alias, process.platform === "win32" ? "junction" : "dir");
    await expect(readCreatorReviewPolicy(alias)).rejects.toThrow(/ancestry/);
  });
  it("uses the same 2000 Unicode character policy in the saved project and inference path", async () => {
    const root = await fixture(), longPolicy = { ...policy, authorization: "🎬".repeat(2000) };
    // The file-byte budget is independent from the character budget.
    expect(normalizeReviewPolicy(longPolicy)).toEqual(longPolicy);
    await configure(root, longPolicy); expect((await readCreatorReviewPolicy(root)).policy).toEqual(longPolicy);
    const project = createEmptyProject(); project.aestheticSystem = resolveAestheticSystemForDomain("technology", "shorts", longPolicy);
    expect(parseProject(project).aestheticSystem?.reviewPolicy).toEqual(longPolicy);
    project.aestheticSystem = resolveAestheticSystemForDomain("technology", "shorts", policy);
    await configure(root, policy); const authority = await readCreatorReviewPolicy(root);
    expect(() => assertProjectReviewPolicy(project, authority)).not.toThrow();
    project.aestheticSystem = resolveAestheticSystemForDomain("technology", "shorts");
    expect(() => assertProjectReviewPolicy(project, authority)).toThrow(/differs/);
  });
  it.each([false, true])("rechecks revocation under the project commit lease (existing=%s)", async existing => {
    const root = await fixture(); await configure(root, policy);
    const authority = await readCreatorReviewPolicy(root), path = join(root, "current.editkin.json");
    const project = createEmptyProject();
    const before = existing ? await writeProjectFileAtomic(path, project, null) : undefined;
    const savedBytes = before ? await readFile(path, "utf8") : undefined;
    const release = await acquireProjectLock(path);
    let guardCalled = false;
    const pending = writeProjectFileAtomic(path, { ...project, name: "must not commit" }, before?.revision ?? null, {
      beforeCommit: async () => { guardCalled = true; await assertCreatorReviewPolicyCurrent(authority, root); },
    });
    const rejected = expect(pending).rejects.toThrow(/authorization changed/);
    try {
      await configure(root, { mode: "human" });
      expect(guardCalled).toBe(false);
    } finally { await release(); }
    await rejected;
    expect(guardCalled).toBe(true);
    if (savedBytes) expect(await readFile(path, "utf8")).toBe(savedBytes);
    else await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(root)).some(name => name.endsWith(".tmp"))).toBe(false);
  });
});
