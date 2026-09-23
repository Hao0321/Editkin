import { describe, expect, it } from "vitest";
import { HaoExpressionError, assertHaoExpression, evaluateHaoExpression, haoExpressionToFfmpeg } from "./expression";

const context = { frame: 15, fps: 30, time: 0.5, inPoint: 0, outPoint: 2, duration: 2, value: 10, entrance: 0.5, exit: 1 };

describe("hao.expression/v1", () => {
  it("evaluates the Wave 2 expression contract deterministically", () => {
    const source = "hao.expression/v1:easeOut(clamp((time-inPoint)/0.28,0,1))";
    expect(evaluateHaoExpression(source, context)).toBe(1);
    expect(evaluateHaoExpression("hao.expression/v1:entrance*exit", context)).toBe(0.5);
    expect(evaluateHaoExpression("hao.expression/v1:value+sin(frame/fps)", context))
      .toBe(evaluateHaoExpression("hao.expression/v1:value+sin(frame/fps)", context));
  });

  it("rejects arbitrary JavaScript, unknown names, invalid math and resource exhaustion", () => {
    for (const source of [
      "Math.random()", "hao.expression/v1:globalThis.process", "hao.expression/v1:fetch(1)",
      "hao.expression/v1:value/0", `hao.expression/v1:${"(".repeat(30)}1${")".repeat(30)}`,
    ]) expect(() => evaluateHaoExpression(source, context)).toThrow(HaoExpressionError);
  });

  it("compiles the same bounded AST to FFmpeg expressions", () => {
    const source = "hao.expression/v1:clamp(value*easeOut(time/duration),0,100)";
    assertHaoExpression(source);
    const compiled = haoExpressionToFfmpeg(source, {
      frame: "n", fps: "30", time: "t", inPoint: "0", outPoint: "2", duration: "2", value: "10", entrance: "1", exit: "1",
    });
    expect(compiled).toContain("min(max");
    expect(compiled).not.toContain("Math");
  });
});
