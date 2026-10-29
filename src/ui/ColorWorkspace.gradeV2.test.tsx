import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createDemoProject } from "../domain/demo";
import type { ColorGradeV2 } from "../domain/types";
import { FILM_LOOKS_V2 } from "../creative/filmLooksV2";
import { GradeV2Panel } from "./ColorWorkspace";

// Component callbacks and rendered markup only (hooks are inert doubles); colour is covered in src/color.
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useMemo: (factory: () => unknown) => factory(), useEffect: () => {}, useRef: () => ({ current: null }), useState: (initial: unknown) => [initial, () => {}] }));
type Element = ReactElement<Record<string, any>>;
function all(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(all);
  if (!isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...all(element.props.children)];
}
const byTestId = (elements: Element[], id: string) => elements.find(element => element.props["data-testid"] === id);

function setup(onGradeV2Change?: (grade: ColorGradeV2 | null) => void, gradeV2?: ColorGradeV2) {
  const project = createDemoProject();
  const clip = project.tracks[0].clips[0];
  if (gradeV2) clip.gradeV2 = gradeV2;
  return GradeV2Panel({ asset: project.assets[0], clip, colorManagement: project.colorManagement!, onGradeV2Change });
}

describe("Hao Film Looks v2 panel", () => {
  it("is view/export only until the editor passes onGradeV2Change", () => {
    const element = setup();
    const looks = all(element).filter(item => String(item.props["data-testid"] ?? "").startsWith("film-look-"));
    expect(looks.length).toBe(FILM_LOOKS_V2.filter(look => look.genre === "travel").length);
    expect(looks.every(item => item.props.disabled)).toBe(true);
    expect(renderToStaticMarkup(element)).toContain("這個版本還不能在這裡套用 v2 調色");
  });

  it("applies a look through the set_clip_grade_v2 callback and drops the not-wired note", () => {
    const change = vi.fn();
    const element = setup(change);
    const look = FILM_LOOKS_V2.find(item => item.genre === "travel")!;
    byTestId(all(element), `film-look-${look.id}`)!.props.onClick();
    expect(change).toHaveBeenLastCalledWith({ schema: "editkin.color-grade/v2", look: { id: look.id, strength: 1 } });
    const html = renderToStaticMarkup(element);
    expect(html).not.toContain("這個版本還不能在這裡套用 v2 調色");
    expect(html).toContain(look.certification.status === "certified" ? "已認證" : look.certification.status === "refused" ? "未通過" : "待審");
  });

  it("re-applies the active look at a new strength, removes with null and exports only with a grade", () => {
    const change = vi.fn();
    const active: ColorGradeV2 = { schema: "editkin.color-grade/v2", look: { id: "hfl2_food_warm_appetite", strength: 0.6 } };
    const elements = all(setup(change, active));
    // The panel opens on the active look's genre.
    expect(byTestId(elements, "grade-v2-genre")!.props.value).toBe("food");
    expect(byTestId(elements, "film-look-hfl2_food_warm_appetite")!.props["aria-pressed"]).toBe(true);
    byTestId(elements, "grade-v2-strength")!.props.onChange({ target: { value: "0.4" } });
    expect(change).toHaveBeenLastCalledWith({ schema: "editkin.color-grade/v2", look: { id: "hfl2_food_warm_appetite", strength: 0.4 } });
    byTestId(elements, "grade-v2-remove")!.props.onClick();
    expect(change).toHaveBeenLastCalledWith(null);
    expect(byTestId(elements, "grade-v2-export")!.props.disabled).toBe(false);
    expect(byTestId(all(setup(change)), "grade-v2-export")!.props.disabled).toBe(true);
  });

  it("explains the ACES 2.0 display-referred reconstruction only in ACES 2.0 Rec.709 SDR projects", () => {
    const project = createDemoProject();
    const clip = project.tracks[0].clips[0];
    const html = (patch: Partial<NonNullable<typeof project.colorManagement>>) =>
      renderToStaticMarkup(GradeV2Panel({ asset: project.assets[0], clip, colorManagement: { ...project.colorManagement!, ...patch }, onGradeV2Change: vi.fn() }));
    expect(html({ mode: "rec709", outputTransform: "rec709_sdr" })).not.toContain("grade-v2-aces-display-note");
    expect(html({ mode: "aces2", outputTransform: "rec709_sdr" })).toContain("grade-v2-aces-display-note");
    expect(html({ mode: "aces2", outputTransform: "rec2100_hlg_1000" })).not.toContain("grade-v2-aces-display-note");
  });
});
