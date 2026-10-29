import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import verdicts from "./localPathVerdicts.json";
import { assertLocalMediaPath, localPathTextProblem, type LocalPathProblem } from "./localMediaPath";
import { problemCause } from "../application/plainProblems";
import { inspectMedia } from "../application/inspectMedia";
import { probeMedia, resolveMediaPath } from "../render/mediaProcess";

type Verdict = LocalPathProblem | "local";
interface Row { path: string; verdict: Verdict }
const expected = (row: Row): LocalPathProblem | undefined => row.verdict === "local" ? undefined : row.verdict;
const windows = verdicts.windows as Row[];
const posix = verdicts.posix as Row[];
const NETWORK = "拒絕網路共用或裝置路徑作為媒體來源，請先以一般檔名複製到本機磁碟：";
const STREAM = "拒絕檔名裡帶冒號的路徑作為媒體來源（這是檔案的隱藏資料串流，不是檔案本身），請改用一般檔名：";

/**
 * One table, two languages: the desktop host's `local_path_text_problem` runs the same rows in
 * src-tauri/src/media_source_path_tests.rs (include_str! of this JSON), so the Rust and Node rules cannot drift.
 */
describe("local path verdicts shared with the desktop host", () => {
  it("is the table the Rust test reads, and has rows for every verdict", () => {
    expect(verdicts.schema).toBe("editkin.local-path-verdicts/v1");
    const rust = readFileSync(resolve(import.meta.dirname, "../../src-tauri/src/media_source_path_tests.rs"), "utf8");
    expect(rust).toContain('include_str!("../../src/shared/localPathVerdicts.json")');
    expect(new Set(windows.map(row => row.verdict))).toEqual(new Set(["local", "not_absolute", "network_or_device", "alternate_stream"]));
    expect(new Set(posix.map(row => row.verdict))).toEqual(new Set(["local", "not_absolute"]));
  });

  it.each(windows)("win32 $path → $verdict", row => {
    expect(localPathTextProblem(row.path, "win32")).toBe(expected(row));
  });

  it.each(posix)("posix $path → $verdict", row => {
    expect(localPathTextProblem(row.path, "linux")).toBe(expected(row));
    expect(localPathTextProblem(row.path, "darwin")).toBe(expected(row));
  });

  it("the Node service refuses exactly the network, device and stream rows, with the desktop host's messages", () => {
    for (const row of windows) {
      const refuse = () => assertLocalMediaPath(row.path, "win32");
      if (row.verdict === "network_or_device") expect(refuse, row.path).toThrow(`${NETWORK}${row.path}`);
      else if (row.verdict === "alternate_stream") expect(refuse, row.path).toThrow(`${STREAM}${row.path}`);
      // Relative paths stay the caller's business, as before.
      else expect(refuse, row.path).not.toThrow();
    }
    for (const row of posix) expect(() => assertLocalMediaPath(row.path, "linux"), row.path).not.toThrow();
  });

  it("a stream refusal is not described as a network drive; a network one still is", () => {
    for (const action of ["import", "relink", "open", "export"] as const) {
      expect(problemCause(action, `${STREAM}C:\\media\\clip.mp4:stream`)).not.toBe("networkPath");
      expect(problemCause(action, `${NETWORK}\\\\nas\\clip.mp4`)).toBe("networkPath");
    }
  });

  it("refuses a stream source before any process or file access on Windows", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const stream = String.raw`C:\media\clip.mp4:hidden`;
      await expect(inspectMedia(stream, "/nonexistent/ffprobe")).rejects.toThrow(STREAM);
      await expect(probeMedia(stream, "/nonexistent/ffprobe")).rejects.toThrow(STREAM);
      expect(() => resolveMediaPath(stream)).toThrow(STREAM);
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });
});
