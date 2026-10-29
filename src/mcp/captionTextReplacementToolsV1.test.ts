import { describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/server";
import { createEmptyProject } from "../domain/editGraph";
import { editorCommandSchema } from "../domain/schema";
import { findCaptionTextInputV1, prepareCaptionTextReplacementInputV1, registerCaptionTextReplacementToolsV1 } from "./captionTextReplacementToolsV1";

function fixture() {
  const project = createEmptyProject("Caption source", { id: "caption-source", fps: 30 });
  project.captions = [{ id: "A", text: "Cloud Code 與 Cloud Code", start: 0, duration: 2 },
    { id: "B", text: "下一句 Cloud Code 😃", start: 2, duration: 2 }];
  const handlers = new Map<string, (input: unknown) => Promise<any>>(), configs = new Map<string, any>();
  const server = { registerTool: (name: string, config: unknown, handler: (input: unknown) => Promise<any>) => {
    handlers.set(name, handler); configs.set(name, config);
  } } as unknown as McpServer;
  const read = vi.fn(async () => structuredClone(project));
  registerCaptionTextReplacementToolsV1(server, { readProject: read });
  const request = { projectPath: "D:/owned/caption-source.json", expectedProjectRevision: project.revision, query: "Cloud Code" };
  async function call(name: string, input: unknown) {
    const result = await handlers.get(name)!(input);
    return { result, data: JSON.parse(result.content.find((row: { type: string }) => row.type === "text").text) };
  }
  return { project, request, handlers, configs, read, call };
}
describe("read-only caption find/prepare MCP", () => {
  it("registers only the two read-only tools and rejects undeclared input fields", () => {
    const f = fixture();
    expect([...f.handlers.keys()]).toEqual(["find_caption_text", "prepare_caption_text_replacement"]);
    for (const config of f.configs.values()) expect(config.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    expect(findCaptionTextInputV1.safeParse({ ...f.request, regex: true }).success).toBe(false);
    expect(prepareCaptionTextReplacementInputV1.safeParse({ ...f.request, replacement: "Claude Code", apply: true }).success).toBe(false);
    expect(findCaptionTextInputV1.safeParse({ ...f.request, limit: 201 }).success).toBe(false);
  });
  it("returns actual source revision/hash and paged original text without writes", async () => {
    const f = fixture(), before = structuredClone(f.project);
    const { result, data } = await f.call("find_caption_text", { ...f.request, limit: 1 });
    expect(result.isError).not.toBe(true); expect(data.binding.projectId).toBe(f.project.id);
    expect(data.binding.projectSha256).toMatch(/^[a-f0-9]{64}$/); expect(data.matchingCues).toBe(2);
    expect(data.totalOccurrences).toBe(3); expect(data.matches[0].text).toBe(f.project.captions[0].text); expect(data.nextOffset).toBe(1);
    expect(f.project).toEqual(before); expect(f.read).toHaveBeenCalledTimes(1);
  });
  it("prepares ordinary valid text-only drafts under the existing audit/apply boundary", async () => {
    const f = fixture(), before = structuredClone(f.project);
    const { result, data } = await f.call("prepare_caption_text_replacement", { ...f.request, replacement: "Claude Code" });
    expect(result.isError).not.toBe(true); expect(data.status).toBe("PREPARED"); expect(data.changedCues).toBe(2);
    expect(data.boundary).toBe("ordinary_edit_drafts_only_not_apply_or_authorization");
    expect(data.commands).toEqual([{ type: "update_caption", captionId: "A", patch: { text: "Claude Code 與 Claude Code" } },
      { type: "update_caption", captionId: "B", patch: { text: "下一句 Claude Code 😃" } }]);
    for (const command of data.commands) expect(editorCommandSchema.safeParse(command).success).toBe(true);
    expect(f.project).toEqual(before);
  });
  it("rejects stale source revision, locks and an empty result cue before returning drafts", async () => {
    const f = fixture(), before = structuredClone(f.project);
    expect((await f.call("prepare_caption_text_replacement", { ...f.request, expectedProjectRevision: f.project.revision + 1, replacement: "Claude" })).result.isError).toBe(true);
    expect((await f.call("prepare_caption_text_replacement", { ...f.request, query: f.project.captions[0].text, replacement: "" })).result.isError).toBe(true);
    expect(f.project).toEqual(before);
    f.project.tracks.push({ id: "caption-lock", kind: "caption", name: "Captions", locked: true, muted: false, clips: [] });
    const blocked = await f.call("prepare_caption_text_replacement", { ...f.request, replacement: "Claude Code" });
    expect(blocked.result.isError).toBe(true);
  });
  it("keeps the existing100-command contract rather than nesting/bypassing it", async () => {
    const f = fixture(); f.project.captions = Array.from({ length: 101 }, (_, i) => ({ id: `C${i}`, text: "Cloud Code", start: i, duration: 1 }));
    const blocked = await f.call("prepare_caption_text_replacement", { ...f.request, replacement: "Claude Code" });
    expect(blocked.result.isError).toBe(true); expect(JSON.stringify(blocked.data)).toContain("EXISTING_V4_COMMAND_LIMIT");
    const ready = await f.call("prepare_caption_text_replacement", { ...f.request, replacement: "Claude Code", captionIds: f.project.captions.slice(0, 100).map(cue => cue.id) });
    expect(ready.result.isError).not.toBe(true); expect(ready.data.commands).toHaveLength(100);
    expect(ready.data.commands.every((command: { type: string }) => command.type === "update_caption")).toBe(true);
    expect(f.project.captions.every(cue => cue.text === "Cloud Code")).toBe(true);
  });
  it("bounds read-only responses and reports unchanged without a fake edit", async () => {
    const f = fixture();
    const unchanged = await f.call("prepare_caption_text_replacement", { ...f.request, replacement: f.request.query });
    expect(unchanged.data.status).toBe("UNCHANGED"); expect(unchanged.data.commands).toEqual([]);
    f.project.captions[0].text = "Cloud Code" + "x".repeat(270000);
    const blocked = await f.call("find_caption_text", f.request);
    expect(blocked.result.isError).toBe(true); expect(JSON.stringify(blocked.data)).toContain("RESPONSE_BUDGET");
    expect(f.project.captions[0].text.length).toBe(270010);
  });
});
