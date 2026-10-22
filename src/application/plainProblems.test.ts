import { describe, expect, it } from "vitest";
import { describeProblem, plainProblemMessageKeys, problemCause, rawProblemDetail, RELINK_NO_FINGERPRINT, RELINK_NOT_SAME_FILE, type ProblemAction } from "./plainProblems";
import { renderProgressMessageKeys } from "./renderProgressModel";
import { INTERFACE_MESSAGES as SAFETY } from "../ui/i18n/interfaceMessages.15";
import en from "../ui/i18n/locales/en";
import es from "../ui/i18n/locales/es";
import ja from "../ui/i18n/locales/ja";
import ko from "../ui/i18n/locales/ko";

const cases: Array<[ProblemAction, string, string]> = [
  ["save", "專案已被其他視窗或 Agent 更新（目前 revision 7，你的版本 6）；請重新開啟後再套用修改。", "changedElsewhere"],
  ["save", "ENOSPC: no space left on device, write", "diskFull"],
  ["export", "磁碟空間不足，已在開始輸出前停止：D:\\ 只剩 1.0 GB，這次輸出預估需要 4.2 GB。", "diskFull"],
  ["save", "EPERM: operation not permitted, rename 'C:\\a.tmp' -> 'C:\\a.editkin.json'", "noPermission"],
  ["save", "EBUSY: resource busy or locked, rename 'D:\\p.tmp'", "inUse"],
  ["open", "ENOENT: no such file or directory, open 'D:\\gone.editkin.json'", "notFound"],
  ["open", "找不到這個專案檔，可能被移動、改名或刪除了", "notFound"],
  ["open", "Unexpected token } in JSON at position 812", "damagedProject"],
  ["open", "不支援的 EditGraph schema：12", "newerProject"],
  ["open", "不支援的 EditGraph schema：0", "damagedProject"],
  ["import", "ffprobe.exe exit 1: moov atom not found", "unsupportedMedia"],
  ["import", "拒絕網路共用或裝置路徑作為媒體來源，請先以一般檔名複製到本機磁碟：\\\\nas\\clip.mp4", "networkPath"],
  ["export", "OpenEncodeSessionEx failed: out of memory (10): (no details)", "gpuEncoder"],
  ["export", "ENOMEM: not enough memory, read", "outOfMemory"],
  ["export", "影片輸出停滯：ffmpeg.exe 已連續 10 分鐘沒有任何進度", "tooSlow"],
  ["export", "Resident worker deadline exceeded; request outcome unknown; request was not replayed", "tooSlow"],
  ["export", "Resident output EOF; request outcome unknown; owned worker cleanup confirmed", "engineStopped"],
  ["export", "輸出 QA 失敗：duration=3.2, expected=10", "outputCheckFailed"],
  ["export", "影片已產生並保留於 D:\\out.mp4，但輸出身分未驗證：x", "outputUnverified"],
  ["export", "motion-composition/v3 只支援 Rec.709 或 ACES 2 Rec.709 SDR 正式輸出", "unsupportedCombination"],
  ["relink", `${RELINK_NOT_SAME_FILE}: D:\\other.mp4`, "notSameFile"],
  ["relink", RELINK_NO_FINGERPRINT, "noFingerprint"],
  ["export", "something nobody has seen before", "unknown"],
];

describe("plain problems at the UI boundary", () => {
  it.each(cases)("%s: %s → %s", (action, raw, cause) => {
    expect(problemCause(action, raw)).toBe(cause);
  });

  it("keeps the raw reason only as detail and never as the main text", () => {
    const problem = describeProblem("save", new Error("EACCES: permission denied, open 'C:\\Program Files\\x.json'"));
    expect(problem.title).toBe("沒有存檔成功");
    expect(problem.what).not.toContain("EACCES");
    expect(problem.todo).not.toContain("EACCES");
    expect(problem.detail).toContain("EACCES");
    expect(rawProblemDetail("x".repeat(5000))).toHaveLength(4001);
    expect(rawProblemDetail({ code: 7 })).toBe('{"code":7}');
  });

  it("gives action-specific advice where the same cause needs different steps", () => {
    expect(describeProblem("open", "ENOENT").todo).toContain("開啟專案");
    expect(describeProblem("export", "ENOENT").todo).toContain("接回來");
    expect(describeProblem("import", "ENOENT").todo).toBe("請確認檔案還在原來的地方，再重新選一次。");
  });

  it("does not treat a project-only cause as one for another action", () => {
    expect(problemCause("export", "Unexpected token")).not.toBe("damagedProject");
    expect(problemCause("open", "尚未支援")).not.toBe("unsupportedCombination");
  });

  it("has all five languages for every message this module and the export model can show", () => {
    const keys = [...plainProblemMessageKeys(), ...renderProgressMessageKeys()];
    for (const locale of [en, es, ja, ko]) {
      expect(keys.filter(key => !(key in locale))).toEqual([]);
    }
    const placeholders = (text: string) => [...text.matchAll(/\{[A-Za-z]\w*\}/g)].map(match => match[0]).sort().join("|");
    for (const row of SAFETY) {
      expect(row).toHaveLength(5);
      for (const text of row.slice(1)) expect(placeholders(text), row[0]).toBe(placeholders(row[0]));
    }
  });
});
