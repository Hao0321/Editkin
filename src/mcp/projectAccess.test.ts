import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

/**
 * Every node:fs/promises call that names a network or device path (\\host\share, //host, \\?\…, \\.\…, \??\…, file://host)
 * is recorded and refused here, so a test proves such a reference never reaches the filesystem (no SMB, no NTLM)
 * without the test itself ever touching the network.
 */
const fsSpy = vi.hoisted(() => ({ blocked: [] as string[] }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const networkOrDevice = (value: unknown): boolean => {
    const text = typeof value === "string" ? value : value instanceof URL ? value.href : Buffer.isBuffer(value) ? value.toString("utf8") : "";
    const normalized = text.replaceAll("/", "\\");
    return normalized.startsWith("\\\\") || normalized.startsWith("\\??\\") || /^file:\/\/[^/]/i.test(text);
  };
  const guard = (name: string, original: (...args: unknown[]) => unknown) => (...args: unknown[]) => {
    if (networkOrDevice(args[0])) {
      fsSpy.blocked.push(`${name} ${String(args[0])}`);
      return Promise.reject(Object.assign(new Error(`test refused ${name} of a network or device path`), { code: "EACCES" }));
    }
    return original(...args);
  };
  const names = ["realpath", "stat", "lstat", "open", "access", "readFile", "readdir", "opendir", "copyFile", "cp"] as const;
  const spied = Object.fromEntries(names.map((name) => [name, guard(name, actual[name] as (...args: unknown[]) => unknown)]));
  return { ...actual, ...spied, default: { ...actual, ...spied } };
});

vi.mock("@modelcontextprotocol/server/stdio", () => ({ serveStdio: () => ({ close: async () => {} }) }));
import { createServerForEnvironment } from "./server";
import { acquireProjectLock, readProjectFile, writeProjectFileAtomic } from "../application/projectFiles";
import { clearRecoveryFile, writeRecoveryFileAtomic } from "../application/recoveryFiles";
import { readProject, resolveProjectAssetReadPath, WorkspaceBoundaryError, writeProject } from "./storage";
import { observeGuiSession } from "./guiSessionState";
import { DEFAULT_COLOR, DEFAULT_TRANSFORM } from "../domain/types";
import packageManifest from "../../package.json";

const saved = { workspace: process.env.EDITKIN_WORKSPACE, appData: process.env.EDITKIN_APP_DATA_ROOT, state: process.env.EDITKIN_AGENT_STATE_ROOT, extraRoots: process.env.EDITKIN_EXTRA_MEDIA_ROOTS };
let root = "", workspace = "", outside = "", appData = "";
let client: Client;

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>)[0].text;
  return { isError: result.isError === true, text, bytes: Buffer.byteLength(text, "utf8"), payload: (() => { try { return JSON.parse(text); } catch { return undefined; } })() };
}
const sha = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");
const recoveryPath = () => join(appData, "recovery", "session.json");

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "editkin-w2-access-"));
  workspace = join(root, "ws"); outside = join(root, "outside"); appData = join(root, "appdata");
  await Promise.all([mkdir(workspace), mkdir(outside), mkdir(appData)]);
  process.env.EDITKIN_WORKSPACE = workspace;
  process.env.EDITKIN_APP_DATA_ROOT = appData;
  delete process.env.EDITKIN_AGENT_STATE_ROOT;
  delete process.env.EDITKIN_EXTRA_MEDIA_ROOTS;
  const server = createServerForEnvironment(process.env);
  client = new Client({ name: "editkin-w2-access", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
}, 300_000);

afterEach(async () => { await clearRecoveryFile(recoveryPath()); });

