import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { moduleRegistryExport } from "../../scripts/export-module-registry";
import { MOTION_LIBRARY_CATALOG } from "../motionLibrary/catalog";
import { editkinModuleRegistry } from "./moduleRegistry";
import { describeEditkinModuleV2, listEditkinModulesV2 } from "./moduleRegistryV2";
import { editkinModuleMetadataRegistryV2 } from "./moduleMetadataRuntimeV2";
import {
  MOTION_LIBRARY_MODULE_IDS_V1, MotionLibraryModuleRefusalV1, motionLibraryAutoPickCandidatesV1, motionLibraryModuleVariantSnapshotV1, prepareTextMotionModuleV1,
} from "./motionLibraryModulesV1";
import type { ModuleCall } from "./moduleTypes";

const ids = Object.values(MOTION_LIBRARY_MODULE_IDS_V1);

describe("Motion Library module manifests", () => {
  it("the checked-in variant snapshot equals the live catalog (re-generate it when certifications or items change)", async () => {
    const snapshot = JSON.parse(await readFile(resolve("src/modules/motionLibraryModuleVariantsV1.json"), "utf8"));
    expect(snapshot).toEqual(JSON.parse(JSON.stringify(motionLibraryModuleVariantSnapshotV1())));
  });

  it("round-trips: source manifests → generated metadata → registry export, with every catalog item as a variant", () => {
    const eager = editkinModuleRegistry(), generated = editkinModuleMetadataRegistryV2();
    for (const [kind, moduleId] of Object.entries(MOTION_LIBRARY_MODULE_IDS_V1)) {
      const manifest = eager.get(moduleId)!.manifest;
      expect(generated.get(moduleId)!.manifest).toEqual(manifest);
      expect(generated.get(moduleId)!.manifestSha256).toBe(eager.get(moduleId)!.manifestSha256);
      expect(manifest).toMatchObject({ status: "available", invoke: { tool: "prepare_editkin_module" } });
      expect(manifest.variantField).toBeUndefined();
      expect(manifest.variants.map(variant => variant.id)).toEqual(MOTION_LIBRARY_CATALOG.filter(item => item.kind === kind).map(item => item.id));
    }
    expect(generated.identity).toEqual(eager.identity);
    const exported = JSON.parse(JSON.stringify(moduleRegistryExport())) as { moduleRegistry: unknown; modules: Array<{ id: string; variants: Array<{ id: string; name: string; family?: string; roles?: string[] }> }> };
    expect(exported.moduleRegistry).toEqual(eager.identity);
    for (const moduleId of ids) {
      const row = exported.modules.find(module => module.id === moduleId)!, manifest = eager.get(moduleId)!.manifest;
      expect(row.variants.map(({ id, name, family, roles }) => ({ id, name, family, roles }))).toEqual(manifest.variants.map(({ id, name, family, roles }) => ({ id, name, family, roles })));
    }
  });

  it("is discoverable by kind and described with its input schema", async () => {
    expect(listEditkinModulesV2({ kind: "background" }).modules.map(module => module.id)).toEqual(["background.motion_loop"]);
    const described = await describeEditkinModuleV2("graphic.text_motion");
    expect(described.inputs.autoFilled).toEqual(["projectPath"]);
    expect(Object.keys((described.inputs.schema as { properties: object }).properties)).toEqual(expect.arrayContaining(["startFrame", "lines", "palette", "family", "role"]));
  });

  it("auto-pick candidates are only implemented, certified items, never a VA exclusion such as T24", () => {
    for (const kind of ["text", "transition", "background"] as const) {
      const families = [...new Set(MOTION_LIBRARY_CATALOG.filter(item => item.kind === kind).map(item => item.category))];
      for (const filter of [{}, ...families.map(family => ({ family }))]) {
        for (const item of motionLibraryAutoPickCandidatesV1(kind, filter)) {
          expect(item).toMatchObject({ kind, implemented: true, artStatus: "certified" });
          expect(item.tags).not.toContain("no_va_default");
        }
      }
    }
    expect(motionLibraryAutoPickCandidatesV1("text").map(item => item.id)).not.toContain("T24");
  });

  it("never auto-picks a transition that burns in a fixed word (X20 「轉場」), whatever the filter", () => {
    const x20 = MOTION_LIBRARY_CATALOG.find(item => item.id === "X20")!;
    const roles = [...new Set(MOTION_LIBRARY_CATALOG.filter(item => item.kind === "transition").flatMap(item => item.tags))];
    for (const filter of [{}, { family: x20.category }, ...roles.map(role => ({ role })), ...roles.map(role => ({ family: x20.category, role }))]) {
      expect(motionLibraryAutoPickCandidatesV1("transition", filter).map(item => item.id)).not.toContain("X20");
    }
    const notes = motionLibraryModuleVariantSnapshotV1();
    expect(notes.transition.find(variant => variant.id === "X20")!.use).toContain("「轉場」");
    // Text variants never present the sample text as content (M10).
    for (const variant of notes.text) expect(variant.use?.startsWith("必須自己傳 lines")).toBe(true);
  });

  it("refuses text without the caller's own lines before reading or rendering anything (M10)", async () => {
    const call = (inputs: Record<string, unknown>): ModuleCall => ({ projectPath: "never-read.editkin.json", inputs, environment: {} });
    for (const inputs of [{ startFrame: 0 }, { startFrame: 0, lines: [] }, { startFrame: 0, lines: "12,480" }]) {
      const error = await prepareTextMotionModuleV1(call(inputs)).then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(MotionLibraryModuleRefusalV1);
      expect((error as MotionLibraryModuleRefusalV1).code).toBe("MOTION_LIBRARY_TEXT_LINES_REQUIRED");
    }
  });
});
