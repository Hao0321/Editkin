import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ENGINE_DEMO_SOURCE_URI,
  UI_DEMO_PREVIEW_URI,
  createDemoProject,
  createUiDemoProject,
} from "./demo";

describe("community-safe demo project", () => {
  it("starts with a neutral title and a rendered timeline", () => {
    const project = createDemoProject();
    expect(project.name).toBe("我的第一支影片");
    expect(project.name).not.toMatch(/Hao/i);
    expect(project.tracks[0].clips).toHaveLength(1);
  });

  it("keeps the engine fixture isolated from the UI-only preview media", () => {
    expect(createDemoProject().assets[0].uri).toBe(ENGINE_DEMO_SOURCE_URI);
    expect(createUiDemoProject().assets[0].uri).toBe(UI_DEMO_PREVIEW_URI);
    expect(ENGINE_DEMO_SOURCE_URI).toBe("demo-source.mp4");
    expect(UI_DEMO_PREVIEW_URI).toBe("editkin-demo-preview.mp4");
    expect(UI_DEMO_PREVIEW_URI).not.toBe(ENGINE_DEMO_SOURCE_URI);
  });

  it("wires the interactive app to the UI preview without changing engine callers", () => {
    const appSource = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
    expect(appSource).toMatch(/import\s*\{\s*createUiDemoProject\s*\}\s*from\s*["']\.\/domain\/demo["'];/);
    expect(appSource).toContain("const demo = createUiDemoProject();");
    expect(appSource).not.toContain("const demo = createDemoProject();");
  });
});
