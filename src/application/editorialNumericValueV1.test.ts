import { describe, expect, it } from "vitest";
import { compareEditorialDecimalsV1, formatEditorialValueV1, editorialPercentageV1 } from "./editorialNumericValueV1";

describe("exact editorial data at the frozen renderer boundary", () => {
  it.each([["0", "0.000", 0], ["1.20", "1.2", 0], ["999999999999.123456", "999999999999.123457", -1], ["0.000001", "0", 1]] as const)("compares %s and %s without float coercion", (a, b, order) => {
    expect(compareEditorialDecimalsV1(a, b)).toBe(order);
  });
  it("keeps explicit units, grouping and decimal zeros, rejecting an actual renderer precision defect", () => {
    expect(formatEditorialValueV1("4990.00", { prefix: "NT$", suffix: "", groupThousands: true })).toBe("NT$4,990.00");
    expect(formatEditorialValueV1("3", { prefix: "", suffix: " 支", groupThousands: false })).toBe("3 支");
    expect(() => formatEditorialValueV1("999999999999.123456", { prefix: "", suffix: "", groupThousands: false })).toThrow("PRECISION");
  });
  it.each(["-0", "-1", "01", ".1", "1.", "1e3", "NaN", "1,000", "1.0000001", "1000000000000"])("refuses noncanonical/unsupported numeric copy %s", value => {
    expect(() => formatEditorialValueV1(value, { prefix: "", suffix: "", groupThousands: false })).toThrow();
  });
  it.each([["0", "3", 2, "0.00%"], ["1", "3", 2, "33.33%"], ["2", "3", 2, "66.67%"], ["1", "8", 0, "13%"], ["1", "8", 2, "12.50%"],
    ["9007199254740993", "9007199254740994", 4, "100.0000%"], ["3", "3", 0, "100%"]] as const)("rounds exact %s/%s to %d decimal places", (a, b, digits, result) => {
    expect(editorialPercentageV1(a, b, digits)).toBe(result);
  });
  it.each([["1", "0", 2], ["4", "3", 2], ["1.0", "3", 2], ["01", "3", 2], ["1", "3", 5]] as const)("rejects invalid progress %s/%s/%s", (a, b, d) => {
    expect(() => editorialPercentageV1(a, b, d)).toThrow();
  });
  it("refuses injected numeric units and labels that cannot fit the existing input contract", () => {
    for (const prefix of ["2x", "\\pos(1,2)", "{hi}", "\n"]) expect(() => formatEditorialValueV1("2", { prefix, suffix: "", groupThousands: false })).toThrow();
    expect(() => formatEditorialValueV1("999999999999", { prefix: "abcdefgh", suffix: "abcdefgh", groupThousands: true })).toThrow("LABEL_BUDGET");
  });
});
