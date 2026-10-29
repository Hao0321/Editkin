import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectReferenceMotionTemplateInstance, TEMPLATE_UPDATE_EDITED } from "../application/referenceMotionTemplateInstances";
import { instanceOf, oldTitlesProject } from "../application/oldTitleTemplatesFixture";
import { readProject } from "./storage";

// Video Autopilot's path: the registered inspect_reference_motion_instances and apply_edit_commands tools (input schema,
// handler, the command application that writes the file) on a real project file, with the real compiler and the bundled
// fonts. Only the MCP transport is replaced.
type Tool = { configuration: { inputSchema: { parse(value: unknown): unknown } }; handler: (input: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> };
const mocks = vi.hoisted(() => ({ tools: new Map<string, Tool>() }));
vi.mock("@modelcontextprotocol/server", () => ({ McpServer: class {
  registerTool(name: string, configuration: Tool["configuration"], handler: Tool["handler"]) { mocks.tools.set(name, { configuration, handler }); }
} }));
vi.mock("@modelcontextprotocol/server/stdio", () => ({ serveStdio: () => ({ close: async () => {} }) }));
import { createServer } from "./server";

const roots: string[] = [], previousWorkspace = process.env.EDITKIN_WORKSPACE;
beforeEach(() => { mocks.tools.clear(); createServer(); });
afterEach(async () => {
  if (previousWorkspace === undefined) delete process.env.EDITKIN_WORKSPACE; else process.env.EDITKIN_WORKSPACE = previousWorkspace;
  for (const root of roots.splice(0)) {
    const absolute = resolve(root);
    if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith("editkin-title-update-mcp-")) throw new Error("Refusing unowned fixture cleanup");
    await rm(absolute, { recursive: true, force: true });
  }
});

/** The old-titles project saved in its own workspace. */
async function saved() {
  const root = await mkdtemp(join(tmpdir(), "editkin-title-update-mcp-")); roots.push(root); process.env.EDITKIN_WORKSPACE = root;
  const f = await oldTitlesProject({ mediaUri: join(root, "trip.mp4") });
  const path = join(root, "old.editkin.json");
  await writeFile(path, JSON.stringify(f.project));
  return { ...f, path };
}
async function call(name: string, input: unknown) {
  const tool = mocks.tools.get(name)!;
  const result = await tool.handler(tool.configuration.inputSchema.parse(input));
  return { isError: result.isError, body: JSON.parse(result.content[0].text) };
}
const texts = (project: Awaited<ReturnType<typeof readProject>>, id: string) => {
  const { input, roles } = instanceOf(project, id);
  return [input.title, input.kicker, input.subtitle, ...roles.filter(role => role.kind === "graphic").map(role => project.motionGraphics.find(graphic => graphic.id === role.id)?.text)];
};

describe("an agent updates old titles: inspect_reference_motion_instances prepareUpdate, then apply_edit_commands", () => {
  it("prepares the update read-only, applies it in one write, and the old title is CURRENT with its words unchanged", async () => {
    const f = await saved(), bytes = await readFile(f.path);
    const inspected = await call("inspect_reference_motion_instances", { projectPath: f.path, prepareUpdate: true });
    expect(inspected.isError).toBeUndefined();
    expect(await readFile(f.path)).toEqual(bytes);
    const { update } = inspected.body;
    expect(update).toMatchObject({ applyWith: "apply_edit_commands", expectedRevision: f.project.revision,
      updated: [{ instanceId: f.ids.fresh, title: "FOCUS" }],
      notUpdated: [{ instanceId: f.ids.edited, title: "RIVER", reason: TEMPLATE_UPDATE_EDITED },
        { instanceId: f.ids.short, title: "BATS", reason: "片段只有 2.00 秒，這個模板至少要 3.00 秒；先把片段拉長。" }] });
    expect(update.commands).toHaveLength(1);
    expect(update.commands[0].type).toBe("batch");

    const applied = await call("apply_edit_commands", { projectPath: f.path, commands: update.commands, expectedRevision: update.expectedRevision });
    expect(applied.isError).toBeUndefined();
    // The update manages its own templates: nothing is reported as needing a re-apply.
    // W2-2 B3: the summary also carries the saved file SHA and media state; no templateFollow is reported.
    expect(applied.body).toEqual({ status: "GREEN", appliedCommandCount: 1, summary: applied.body.summary,
      projectSha256: expect.stringMatching(/^[a-f0-9]{64}$/), missingMedia: applied.body.missingMedia, outsideWorkspaceMedia: applied.body.outsideWorkspaceMedia });
    const written = await readProject(f.path);
    expect(written.revision).toBe(f.project.revision + 1);
    expect((await inspectReferenceMotionTemplateInstance(written, f.ids.fresh)).status).toBe("CURRENT");
    expect(texts(written, f.ids.fresh)).toEqual(texts(f.project, f.ids.fresh));
    for (const id of [f.ids.edited, f.ids.current, f.ids.short]) expect(instanceOf(written, id)).toEqual(instanceOf(f.project, id));

    // Asked again, there is nothing left to apply.
    const again = await call("inspect_reference_motion_instances", { projectPath: f.path, prepareUpdate: true });
    expect(again.body.update).toMatchObject({ expectedRevision: written.revision, updated: [], commands: [] });
    expect(again.body.update.notUpdated.map((row: { instanceId: string }) => row.instanceId)).toEqual([f.ids.edited, f.ids.short]);
  }, 180_000);

  it("refuses to apply an update prepared on an older revision of the project, and writes nothing", async () => {
    const f = await saved();
    const { body } = await call("inspect_reference_motion_instances", { projectPath: f.path, prepareUpdate: true });
    // Someone edits the project meanwhile (moves an unrelated clip later).
    await call("apply_edit_commands", { projectPath: f.path, commands: [{ type: "move_clip", clipId: "d", timelineStart: 30 }] });
    const before = await readFile(f.path);
    const stale = await call("apply_edit_commands", { projectPath: f.path, commands: body.update.commands, expectedRevision: body.update.expectedRevision });
    expect(stale.isError).toBe(true);
    expect(await readFile(f.path)).toEqual(before);
    expect((await inspectReferenceMotionTemplateInstance(await readProject(f.path), f.ids.fresh)).status).toBe("ENVIRONMENT_CHANGED");
  }, 180_000);

  it("without prepareUpdate the inspection is exactly as before", async () => {
    const f = await saved();
    const { body } = await call("inspect_reference_motion_instances", { projectPath: f.path });
    expect(Object.keys(body).sort()).toEqual(["artwork", "instances", "readOnly", "schema"]);
    expect(body.instances.map((row: { inspection: { status: string } }) => row.inspection.status)).toEqual(["ENVIRONMENT_CHANGED", "ENVIRONMENT_CHANGED", "EDITED", "ENVIRONMENT_CHANGED"]);
  }, 120_000);
});
