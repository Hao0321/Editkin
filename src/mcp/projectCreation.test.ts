import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAestheticSystem } from "../application/editkinAesthetic";
import { createEditorialProjectFile } from "./projectCreation";
import { readProject } from "./storage";

const previousWorkspace = process.env.EDITKIN_WORKSPACE;
let workspace = "";
beforeEach(async () => { workspace = await mkdtemp(join(tmpdir(), "editkin-project-creation-")); process.env.EDITKIN_WORKSPACE = workspace; });
afterEach(async () => {
  if (previousWorkspace === undefined) delete process.env.EDITKIN_WORKSPACE; else process.env.EDITKIN_WORKSPACE = previousWorkspace;
  await rm(workspace, { recursive: true, force: true });
});

describe("createEditorialProjectFile (the create_project body)", () => {
  it("writes the editorial profile and the shorts aesthetic bound to the current creator review policy", async () => {
    const policy = { mode: "agent_reference_comparison", authorization: "明確授權 agent 自行完整對照參考審查" } as const;
    await mkdir(join(workspace, ".autopilot"));
    await writeFile(join(workspace, ".autopilot", "creator-review-policy.json"), JSON.stringify(policy));
    const created = await createEditorialProjectFile("runs/short.editkin.json", "Template short", 1080, 1920, 30, "travel");
    const reopened = await readProject("runs/short.editkin.json");
    expect(reopened).toEqual(created);
    expect(reopened).toMatchObject({ width: 1080, height: 1920, fps: 30, editorialProfile: "travel" });
    expect(reopened.aestheticSystem).toEqual(resolveAestheticSystem("travel", "shorts", policy));
  });

  it("uses the longform aesthetic for landscape and the human default without a policy file", async () => {
    const created = await createEditorialProjectFile("long.editkin.json", "Landscape", 1920, 1080, 30, "auto");
    const expected = resolveAestheticSystem("auto", "longform", { mode: "human" });
    expect(created.aestheticSystem).toMatchObject({ format: "longform", domain: expected.domain, primaryFamily: expected.primaryFamily,
      sourceSha256: expected.sourceSha256, reviewPolicy: { mode: "human" }, review: { status: "REVIEW" } });
  });
});
