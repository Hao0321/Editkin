// Agent integration: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. Existing GPL license retained; see AGENT-NOTICE.md.
import { realpathSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readProjectFile } from "../application/projectFiles";
import { resolveMediaPath } from "../render/mediaProcess";
import {
  applyProjectCommands,
  commitAutopilotReceipt,
  createProjectFile,
  pinBoundProjectMediaSources,
  readAutopilotExecutionAttribution,
  readProject,
  resolveProjectPath,
  resolveProjectAssetMediaPath,
  resolveRenderPath,
  resolveWorkspaceMediaPath,
  WorkspaceBoundaryError,
  writeAutopilotLearningEvent,
  writePendingAutopilotReceipt,
} from "./storage";

const roots: string[] = [];
const previousWorkspace = process.env.EDITKIN_WORKSPACE;

afterEach(async () => {
  pinBoundProjectMediaSources({});
  if (previousWorkspace === undefined) delete process.env.EDITKIN_WORKSPACE;
  else process.env.EDITKIN_WORKSPACE = previousWorkspace;
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("MCP workspace boundary", () => {
  it("accepts only canonical paths that remain under the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "editkin-workspace-"));
    roots.push(workspace);
    process.env.EDITKIN_WORKSPACE = workspace;
    await writeFile(join(workspace, "clip.mp4"), "fixture");

    await expect(resolveWorkspaceMediaPath("clip.mp4")).resolves.toBe(join(workspace, "clip.mp4"));
    await expect(resolveProjectPath("project.editkin.json")).resolves.toBe(join(workspace, "project.editkin.json"));
    await expect(resolveRenderPath("exports/output.mp4")).resolves.toBe(join(workspace, "exports/output.mp4"));
    await expect(resolveWorkspaceMediaPath("../outside.mp4")).rejects.toBeInstanceOf(WorkspaceBoundaryError);
  });

  it("rejects a symlink or junction that escapes the lexical workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "editkin-workspace-"));
    const outside = await mkdtemp(join(tmpdir(), "editkin-outside-"));
    roots.push(workspace, outside);
    process.env.EDITKIN_WORKSPACE = workspace;
    await mkdir(join(outside, "media"));
    await writeFile(join(outside, "media", "clip.mp4"), "outside");
    await symlink(join(outside, "media"), join(workspace, "linked"), process.platform === "win32" ? "junction" : "dir");

    await expect(resolveWorkspaceMediaPath("linked/clip.mp4")).rejects.toBeInstanceOf(WorkspaceBoundaryError);
    await expect(resolveRenderPath("linked/output.mp4")).rejects.toBeInstanceOf(WorkspaceBoundaryError);
  });

  it("persists receipts in two phases and learning events as immutable evidence", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "editkin-workspace-"));
    roots.push(workspace);
    process.env.EDITKIN_WORKSPACE = workspace;
    const projectPath = "evidence.editkin.json";
    await createProjectFile(projectPath, "Evidence", 1920, 1080, 30);
    const planSha256 = "a".repeat(64);
    const skillSelection = {
      receiptSha256: "b".repeat(64),
      profileSha256: "c".repeat(64),
      selected: [{ skillId: "com.example.workflow/main", manifestSha256: "d".repeat(64), packSha256: "e".repeat(64), precedence: 0 }],
    };

    const pending = await writePendingAutopilotReceipt(projectPath, {
      schema: "hao.video-autopilot.execution-receipt/v1",
      planSha256,
      skillSelection,
      projectRevisionBefore: 0,
    });
    expect(JSON.parse(await readFile(pending.pendingPath, "utf8"))).toMatchObject({
      receiptId: pending.receiptId,
      state: "pending",
    });

    const committedName = await commitAutopilotReceipt(pending.pendingPath, {
      receiptId: pending.receiptId,
      schema: "hao.video-autopilot.execution-receipt/v1",
      planSha256,
      skillSelection,
      projectRevisionBefore: 0,
      projectRevisionAfter: 1,
    });
    const receipts = join(workspace, ".editkin-receipts");
    expect(JSON.parse(await readFile(join(receipts, committedName), "utf8"))).toMatchObject({
      receiptId: pending.receiptId,
      state: "committed",
      projectRevisionAfter: 1,
    });
    await expect(readFile(pending.pendingPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(pending.pendingPath.replace(".pending.json", ".prepared.json"), "utf8")).toContain('"state": "pending"');
    await expect(readAutopilotExecutionAttribution(projectPath, planSha256)).resolves.toMatchObject({
      executionReceiptId: pending.receiptId,
      skillSelectionReceiptSha256: skillSelection.receiptSha256,
      profileSha256: skillSelection.profileSha256,
      selectedSkills: [{ skillId: "com.example.workflow/main", manifestSha256: "d".repeat(64), packSha256: "e".repeat(64) }],
    });
    await expect(readAutopilotExecutionAttribution(projectPath, "f".repeat(64))).rejects.toThrow(/committed execution receipt/);

    const learningName = await writeAutopilotLearningEvent(projectPath, {
      schema: "hao.video-autopilot.learning-event/v1",
      checkpoint: "D7",
      humanDecision: "accepted",
      metrics: { averageViewPercentage: 0.61 },
    });
    expect(JSON.parse(await readFile(join(workspace, ".editkin-learning", learningName), "utf8"))).toMatchObject({
      checkpoint: "D7",
      humanDecision: "accepted",
      metrics: { averageViewPercentage: 0.61 },
    });
  });

  it("rejects evidence folders redirected outside the workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "editkin-workspace-"));
    const outside = await mkdtemp(join(tmpdir(), "editkin-outside-"));
    roots.push(workspace, outside);
    process.env.EDITKIN_WORKSPACE = workspace;
    const projectPath = "evidence.editkin.json";
    await createProjectFile(projectPath, "Evidence", 1920, 1080, 30);
    await symlink(outside, join(workspace, ".editkin-receipts"), process.platform === "win32" ? "junction" : "dir");

    await expect(writePendingAutopilotReceipt(projectPath, { planId: "escape" })).rejects.toBeInstanceOf(WorkspaceBoundaryError);
  });

  it("fails closed when a plugin-style command batch was prepared from a stale project revision", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "editkin-workspace-"));
    roots.push(workspace);
    process.env.EDITKIN_WORKSPACE = workspace;
    const projectPath = "revision.editkin.json";
    const created = await createProjectFile(projectPath, "Revision", 1920, 1080, 30);
    const advanced = await applyProjectCommands(projectPath, [], created.revision);

    await expect(applyProjectCommands(projectPath, [], created.revision)).rejects.toMatchObject({
      name: "ProjectRevisionConflictError",
    });
    await expect(readProject(projectPath)).resolves.toMatchObject({ revision: advanced.revision });
  });

  it("saves workspace-relative imports so the desktop can reopen without the MCP working directory", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "editkin-workspace-"));
    roots.push(workspace);
    process.env.EDITKIN_WORKSPACE = workspace;
    await mkdir(join(workspace, "素材"));
    await writeFile(join(workspace, "素材", "clip.mov"), "original");
    const projectPath = "edits/nested/reopen.editkin.json";
    await createProjectFile(projectPath, "Desktop reopen", 1080, 1920, 30);
    const asset = { id: "source", name: "clip.mov", kind: "video" as const, uri: "素材/clip.mov", duration: 2,
      derivatives: { sourceSha256: "a".repeat(64), proxyUri: "cache/clip.mp4", thumbnailUri: "cache/clip.jpg", generatedAt: new Date().toISOString() } };
    await applyProjectCommands(projectPath, [{ type: "import_asset", asset }]);
    const reopened = await readProjectFile(join(workspace, projectPath));
    expect(resolveMediaPath(reopened.assets[0].uri)).toBe(join(workspace, "素材", "clip.mov"));
    expect(resolveMediaPath(reopened.assets[0].derivatives!.proxyUri!)).toBe(join(workspace, "cache", "clip.mp4"));
    expect(reopened.assets[0].derivatives!.thumbnailUri).toBe(join(workspace, "cache", "clip.jpg"));
    expect(asset.uri).toBe("素材/clip.mov");
    expect(await readFile(join(workspace, "素材", "clip.mov"), "utf8")).toBe("original");
  });

  it("preserves portable creative URIs and rejects relative media escapes before saving", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "editkin-workspace-"));
    roots.push(workspace);
    process.env.EDITKIN_WORKSPACE = workspace;
    const projectPath = "safe.editkin.json";
    await createProjectFile(projectPath, "Safe save", 1080, 1920, 30);
    const creative = { id: "music", name: "Music", kind: "audio" as const, uri: "creative://studio.hao.creator-library/music%3Aexample", duration: 2 };
    const saved = await applyProjectCommands(projectPath, [{ type: "import_asset", asset: creative }]);
    expect(saved.assets[0].uri).toBe(creative.uri);
    await expect(applyProjectCommands(projectPath, [{ type: "import_asset", asset: { ...creative, id: "escape", uri: "../outside.wav" } }])).rejects.toBeInstanceOf(WorkspaceBoundaryError);
    expect((await readProjectFile(join(workspace, projectPath))).revision).toBe(saved.revision);
  });

  it("edits a bound project with its original external import without granting new outside paths", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "editkin-project-"));
    const media = await mkdtemp(join(tmpdir(), "editkin-imports-"));
    roots.push(workspace, media);
    process.env.EDITKIN_WORKSPACE = workspace;
    const original = join(media, "original.mov");
    const unapproved = join(media, "unapproved.mov");
    await writeFile(original, "original bytes");
    await writeFile(unapproved, "other bytes");
    const projectPath = join(workspace, "external.editkin.json");
    const project = await createProjectFile("external.editkin.json", "External import", 1920, 1080, 30);
    project.assets.push({ id: "original", name: "original.mov", kind: "video", uri: original, duration: 2 });
    await writeFile(projectPath, JSON.stringify(project));

    await expect(resolveProjectAssetMediaPath(original)).rejects.toBeInstanceOf(WorkspaceBoundaryError);
    pinBoundProjectMediaSources({ EDITKIN_WORKSPACE: workspace, EDITKIN_AGENT_PROJECT_PATH: projectPath });
    await expect(resolveProjectAssetMediaPath(original)).resolves.toBe(realpathSync(original));
    await expect(resolveProjectAssetMediaPath(unapproved)).rejects.toBeInstanceOf(WorkspaceBoundaryError);
    const saved = await applyProjectCommands("external.editkin.json", [], project.revision);
    expect(saved.assets[0].uri).toBe(realpathSync(original));
    const savedAgain = await applyProjectCommands("external.editkin.json", [], saved.revision);
    expect(savedAgain.assets[0].uri).toBe(realpathSync(original));
    expect(await readFile(original, "utf8")).toBe("original bytes");
    await expect(applyProjectCommands("external.editkin.json", [{ type: "import_asset", asset: {
      id: "new", name: "unapproved.mov", kind: "video", uri: unapproved, duration: 2,
    } }], savedAgain.revision)).rejects.toBeInstanceOf(WorkspaceBoundaryError);
    expect((await readProjectFile(projectPath)).revision).toBe(savedAgain.revision);
  });

  it("does not pin a workspace path that escapes through a junction", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "editkin-project-"));
    const outside = await mkdtemp(join(tmpdir(), "editkin-imports-"));
    roots.push(workspace, outside);
    process.env.EDITKIN_WORKSPACE = workspace;
    await writeFile(join(outside, "clip.mov"), "source");
    await symlink(outside, join(workspace, "linked"), process.platform === "win32" ? "junction" : "dir");
    const linked = join(workspace, "linked", "clip.mov");
    const projectPath = join(workspace, "linked.editkin.json");
    const project = await createProjectFile("linked.editkin.json", "Linked", 1920, 1080, 30);
    project.assets.push({ id: "linked", name: "clip.mov", kind: "video", uri: linked, duration: 2 });
    await writeFile(projectPath, JSON.stringify(project));
    pinBoundProjectMediaSources({ EDITKIN_WORKSPACE: workspace, EDITKIN_AGENT_PROJECT_PATH: projectPath });
    await expect(resolveProjectAssetMediaPath(linked)).rejects.toBeInstanceOf(WorkspaceBoundaryError);
  });
});
