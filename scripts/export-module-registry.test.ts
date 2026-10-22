import { describe, expect, it } from "vitest";
import { editkinModuleRegistry } from "../src/modules/moduleRegistry";
import { MOTION_LIBRARY_MODULE_IDS_V1, motionLibraryModuleVariantSnapshotV1 } from "../src/modules/motionLibraryModulesV1";
import { moduleRegistryExport } from "./export-module-registry";

type ExportedVariant = { id: string; artStatus?: string; use?: string } & Record<string, unknown>;
type Exported = { moduleRegistry: unknown; modules: Array<{ id: string; variants: ExportedVariant[] }> };

const motionLibraryIds: ReadonlySet<string> = new Set(Object.values(MOTION_LIBRARY_MODULE_IDS_V1));
const exported = () => JSON.parse(JSON.stringify(moduleRegistryExport())) as Exported;

describe("module registry export: Motion Library artStatus (Phase 3 hook request 4)", () => {
  it("every Motion Library variant carries the manifest's artStatus, which equals the live catalog", () => {
    const registry = editkinModuleRegistry(), live = motionLibraryModuleVariantSnapshotV1(), data = exported();
    for (const [kind, moduleId] of Object.entries(MOTION_LIBRARY_MODULE_IDS_V1) as Array<[keyof typeof MOTION_LIBRARY_MODULE_IDS_V1, string]>) {
      const row = data.modules.find(module => module.id === moduleId)!;
      const manifest = registry.get(moduleId)!.manifest;
      expect(row.variants.map(variant => [variant.id, variant.artStatus])).toEqual(manifest.variants.map(variant => [variant.id, variant.artStatus]));
      expect(row.variants.map(variant => [variant.id, variant.artStatus])).toEqual(live[kind].map(variant => [variant.id, variant.artStatus]));
      for (const variant of row.variants) expect(["certified", "pending"]).toContain(variant.artStatus);
    }
  });

  it("adds no artStatus to any other module and leaves the registry identity unchanged", () => {
    const data = exported(), earlierKeys = new Set(["id", "name", "family", "roles", "formats", "intensity", "use"]);
    for (const module of data.modules.filter(module => !motionLibraryIds.has(module.id))) {
      for (const variant of module.variants) expect(Object.keys(variant).filter(key => !earlierKeys.has(key))).toEqual([]);
    }
    expect(data.moduleRegistry).toEqual(editkinModuleRegistry().identity);
  });

  it("a certified T24 still says it is not a VA default, so offline readers do not treat certified as auto-pickable", () => {
    const text = exported().modules.find(module => module.id === MOTION_LIBRARY_MODULE_IDS_V1.text)!;
    const t24 = text.variants.find(variant => variant.id === "T24")!;
    expect(t24.use).toContain("不是 VA 預設");
  });
});
