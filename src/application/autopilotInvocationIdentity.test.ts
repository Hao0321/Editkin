import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEmptyProject } from "../domain/editGraph";
import {
  AUTOPILOT_AUDIT_RECEIPT_MAX_PENDING,
  AUTOPILOT_AUDIT_RECEIPT_TTL_MS,
  assertAutopilotPlanSourceCurrent,
  autopilotPlanSourceFromIdentity,
  consumeAcceptedAutopilotAuditReceipt,
  createAcceptedAutopilotAuditReceipt,
  createAutopilotProjectAuditIdentity,
  readLiveAutopilotIdentity,
  sha256Canonical,
  verifyAcceptedAutopilotAuditReceipt,
} from "./autopilotInvocationIdentity";

async function skillFixture(input: { rule?: number; workflowRevision?: number; legacyPolicy?: string; planHashAlgorithm?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "editkin-autopilot-identity-"));
  const skillPath = join(root, "SKILL.md");
  await writeFile(skillPath, `---\nname: video-autopilot\n---\n- M1: base\n- M${input.rule ?? 12}: current\n`, "utf8");
  await writeFile(join(root, "workflow_contract.json"), JSON.stringify({
    schema: "hao.video-autopilot.workflow-contract/v1",
    contract_revision: input.workflowRevision ?? 2,
    plan_schema: "hao.video-autopilot.edit-plan/v4",
    plan_hash_algorithm: input.planHashAlgorithm,
    legacy_plan_policy: input.legacyPolicy ?? "reject",
  }), "utf8");
  const plugins = join(root, "plugins");
  await mkdir(plugins);
  return { root, skillPath, plugins };
}

