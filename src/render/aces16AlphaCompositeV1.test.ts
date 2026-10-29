import { describe, expect, it } from "vitest";
import { aces16AlphaOverGraphV1 } from "./aces16AlphaCompositeV1";

describe("straight16 compositing admission", () => {
  it.each(["a;movie=evil", "a]", "", "1input"])("rejects a malformed internal label %j before graph construction", value => {
    expect(() => aces16AlphaOverGraphV1(value, "foreground", "out")).toThrow(/label/);
  });
  it.each(["normal;movie=evil", "multiply:enable=0", ""])("rejects a malformed mode %j", value => {
    expect(() => aces16AlphaOverGraphV1("base", "foreground", "out", value)).toThrow(/mode/);
  });
});
