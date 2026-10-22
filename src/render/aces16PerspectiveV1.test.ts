import { describe, expect, it } from "vitest";
import { aces16FilterOptionsV1, aces16PerspectiveFilterV1 } from "./aces16PerspectiveV1";
describe("16-bit perspective option and expression boundary", () => {
  it("preserves quoted colons and escaped comma expressions", () => {
    expect(aces16FilterOptionsV1("x0='if(gt(on\\,2)\\,8\\,0)':x1=W:y0='1:2'")).toEqual({ x0: "if(gt(on,2),8,0)", x1: "W", y0: "1:2" });
  });
  it.each(["x0=1:x0=2", "x0='unterminated", "x0=1\\", "wrong-key=2", "12", ":x0=1"])("rejects malformed options %s", text => expect(() => aces16FilterOptionsV1(text)).toThrow());
  it.each(["perspective=eval=other", "perspective=sense=other", "perspective=interpolation=lanczos", "perspective=unknown=1", "rotate=0"])("rejects unsupported internal filter %s", text => expect(() => aces16PerspectiveFilterV1(text)).toThrow());
  it("retains one-based frame corners and freezes initial corners", () => {
    const dynamic = aces16PerspectiveFilterV1("perspective=x0=on:x1=W+in:eval=frame:interpolation=cubic:sense=destination");
    expect(dynamic).toContain("(N+1)"); expect(dynamic).toContain("interpolation=nearest"); expect(dynamic).toContain("alpha("); expect(dynamic).not.toContain("format=rgba");
    const initial = aces16PerspectiveFilterV1("perspective=x0=on:x1=W+in:eval=init");
    expect(initial).not.toContain("N+1"); expect(initial).toContain("interpolation=bilinear");
  });
});