describe("live Video Autopilot invocation identity", () => {
  it("admits the shared plan hash algorithm and rejects an incompatible declared algorithm", async () => {
    const current = await skillFixture({ planHashAlgorithm: "sha256-canonical-json-utf8-keys-v1" });
    await expect(readLiveAutopilotIdentity({ skillPath: current.skillPath, pluginRoots: [current.plugins] })).resolves.toHaveProperty("bindingSha256");
    const incompatible = await skillFixture({ planHashAlgorithm: "sha256-insertion-order" });
    await expect(readLiveAutopilotIdentity({ skillPath: incompatible.skillPath, pluginRoots: [incompatible.plugins] })).rejects.toThrow(/hash algorithm/);
  });
  it("binds the actual Skill, canonical workflow, shipped knowledge and discovered plugin registry", async () => {
    const fixture = await skillFixture();
    const identity = await readLiveAutopilotIdentity({ skillPath: fixture.skillPath, pluginRoots: [fixture.plugins] });
    expect(identity.skill).toMatchObject({ id: "video-autopilot", revision: 12, hardRuleCount: 2 });
    expect(identity.workflow).toMatchObject({ revision: 2, legacyPlanPolicy: "reject", planSchema: "hao.video-autopilot.edit-plan/v4" });
    expect(identity.knowledge).toMatchObject({ revision: 1, stableRuleCount: 1, includedModuleCount: 1 });
    expect(identity.plugins).toMatchObject({ pluginCount: 0, diagnosticCount: 0 });
    expect(identity.bindingSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes identity on Skill, workflow or plugin registry drift and rejects a non-reject legacy policy", async () => {
    const first = await skillFixture();
    const skillDrift = await skillFixture({ rule: 13 });
    const workflowDrift = await skillFixture({ workflowRevision: 3 });
    const [baseIdentity, skillIdentity, workflowIdentity] = await Promise.all([
      readLiveAutopilotIdentity({ skillPath: first.skillPath, pluginRoots: [first.plugins] }),
      readLiveAutopilotIdentity({ skillPath: skillDrift.skillPath, pluginRoots: [skillDrift.plugins] }),
      readLiveAutopilotIdentity({ skillPath: workflowDrift.skillPath, pluginRoots: [workflowDrift.plugins] }),
    ]);
    expect(skillIdentity.skill.sha256).not.toBe(baseIdentity.skill.sha256);
    expect(skillIdentity.bindingSha256).not.toBe(baseIdentity.bindingSha256);
    expect(workflowIdentity.workflow.sha256).not.toBe(baseIdentity.workflow.sha256);
    expect(workflowIdentity.bindingSha256).not.toBe(baseIdentity.bindingSha256);

    await writeFile(join(first.plugins, "editkin-plugin.json"), "{}", "utf8");
    const pluginIdentity = await readLiveAutopilotIdentity({ skillPath: first.skillPath, pluginRoots: [first.plugins] });
    expect(pluginIdentity.plugins.diagnosticCount).toBe(1);
    expect(pluginIdentity.plugins.sha256).not.toBe(baseIdentity.plugins.sha256);
    expect(pluginIdentity.bindingSha256).not.toBe(baseIdentity.bindingSha256);

    const unsafe = await skillFixture({ legacyPolicy: "allow" });
    await expect(readLiveAutopilotIdentity({ skillPath: unsafe.skillPath, pluginRoots: [unsafe.plugins] })).rejects.toThrow(/拒絕 legacy/);
  });

  it("fails closed on every plan source identity field", async () => {
    const fixture = await skillFixture();
    const identity = await readLiveAutopilotIdentity({ skillPath: fixture.skillPath, pluginRoots: [fixture.plugins] });
    const source = autopilotPlanSourceFromIdentity(identity);
    expect(() => assertAutopilotPlanSourceCurrent(source, identity)).not.toThrow();
    for (const key of [
      "skillSha256", "workflowContractRevision", "workflowContractSha256", "knowledgeRevision", "knowledgeSha256",
      "stableRulesSha256", "pluginRegistrySha256", "invocationBindingSha256",
    ] as const) {
      const value = source[key];
      const drifted = { ...source, [key]: typeof value === "number" ? value + 1 : "0".repeat(64) };
      expect(() => assertAutopilotPlanSourceCurrent(drifted, identity), key).toThrow(new RegExp(key));
    }
  });

  it("requires an untampered accepted receipt for the same plan, project revision and live invocation", async () => {
    const fixture = await skillFixture();
    const invocation = await readLiveAutopilotIdentity({ skillPath: fixture.skillPath, pluginRoots: [fixture.plugins] });
    const project = createEmptyProject("Receipt", { id: "project-receipt", width: 1920, height: 1080, fps: 30 });
    const projectIdentity = createAutopilotProjectAuditIdentity(join(fixture.root, "receipt.editkin.json"), project);
    const materialEvidence = { schema: "hao.editkin.material-intelligence/v1", receipts: [{ id: "one" }] };
    const expected = { planSha256: "a".repeat(64), project: projectIdentity, invocation, materialEvidence };
    const receipt = createAcceptedAutopilotAuditReceipt(expected);
    expect(verifyAcceptedAutopilotAuditReceipt(receipt, expected)).toEqual(receipt);
    expect(() => verifyAcceptedAutopilotAuditReceipt({ ...receipt, auditedAt: "2026-01-01T00:00:00.000Z" }, expected)).toThrow(/竄改/);
    const { receiptSha256: _receiptSha256, issuerProof, ...forgedBase } = { ...receipt, auditedAt: "2026-01-01T00:00:00.000Z" };
    const forged = { ...forgedBase, receiptSha256: sha256Canonical(forgedBase), issuerProof };
    expect(() => verifyAcceptedAutopilotAuditReceipt(forged, expected)).toThrow(/不是由目前 Editkin 程序簽發/);
    expect(() => verifyAcceptedAutopilotAuditReceipt(receipt, { ...expected, planSha256: "b".repeat(64) })).toThrow(/plan/);
    expect(() => verifyAcceptedAutopilotAuditReceipt(receipt, { ...expected, project: { ...projectIdentity, revision: projectIdentity.revision + 1 } })).toThrow(/專案 revision/);
    expect(() => verifyAcceptedAutopilotAuditReceipt(receipt, { ...expected, invocation: { ...invocation, bindingSha256: "c".repeat(64) } })).toThrow(/identity/);
    consumeAcceptedAutopilotAuditReceipt(receipt);
    expect(() => verifyAcceptedAutopilotAuditReceipt(receipt, expected)).toThrow(/不可重播/);

    const expired = createAcceptedAutopilotAuditReceipt({ ...expected, auditedAt: new Date(Date.now() - AUTOPILOT_AUDIT_RECEIPT_TTL_MS - 1_000).toISOString() });
    expect(() => verifyAcceptedAutopilotAuditReceipt(expired, expected)).toThrow(/已過期/);
    const future = createAcceptedAutopilotAuditReceipt({ ...expected, auditedAt: new Date(Date.now() + 60_000).toISOString() });
    expect(() => verifyAcceptedAutopilotAuditReceipt(future, expected)).toThrow(/時間在未來/);

    const baseTime = Date.now() - AUTOPILOT_AUDIT_RECEIPT_MAX_PENDING - 1;
    const pending = Array.from({ length: AUTOPILOT_AUDIT_RECEIPT_MAX_PENDING + 1 }, (_, index) => createAcceptedAutopilotAuditReceipt({
      ...expected,
      auditedAt: new Date(baseTime + index).toISOString(),
    }));
    expect(() => verifyAcceptedAutopilotAuditReceipt(pending[0], expected)).toThrow(/有界佇列淘汰/);
    expect(verifyAcceptedAutopilotAuditReceipt(pending.at(-1), expected)).toEqual(pending.at(-1));
    consumeAcceptedAutopilotAuditReceipt(pending.at(-1)!);
  });
});

