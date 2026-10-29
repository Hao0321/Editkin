import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyCommand } from "../domain/commands";
import { createDemoProject } from "../domain/demo";
import type { EditorCommand } from "../domain/commandTypes";
import type { EditProject } from "../domain/types";
import { buildShortFormTemplateCommand } from "../application/shortFormTemplates";
import { isTemplateGeneratedCaption } from "../application/templateLifecycle";

/** B11 owner guard: an agent's raw delete_caption cannot remove a cue a title template owns (W2-4). */
const mocks = vi.hoisted(() => ({ readProject: vi.fn(), applyProjectCommands: vi.fn() }));
vi.mock("./storage", async importOriginal => ({ ...await importOriginal<typeof import("./storage")>(), readProject: mocks.readProject, applyProjectCommands: mocks.applyProjectCommands }));
import { applyEditCommandsWithTemplates } from "./templateFollowEditCommands";

let current: EditProject;
beforeEach(() => {
  vi.clearAllMocks();
  let id = 0;
  const source = { ...createDemoProject(), width: 1080, height: 1920 };
  current = applyCommand(source, buildShortFormTemplateCommand(source, "clean_tutorial", prefix => `${prefix}-${id++}`));
  current = applyCommand(current, { type: "add_caption", caption: { id: "ordinary", text: "一般字幕", start: 6, duration: 2 } });
  mocks.readProject.mockImplementation(async () => structuredClone(current));
  mocks.applyProjectCommands.mockImplementation(async (_path: string, commands: EditorCommand[]) => { current = applyCommand(current, { type: "batch", commands }); return current; });
});

describe("delete_caption owner guard on the agent surface", () => {
  it("refuses a template-owned cue, inside a batch too, and leaves the project untouched", async () => {
    const owned = current.captions.find(caption => isTemplateGeneratedCaption(caption))!;
    expect(owned).toBeDefined();
    await expect(applyEditCommandsWithTemplates("p.editkin.json", [{ type: "delete_caption", captionId: owned.id }])).rejects.toThrow("TEMPLATE_OWNED_CAPTION");
    await expect(applyEditCommandsWithTemplates("p.editkin.json", [{ type: "batch", commands: [{ type: "delete_caption", captionId: owned.id }] }])).rejects.toThrow("TEMPLATE_OWNED_CAPTION");
    expect(mocks.applyProjectCommands).not.toHaveBeenCalled();
  });

  it("still deletes an ordinary caption", async () => {
    await applyEditCommandsWithTemplates("p.editkin.json", [{ type: "delete_caption", captionId: "ordinary" }]);
    expect(current.captions.some(caption => caption.id === "ordinary")).toBe(false);
    expect(current.captions.some(caption => isTemplateGeneratedCaption(caption))).toBe(true);
  });
});
