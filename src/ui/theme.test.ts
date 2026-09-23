import { describe, expect, it } from "vitest";
import { normalizeEditorTheme } from "./theme";

describe("editor themes", () => {
  it("accepts the three product themes", () => {
    expect(normalizeEditorTheme("sky")).toBe("sky");
    expect(normalizeEditorTheme("candy")).toBe("candy");
    expect(normalizeEditorTheme("volt")).toBe("volt");
  });

  it("fails safely to the readable blue-white default", () => {
    expect(normalizeEditorTheme("unknown")).toBe("sky");
    expect(normalizeEditorTheme(null)).toBe("sky");
  });
});
