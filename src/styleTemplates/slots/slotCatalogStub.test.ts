import { describe, expect, it, vi } from "vitest";

// A real stub document: S5's declarations with `stub: true` (slots ahead of the art), as a template is before its
// components exist. The catalogue, compile and VA module must all treat it as not implemented, never certified.
vi.mock("../templates/S5_vox_collage.slots.json", async importOriginal => {
  const real = (await importOriginal<{ default: Record<string, unknown> }>()).default;
  return { default: { ...real, stub: true, artStatus: "pending" } };
});

const { compileStyleTemplateClipV1 } = await import("./compileClip");
const { styleSlotTemplatesV1 } = await import("./slotCatalog");
const { styleTemplateAutoPickCandidatesV1, styleTemplateModuleVariantV1 } = await import("../../modules/styleTemplateModulesV1");

const code = (run: () => unknown) => { try { run(); } catch (error) { return (error as { code?: string }).code ?? (error as Error).message; } return "accepted"; };

describe("a stub slot template (stub: true)", () => {
  it("lists with its slots but is not implemented, is refused by compile, and is never auto-picked", () => {
    const stub = styleSlotTemplatesV1().get("S5_vox_collage")!;
    expect(stub).toMatchObject({ stub: true, implemented: false, artStatus: "pending" });
    expect(stub.slots.text.map(slot => slot.id)).toContain("wordmark");
    expect(code(() => compileStyleTemplateClipV1({ templateId: "S5_vox_collage", slots: { text: { wordmark: "鶯歌" }, color: {}, image: {} },
      frame: { width: 1080, height: 1920, fps: 30 }, images: {} }))).toBe("STYLE_TEMPLATE_NOT_IMPLEMENTED");
    expect(styleTemplateAutoPickCandidatesV1({ videoType: "explainer" })).toEqual([]);
    expect(styleTemplateModuleVariantV1(stub)).toMatchObject({ implemented: false, artStatus: "pending" });
    expect(styleTemplateModuleVariantV1(stub).use).toContain("refused by prepare");
    // The certified, built templates are unaffected.
    expect(styleSlotTemplatesV1().get("S4_motion_promo_3d")).toMatchObject({ stub: false, implemented: true, artStatus: "certified" });
  });
});
