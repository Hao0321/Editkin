import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { interfacePreferences } from "./i18n/interfacePreferences";
import { ClipGeometryControls, cropInsets, quarterTurn, UNCROPPED, withCropInset } from "./ClipGeometryControls";

afterEach(async () => { await interfacePreferences.setLocale("zh-TW"); });
describe("existing-style crop and quarter turns", () => {
  it("combines four percentage edges without changing the other edges", () => {
    const top = withCropInset(UNCROPPED, "top", 12.5), bottom = withCropInset(top, "bottom", 7.5);
    const left = withCropInset(bottom, "left", 10), result = withCropInset(left, "right", 20);
    expect(result).toEqual({ x: .1, y: .125, width: .7, height: .8 });
    expect(cropInsets(result)).toEqual({ top: 12.5, bottom: 7.5, left: 10, right: 20 });
  });
  it("rejects a vanished picture and invalid inputs without changing the current crop", () => {
    const crop = { x: .4, y: .1, width: .5, height: .7 }, before = { ...crop };
    expect(() => withCropInset(crop, "right", 60)).toThrow("保留畫面");
    for (const value of [NaN, Infinity, -1, 101]) expect(() => withCropInset(crop, "top", value)).toThrow("0%");
    expect(crop).toEqual(before);
  });
  it("wraps four successive quarter turns and preserves a free starting angle", () => {
    let rotation = 17; for (let i = 0; i < 4; i++) rotation = quarterTurn(rotation, 1);
    expect(rotation).toBe(17); expect(quarterTurn(quarterTurn(17, 1), -1)).toBe(17); expect(quarterTurn(90, 1)).toBe(-180);
  });
  it.each(["zh-TW", "en", "es", "ja", "ko"] as const)("shows four numeric percent inputs and existing panel grids in %s", async locale => {
    await interfacePreferences.setLocale(locale);
    const markup = renderToStaticMarkup(<ClipGeometryControls rotation={0} onCropChange={() => {}} onRotationChange={() => {}} />);
    expect(markup.match(/type="number"/g)).toHaveLength(4);
    expect(markup.match(/data-testid="clip-crop-/g)).toHaveLength(4);
    expect(markup).toContain('class="transform-grid"'); expect(markup).toContain('data-testid="clip-rotate-left"'); expect(markup).toContain('data-testid="clip-rotate-right"');
  });
});
