import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { runLongformUiFocusProjectProcessV1 } from "./longformUiFocusProjectProcessV1";
import { uiFocusProjectTraceFixtureV1 } from "./longformUiFocusProjectTraceV1.fixture";
const nodeArgs = (script: string) => ["-e",script];
describe("source/project clock bounded actual stdio protocol controls", () => {
  it("joins independently arriving raw and metadata pipes without retaining unselected prefix pixels", async () => {
    const f = uiFocusProjectTraceFixtureV1(), log = JSON.stringify(f.lines.join("\n")+"\n");
    const result = await runLongformUiFocusProjectProcessV1(process.execPath,nodeArgs(`process.stdout.write(Buffer.from('${f.pixels.toString("base64")}','base64'));setTimeout(()=>process.stderr.write(${log}),20);`),f.config,row => row.sourcePts === 133);
    expect(result.frames.map(row => [row.projectFrame,row.sourcePts])).toEqual([[3,133],[4,133]]);
    expect(result.frames.every(row => row.imageSha256 === createHash("sha256").update(f.pixels.subarray(0,256)).digest("hex"))).toBe(true);
    expect(result.stdoutBytes).toBe(1024); expect(result.outputFramesObserved).toBe(4);
  });
  it("rejects incomplete raw-frame coverage after the real child closes", async () => {
    const f = uiFocusProjectTraceFixtureV1(), log = JSON.stringify(f.lines.join("\n")+"\n");
    await expect(runLongformUiFocusProjectProcessV1(process.execPath,nodeArgs(`process.stderr.write(${log});process.stdout.write(Buffer.alloc(1023));`),f.config,()=>true)).rejects.toThrow("BYTE_COVERAGE");
  });
  it("does not publish valid partial frames from a nonzero child", async () => {
    const f = uiFocusProjectTraceFixtureV1();
    await expect(runLongformUiFocusProjectProcessV1(process.execPath,nodeArgs("process.exitCode=7"),f.config,()=>true)).rejects.toThrow("PROCESS_EXIT_7");
  });
  it("settles a cancelled real Node protocol child and rejects pre-aborted admission", async () => {
    const f = uiFocusProjectTraceFixtureV1(), controller = new AbortController();
    const pending = runLongformUiFocusProjectProcessV1(process.execPath,nodeArgs("setInterval(()=>{},1000)"),f.config,()=>true,controller.signal);
    setTimeout(()=>controller.abort(),30); await expect(pending).rejects.toThrow("analysis-cancelled");
    expect(()=>runLongformUiFocusProjectProcessV1(process.execPath,[],f.config,()=>true,controller.signal)).toThrow();
  });
});