afterAll(async () => {
  await client?.close();
  for (const [key, value] of [["EDITKIN_WORKSPACE", saved.workspace], ["EDITKIN_APP_DATA_ROOT", saved.appData], ["EDITKIN_AGENT_STATE_ROOT", saved.state],
    ["EDITKIN_EXTRA_MEDIA_ROOTS", saved.extraRoots]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

const create = (projectPath: string, extra: Record<string, unknown> = {}) => call("create_project", { projectPath, name: "W2 access", width: 1080, height: 1920, fps: 30, ...extra });

/**
 * What the Editkin desktop host records when the creator imports, relinks or opens media there
 * (src-tauri/src/outside_media_grants.rs): written here in the same store format, never through MCP.
 */
const grantStorePath = () => join(appData, "media-access", "outside-media-grants.json");
const desktopGrants: Array<Record<string, unknown>> = [];
async function desktopImportGrant(file: string): Promise<void> {
  const canonical = await realpath(file);
  const info = await stat(canonical, { bigint: true });
  const size = Number(info.size), headBytes = Math.min(size, 64 * 1024);
  const headSha256 = createHash("sha256").update((await readFile(canonical)).subarray(0, headBytes)).digest("hex");
  const grant = { path: canonical, size, mtimeMs: Number(info.mtimeNs / 1_000_000n), headSha256, headBytes, grantedAtMs: Date.now(), source: "import" };
  const index = desktopGrants.findIndex(entry => String(entry.path).toLowerCase() === canonical.toLowerCase());
  if (index >= 0) desktopGrants[index] = grant; else desktopGrants.push(grant);
  await mkdir(dirname(grantStorePath()), { recursive: true });
  const temporary = `${grantStorePath()}.${process.pid}.${desktopGrants.length}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify({ schema: "editkin.outside-media-grants/v1", schemaVersion: 1, writer: "editkin-desktop", updatedAtMs: Date.now(), grants: desktopGrants }));
  await rename(temporary, grantStorePath());
}
const grantStoreSha = async () => { try { return await sha(grantStorePath()); } catch { return null; } };

/** A project file someone else crafted: saved with the application writer, never validated by MCP. */
async function craftedProject(projectPath: string, assets: Array<{ id: string; uri: string }>): Promise<void> {
  expect((await create(projectPath)).isError).toBe(false);
  const absolute = join(workspace, ...projectPath.split("/"));
  const current = await readProjectFile(absolute);
  await writeProjectFileAtomic(absolute, { ...current, assets: assets.map(({ id, uri }) => ({ id, name: "clip.mov", kind: "video" as const, uri, duration: 3 })) }, current.revision);
}
const BS = "\\";

describe("W2-2 B1: create_project is create-only", () => {
  it("refuses to replace an existing project, replaces it only with overwrite:true, and never while it is open with unsaved GUI changes or locked", async () => {
    const created = await create("b1/one.editkin.json");
    expect(created.isError).toBe(false);
    const path = join(workspace, "b1", "one.editkin.json");
    const before = await sha(path);
    const again = await create("b1/one.editkin.json", { name: "Silently replaced?" });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("PROJECT_EXISTS");
    expect(await sha(path)).toBe(before);

    // Open in the desktop editor with unsaved changes: overwrite still refuses.
    await writeRecoveryFileAtomic(recoveryPath(), { project: await readProjectFile(path), projectPath: path, cleanUpdatedAt: new Date().toISOString() });
    const open = await create("b1/one.editkin.json", { overwrite: true });
    expect(open.isError).toBe(true);
    expect(open.text).toContain("PROJECT_OPEN_IN_GUI");
    await clearRecoveryFile(recoveryPath());

    // Locked by another writer: overwrite still refuses.
    const release = await acquireProjectLock(path);
    try {
      const locked = await create("b1/one.editkin.json", { overwrite: true });
      expect(locked.isError).toBe(true);
      expect(locked.text).toContain("PROJECT_LOCKED");
    } finally { await release(); }
    expect(await sha(path)).toBe(before);

    const replaced = await create("b1/one.editkin.json", { overwrite: true, name: "Replaced on purpose" });
    expect(replaced.isError).toBe(false);
    expect(replaced.payload).toMatchObject({ status: "GREEN", overwritten: true, summary: { name: "Replaced on purpose" } });
    expect(replaced.payload.projectSha256).toBe(await sha(path));
    expect(replaced.bytes).toBeLessThan(2048);
  }, 120_000);
});

describe("W2-2 B3: summaries carry revision, file SHA and missing media", () => {
  it("returns revision + projectSha256 + bounded missingMedia from every summary, and the revision drives expectedRevision", async () => {
    const projectPath = "b3/summary.editkin.json";
    await create(projectPath);
    const absolute = join(workspace, "b3", "summary.editkin.json");
    const missing = Array.from({ length: 10 }, (_, index) => ({ type: "import_asset", asset: { id: `missing-${index}`, name: `缺少的素材 ${index} ${"長".repeat(60)}`, kind: "video", uri: `media/missing-${index}.mp4`, duration: 2 } }));
    const applied = await call("apply_edit_commands", { projectPath, commands: missing });
    expect(applied.isError).toBe(false);
    expect(applied.payload.summary.revision).toBe(2);
    expect(applied.payload.projectSha256).toBe(await sha(absolute));
    for (const tool of ["get_project_summary", "validate_project"]) {
      const summary = await call(tool, { projectPath });
      expect(summary.payload).toMatchObject({ status: "GREEN", summary: { revision: 2 }, projectSha256: await sha(absolute), outsideWorkspaceMedia: 0 });
      expect(summary.payload.missingMedia).toMatchObject({ count: 10, hasMore: true });
      expect(summary.payload.missingMedia.items).toHaveLength(6);
      expect(JSON.stringify(summary.payload.missingMedia)).not.toContain(workspace.replaceAll("\\", "\\\\"));
      expect(summary.bytes).toBeLessThan(2048);
    }
    const window = await call("get_timeline_window", { projectPath, start: 0, end: 10 });
    expect(window.payload).toMatchObject({ revision: 2, projectSha256: await sha(absolute) });
    const session = await call("start_ai_editing_session", { projectPath });
    expect(session.payload).toMatchObject({ summary: { revision: 2 }, projectSha256: await sha(absolute) });
    // The revision a summary reports is the one expectedRevision accepts.
    const ok = await call("apply_edit_commands", { projectPath, commands: [{ type: "rename_project", name: "Renamed" }], expectedRevision: 2 });
    expect(ok.payload.summary).toMatchObject({ revision: 3, name: "Renamed" });
    const stale = await call("apply_edit_commands", { projectPath, commands: [{ type: "rename_project", name: "Late" }], expectedRevision: 2 });
    expect(stale.isError).toBe(true);
  }, 120_000);
});

describe("W2-2 B4: projects whose media lives outside the workspace", () => {
  it("edits the project, keeps the outside reference byte-for-byte and read-only, reads it only through a desktop grant, and refuses any new or changed outside reference", async () => {
    const projectPath = "b4/gui.editkin.json";
    await create(projectPath);
    const absolute = join(workspace, "b4", "gui.editkin.json");
    const media = join(outside, "phone-clip.mp4");
    await writeFile(media, "synthetic bytes, never written by Editkin");
    // The desktop editor may import from anywhere: simulate its save with the application writer, and the import grant
    // its Tauri host records at that moment.
    const current = await readProjectFile(absolute);
    await writeProjectFileAtomic(absolute, { ...current, assets: [{ id: "outside-clip", name: "phone-clip.mp4", kind: "video", uri: media, duration: 3 }] }, current.revision);
    await desktopImportGrant(media);

    const renamed = await call("apply_edit_commands", { projectPath, commands: [{ type: "rename_project", name: "Edited by an agent" }] });
    expect(renamed.isError, renamed.text).toBe(false);
    expect(renamed.payload.outsideWorkspaceMedia).toBe(1);
    const reopened = await readProjectFile(absolute);
    expect(reopened.name).toBe("Edited by an agent");
    expect(reopened.assets.find(asset => asset.id === "outside-clip")?.uri).toBe(media);
    expect(await readFile(media, "utf8")).toBe("synthetic bytes, never written by Editkin");

    const added = await call("apply_edit_commands", { projectPath, commands: [{ type: "import_asset", asset: { id: "new-outside", name: "x", kind: "video", uri: join(outside, "other.mp4"), duration: 1 } }] });
    expect(added.isError).toBe(true);
    expect(added.text).toContain("超出 EDITKIN_WORKSPACE");

    const project = await readProject(projectPath);
    const changed = structuredClone(project);
    changed.assets[0].uri = join(outside, "swapped.mp4");
    await expect(writeProject(projectPath, changed)).rejects.toBeInstanceOf(WorkspaceBoundaryError);

    // Reading goes through the desktop grant of that very file (so also for a clone or an in-memory derived project);
    // the project file itself grants nothing: another outside file under the same asset id is refused.
    expect(await resolveProjectAssetReadPath(project, project.assets[0])).toBe(await realpath(media));
    expect(await resolveProjectAssetReadPath(structuredClone(project), project.assets[0])).toBe(await realpath(media));
    await writeFile(join(outside, "swapped.mp4"), "another file the desktop app never imported");
    const swapped = resolveProjectAssetReadPath(project, { id: "outside-clip", uri: join(outside, "swapped.mp4") });
    await expect(swapped).rejects.toBeInstanceOf(WorkspaceBoundaryError);
    await expect(swapped).rejects.toThrow(/^OUTSIDE_MEDIA_NOT_GRANTED \(not_granted\)/);
  }, 120_000);
});

describe("Security 2026-10-23: outside-workspace media needs a desktop grant or EDITKIN_EXTRA_MEDIA_ROOTS", () => {
  afterEach(() => { delete process.env.EDITKIN_EXTRA_MEDIA_ROOTS; });

  it("refuses a crafted project's outside file that the desktop app never granted, compactly and without a path", async () => {
    const projectPath = "sec/crafted.editkin.json";
    const secret = join(outside, "someone-else-secret.mov");
    await writeFile(secret, "not yours");
    await craftedProject(projectPath, [{ id: "crafted", uri: secret }]);
    const storeBefore = await grantStoreSha();
    const project = await readProject(projectPath);
    const error = await resolveProjectAssetReadPath(project, project.assets[0]).then(() => undefined, (reason: Error) => reason);
    expect(error).toBeInstanceOf(WorkspaceBoundaryError);
    expect(error?.message).toMatch(/^OUTSIDE_MEDIA_NOT_GRANTED \(not_granted\)/);
    expect(Buffer.byteLength(error?.message ?? "", "utf8")).toBeLessThan(2048);
    expect(error?.message).not.toContain(outside);
    expect(error?.message).not.toContain("someone-else-secret");
    // Summaries and metadata edits keep working, and nothing on the MCP side creates a grant.
    expect((await call("get_project_summary", { projectPath })).payload).toMatchObject({ status: "GREEN", outsideWorkspaceMedia: 1 });
    expect((await call("apply_edit_commands", { projectPath, commands: [{ type: "rename_project", name: "Crafted, renamed" }] })).isError).toBe(false);
    await expect(resolveProjectAssetReadPath(await readProject(projectPath), project.assets[0])).rejects.toThrow(/OUTSIDE_MEDIA_NOT_GRANTED/);
    expect(await grantStoreSha()).toBe(storeBefore);
  }, 120_000);

  it("refuses UNC, \\\\?\\, \\\\.\\, \\??\\, // and file://host references without any filesystem call", async () => {
    const local = join(outside, "local-clip.mov");
    await writeFile(local, "a local file the desktop app did import");
    await desktopImportGrant(local);
    const references = [
      `${BS}${BS}attacker.invalid${BS}share${BS}clip.mov`,
      "//attacker.invalid/share/clip.mov",
      `${BS}${BS}?${BS}UNC${BS}attacker.invalid${BS}share${BS}clip.mov`,
      `${BS}${BS}?${BS}${local}`,
      `${BS}${BS}.${BS}${local}`,
      `${BS}??${BS}${local}`,
      "file://attacker.invalid/share/clip.mov",
    ];
    const projectPath = "sec/unc.editkin.json";
    await craftedProject(projectPath, references.map((uri, index) => ({ id: `network-${index}`, uri })));
    fsSpy.blocked.length = 0;
    const project = await readProject(projectPath);
    for (const asset of project.assets) {
      // Even a granted local file is not readable through its verbatim or device spelling.
      await expect(resolveProjectAssetReadPath(project, asset), asset.uri).rejects.toThrow(/^OUTSIDE_MEDIA_NOT_GRANTED \(not_local\)/);
    }
    // The summary's missing-media check does not stat them either.
    const summary = await call("get_project_summary", { projectPath });
    expect(summary.payload).toMatchObject({ status: "GREEN", missingMedia: { count: references.length } });
    expect(fsSpy.blocked).toEqual([]);
  }, 120_000);

  it("allows a file under EDITKIN_EXTRA_MEDIA_ROOTS and refuses a junction inside that root which resolves outside it", async () => {
    const extraRoot = join(root, "extra-root"), elsewhere = join(root, "elsewhere");
    await mkdir(extraRoot, { recursive: true });
    await mkdir(elsewhere, { recursive: true });
    const inside = join(extraRoot, "inside.mp4");
    await writeFile(inside, "in an allowed root");
    await writeFile(join(elsewhere, "escaped.mov"), "outside every allowed root");
    await symlink(elsewhere, join(extraRoot, "link"), "junction");
    process.env.EDITKIN_EXTRA_MEDIA_ROOTS = [join(root, "no-such-root"), "relative-root", extraRoot].join(delimiter);
    const projectPath = "sec/extra.editkin.json";
    await craftedProject(projectPath, [{ id: "in-root", uri: inside }, { id: "through-junction", uri: join(extraRoot, "link", "escaped.mov") }]);
    const project = await readProject(projectPath);
    expect(await resolveProjectAssetReadPath(project, project.assets[0])).toBe(await realpath(inside));
    await expect(resolveProjectAssetReadPath(project, project.assets[1])).rejects.toThrow(/^OUTSIDE_MEDIA_NOT_GRANTED \(link_escape\)/);
    delete process.env.EDITKIN_EXTRA_MEDIA_ROOTS;
    await expect(resolveProjectAssetReadPath(project, project.assets[0])).rejects.toThrow(/^OUTSIDE_MEDIA_NOT_GRANTED \(not_granted\)/);
  }, 120_000);

  it("refuses a non-media file outside the workspace even when a grant or an extra root names it", async () => {
    const notes = join(outside, "id_rsa.txt"), bare = join(outside, "credentials");
    await writeFile(notes, "PRIVATE KEY");
    await writeFile(bare, "token");
    await desktopImportGrant(notes);
    process.env.EDITKIN_EXTRA_MEDIA_ROOTS = outside;
    const projectPath = "sec/not-media.editkin.json";
    await craftedProject(projectPath, [{ id: "notes", uri: notes }, { id: "bare", uri: bare }]);
    const project = await readProject(projectPath);
    for (const asset of project.assets) await expect(resolveProjectAssetReadPath(project, asset)).rejects.toThrow(/^OUTSIDE_MEDIA_NOT_GRANTED \(not_media\)/);
  }, 120_000);

  it("reads a granted file and refuses it once its size, modification time or first bytes change, until it is re-imported", async () => {
    const clip = join(outside, "granted-clip.mov");
    await writeFile(clip, Buffer.alloc(100_000, 1));
    await desktopImportGrant(clip);
    const projectPath = "sec/granted.editkin.json";
    await craftedProject(projectPath, [{ id: "granted", uri: clip }]);
    const project = await readProject(projectPath);
    const read = () => resolveProjectAssetReadPath(project, project.assets[0]);
    expect(await read()).toBe(await realpath(clip));

    await writeFile(clip, Buffer.alloc(100_001, 1));
    await expect(read()).rejects.toThrow(/^OUTSIDE_MEDIA_NOT_GRANTED \(changed_since_import\)/);
    await desktopImportGrant(clip);
    expect(await read()).toBe(await realpath(clip));

    const before = await stat(clip);
    await utimes(clip, before.atime, new Date(before.mtimeMs + 5_000));
    await expect(read()).rejects.toThrow(/^OUTSIDE_MEDIA_NOT_GRANTED \(changed_since_import\)/);
    await desktopImportGrant(clip);
    expect(await read()).toBe(await realpath(clip));

    // Same size and modification time, different first bytes.
    const kept = await stat(clip);
    const handle = await open(clip, "r+");
    try { await handle.write(Buffer.from([9]), 0, 1, 0); } finally { await handle.close(); }
    await utimes(clip, kept.atime, kept.mtime);
    expect((await stat(clip)).size).toBe(kept.size);
    await expect(read()).rejects.toThrow(/^OUTSIDE_MEDIA_NOT_GRANTED \(changed_since_import\)/);
  }, 120_000);

  it("render_project refuses a crafted project's ungranted outside media before any renderer reads it", async () => {
    const projectPath = "sec/render.editkin.json";
    expect((await create(projectPath)).isError).toBe(false);
    const placed = await call("apply_edit_commands", { projectPath, commands: [
      { type: "import_asset", asset: { id: "secret-asset", name: "clip.mov", kind: "video", uri: "media/placeholder.mov", duration: 3 } },
      { type: "add_clip", clip: { id: "secret-clip", assetId: "secret-asset", trackId: "video-main", timelineStart: 0, sourceStart: 0, duration: 3, volume: 1,
        transform: { ...DEFAULT_TRANSFORM }, color: { ...DEFAULT_COLOR }, keyframes: [] } },
    ] });
    expect(placed.isError, placed.text).toBe(false);
    const absolute = join(workspace, "sec", "render.editkin.json");
    const secret = join(outside, "render-secret.mov");
    await writeFile(secret, "not yours either");
    const current = await readProjectFile(absolute);
    await writeProjectFileAtomic(absolute, { ...current, assets: current.assets.map(asset => ({ ...asset, uri: secret })) }, current.revision);
    const rendered = await call("render_project", { projectPath, outputPath: "sec/render.mp4" });
    expect(rendered.isError).toBe(true);
    expect(rendered.text).toContain("OUTSIDE_MEDIA_NOT_GRANTED (not_granted)");
    expect(rendered.text).not.toContain("render-secret");
    expect(rendered.bytes).toBeLessThan(2048);
  }, 120_000);
});

describe("W2-2 GUI state: get_editkin_status and the unsaved-session guard", () => {
  it("reports the engine and an unsaved desktop session, and refuses agent writes underneath it without the explicit flag", async () => {
    const projectPath = "gui/open.editkin.json";
    await create(projectPath);
    const absolute = join(workspace, "gui", "open.editkin.json");
    const idle = await call("get_editkin_status", {});
    expect(idle.payload).toMatchObject({ status: "GREEN", engine: { name: "editkin", version: packageManifest.version, build: "source", mcpProfile: "compat" },
      gui: { observable: true, openCleanProject: "not_observable", unsavedSession: null } });
    expect(idle.bytes).toBeLessThan(2048);

    await writeRecoveryFileAtomic(recoveryPath(), { project: await readProjectFile(absolute), projectPath: absolute, cleanUpdatedAt: new Date().toISOString() });
    const busy = await call("get_editkin_status", { projectPath });
    expect(busy.payload.gui.unsavedSession).toMatchObject({ projectPath: "gui/open.editkin.json", inWorkspace: true, snapshot: "primary" });
    expect(busy.payload.project).toMatchObject({ exists: true, revision: 1, guiUnsavedChanges: true, saveLocked: false, autopilotLocked: false, agentWrites: "refused_gui_unsaved_changes" });
    expect(busy.payload.project.projectSha256).toBe(await sha(absolute));
    expect(busy.bytes).toBeLessThan(2048);

    const before = await sha(absolute);
    const refused = await call("apply_edit_commands", { projectPath, commands: [{ type: "rename_project", name: "Underneath" }] });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("GUI_SESSION_DIRTY");
    expect(await sha(absolute)).toBe(before);
    const allowed = await call("apply_edit_commands", { projectPath, commands: [{ type: "rename_project", name: "Knowingly" }], allowDirtyGuiSession: true });
    expect(allowed.isError, allowed.text).toBe(false);
    // Other projects are unaffected by the open one.
    await create("gui/other.editkin.json");
    expect((await call("apply_edit_commands", { projectPath: "gui/other.editkin.json", commands: [{ type: "rename_project", name: "Free" }] })).isError).toBe(false);
  }, 120_000);

  it("ignores a crash-recovery snapshot older than the desktop's 30-day window and says it is stale", async () => {
    const projectPath = "gui/stale.editkin.json";
    await create(projectPath);
    const absolute = join(workspace, "gui", "stale.editkin.json");
    const old = Date.now() - 31 * 24 * 3600 * 1000;
    await writeRecoveryFileAtomic(recoveryPath(), { project: await readProjectFile(absolute), projectPath: absolute, cleanUpdatedAt: new Date(old).toISOString() }, { nowMs: old });
    expect(await observeGuiSession(process.env)).toMatchObject({ observable: true, unsaved: null, unreadable: "stale" });
    expect((await call("apply_edit_commands", { projectPath, commands: [{ type: "rename_project", name: "Fine" }] })).isError).toBe(false);
    expect(await observeGuiSession({})).toEqual({ observable: false, reason: "app_data_root_unknown" });
  }, 120_000);
});
