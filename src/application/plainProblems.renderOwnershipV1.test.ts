import { describe, expect, it } from "vitest";
import { describeProblem, problemCause } from "./plainProblems";

describe("render cleanup capacity at the UI boundary", () => {
  it.each(["RENDER_WORK_CLEANUP_BUSY", "RENDER_WORK_CLOSE_PENDING", "NATIVE_AUDIO_STAGE_CLEANUP_BUSY"])("uses existing translated wait advice for %s", code => {
    expect(problemCause("export", code)).toBe("busy");
    const problem = describeProblem("export", Error(code));
    expect(problem.what).toBe("Editkin 還在忙上一件工作。");
    expect(problem.detail).toContain(code);
    expect(problem.what + problem.todo).not.toContain(code);
  });
  it("offers existing save-and-restart advice for retained cleanup failure", () => {
    const problem = describeProblem("export", Error("RENDER_WORK_CLEANUP_FAILED"));
    expect(problem.cause).toBe("engineStopped");
    expect(problem.todo).toContain("先存檔");
    expect(problem.what + problem.todo).not.toContain("RENDER_WORK");
  });
});
