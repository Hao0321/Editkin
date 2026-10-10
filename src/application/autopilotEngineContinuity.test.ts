import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EDITKIN_ENGINE_CONTINUITY } from "../motion/engineContinuity";
import { createEmptyProject } from "../domain/editGraph";
import { assertAutopilotPlanSourceCurrent, autopilotPlanSourceFromIdentity,
  createAcceptedAutopilotAuditReceipt, createAutopilotProjectAuditIdentity, liveAutopilotIdentitySchema,
  readLiveAutopilotIdentity, sha256Canonical, verifyAcceptedAutopilotAuditReceipt } from "./autopilotInvocationIdentity";

const ownedRoots: string[] = [];
afterEach(async () => {
  for (const root of ownedRoots.splice(0)) {
    const parent = resolve(tmpdir()), target = resolve(root);
    if (!target.startsWith(parent + "/") && !target.startsWith(parent + "\\")) throw new Error("Owned test cleanup escaped its explicit temporary parent");
    if (!target.slice(parent.length + 1).startsWith("editkin-engine-pin-")) throw new Error("Unexpected owned test target");
    await rm(target, { recursive: true, force: true });
  }
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "editkin-engine-pin-")); ownedRoots.push(root);
  const skillPath = join(root, "SKILL.md"), plugins = join(root, "plugins"); await mkdir(plugins);
  await writeFile(skillPath, "---\nname: video-autopilot\n---\n- M175: preserve the current generation\n");
  await writeFile(join(root, "workflow_contract.json"), JSON.stringify({ schema: "hao.video-autopilot.workflow-contract/v1", contract_revision: 6,
    plan_schema: "hao.video-autopilot.edit-plan/v4", plan_hash_algorithm: "sha256-canonical-json-utf8-keys-v1", legacy_plan_policy: "reject" }));
  const invocation = await readLiveAutopilotIdentity({ skillPath, pluginRoots: [plugins] });
  const project = createEmptyProject("Engine continuity diagnostic", { id: "engine-pin-project" });
  return { root, invocation, project };
}
describe("actual invocation and audit bind the current Motion engine declaration", () => {
  it("pins the actual immutable capability manifest inside the live invocation checksum", async () => {
    const { invocation } = await fixture();
    expect(invocation.engine).toEqual({ schema: "editkin.engine-continuity-pin/v1", sha256: sha256Canonical(EDITKIN_ENGINE_CONTINUITY) });
    const { bindingSha256, ...body } = invocation;
    expect(bindingSha256).toBe(sha256Canonical(body));
  });
  it("rejects an old invocation with no current engine pin before audit receipt creation", async () => {
    const { invocation } = await fixture(), { engine: _engine, ...older } = invocation;
    expect(() => liveAutopilotIdentitySchema.parse(older)).toThrow();
  });
  it("engine drift changes the invocation binding and invalidates a previously planned source", async () => {
    const { invocation } = await fixture(), source = autopilotPlanSourceFromIdentity(invocation);
    const { bindingSha256: _binding, ...body } = invocation;
    const changed = { ...body, engine: { ...body.engine, sha256: "0".repeat(64) } };
    const next = liveAutopilotIdentitySchema.parse({ ...changed, bindingSha256: sha256Canonical(changed) });
    expect(() => assertAutopilotPlanSourceCurrent(source, next)).toThrow(/invocationBindingSha256/);
  });
  it("an issued HMAC audit cannot authorize a different engine generation at apply", async () => {
    const { root, invocation, project } = await fixture();
    const expected = { planSha256: "a".repeat(64), project: createAutopilotProjectAuditIdentity(join(root, "project.json"), project),
      invocation, materialEvidence: { schema: "hao.editkin.material-intelligence/v1", receipts: [] } };
    const receipt = createAcceptedAutopilotAuditReceipt(expected);
    expect(verifyAcceptedAutopilotAuditReceipt(receipt, expected)).toEqual(receipt);
    const { bindingSha256: _binding, ...body } = invocation;
    const changed = { ...body, engine: { ...body.engine, sha256: "0".repeat(64) } };
    const next = liveAutopilotIdentitySchema.parse({ ...changed, bindingSha256: sha256Canonical(changed) });
    expect(() => verifyAcceptedAutopilotAuditReceipt(receipt, { ...expected, invocation: next })).toThrow(/identity/);
  });
});
