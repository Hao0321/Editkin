import { describe, expect, it } from "vitest";
import { editkinModuleRegistry } from "../src/modules/moduleRegistry";
import { MOTION_LIBRARY_MODULE_IDS_V1, motionLibraryModuleVariantSnapshotV1 } from "../src/modules/motionLibraryModulesV1";
import { STYLE_TEMPLATE_MODULE_ID_V1, styleTemplateModuleVariantSnapshotV1 } from "../src/modules/styleTemplateModulesV1";
import { styleSlotTemplatesV1 } from "../src/styleTemplates/slots/slotCatalog";
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
    for (const module of data.modules.filter(module => !motionLibraryIds.has(module.id) && module.id !== STYLE_TEMPLATE_MODULE_ID_V1)) {
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

describe("module registry export: style template slots (graphic.style_template)", () => {
  it("exports every slot template with its slots, component, art status and implementation, equal to the live catalogue", () => {
    const row = exported().modules.find(module => module.id === STYLE_TEMPLATE_MODULE_ID_V1)!;
    expect(row).toBeDefined();
    const live = styleTemplateModuleVariantSnapshotV1().variants;
    expect(row.variants.map(variant => ({ id: variant.id, artStatus: variant.artStatus, implemented: variant.implemented, slots: variant.slots, clip: variant.clip })))
      .toEqual(live.map(variant => ({ id: variant.id, artStatus: variant.artStatus, implemented: variant.implemented, slots: variant.slots, clip: variant.clip })));
    expect(row.variants.map(variant => variant.id)).toEqual([...styleSlotTemplatesV1().keys()]);
    const s1 = row.variants.find(variant => variant.id === "S1_explainer_ui") as unknown as { implemented: boolean; slots: { text: Array<{ id: string; maxLength: number; label: Record<string, string> }>;
      color: Array<{ role: string; default: string }>; image: Array<{ id: string; consumers: string[] }> } };
    expect(s1.implemented).toBe(true);
    expect(s1.slots.text.find(slot => slot.id === "keyword")).toMatchObject({ maxLength: 8, label: { "zh-TW": "重點大字", en: "Keyword", es: "Palabra clave", ja: "キーワード", ko: "키워드" } });
    expect(s1.slots.color.map(slot => [slot.role, slot.default])).toEqual([["accent", "#FCC834"], ["ink", "#121214"]]);
    expect(s1.slots.image[0]).toMatchObject({ id: "card", consumers: ["uiCardScene.card.image:svg_image"] });
    // 3D templates reference mesh3d components and mesh consumers; built 2026-10-23, certified by Hao 2026-10-29.
    const s4 = row.variants.find(variant => variant.id === "S4_motion_promo_3d") as unknown as { implemented: boolean; clip: { renderer: string; component: string };
      slots: { image: Array<{ consumers: string[] }>; text: Array<{ consumers: string[] }>; color: Array<{ consumers: string[] }> } };
    expect(s4).toMatchObject({ implemented: true, artStatus: "certified", clip: { renderer: "mesh3d", component: "mesh3dDeviceScreen" } });
    expect(row.variants.find(variant => variant.id === "S1_explainer_ui")).toMatchObject({ artStatus: "pending" });
    expect(s4.slots.image[0].consumers).toEqual(["mesh3dDeviceScreen.screen.texture:mesh_texture"]);
    expect(s4.slots.text[0].consumers).toEqual(["mesh3dExtrudedTitle.title.mesh:mesh_text_extruded"]);
    expect(s4.slots.color.flatMap(slot => slot.consumers).some(consumer => consumer.endsWith(":light_color"))).toBe(true);
  });
});
