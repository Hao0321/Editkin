/**
 * Plain-language problems for save, open, import, export, relink and reload failures.
 *
 * Engine and system errors arrive in English, in Node error codes or in technical Chinese. At the UI boundary
 * they become one short title (what failed), one line saying what happened and one line saying what to do, in
 * words an older creator or a child can follow. The raw text is kept only for 「查看原因」. Every title, what and
 * todo below is a zh-TW interface message key with translations in src/ui/i18n/interfaceMessages.15.ts.
 */
export type ProblemAction = "save" | "open" | "import" | "export" | "relink" | "reload";

export type ProblemCause =
  | "changedElsewhere" | "outputUnverified" | "diskFull" | "gpuEncoder" | "outOfMemory" | "networkPath"
  | "noPermission" | "inUse" | "notSameFile" | "noFingerprint" | "newerProject" | "damagedProject" | "notFound"
  | "unsupportedMedia" | "outputCheckFailed" | "tooSlow" | "busy" | "badName" | "engineStopped"
  | "unsupportedCombination" | "retentionCapacity" | "unknown";

export interface PlainProblem {
  action: ProblemAction;
  cause: ProblemCause;
  /** zh-TW message keys. */
  title: string;
  what: string;
  todo: string;
  /** The raw reason for 「查看原因」; never translated or shown as the main message. */
  detail: string;
}

/** Thrown by the relink flow when the chosen file is not byte-identical to the original. */
export const RELINK_NOT_SAME_FILE = "RELINK_NOT_SAME_FILE";
/** Thrown by the relink flow when the original file's fingerprint was never recorded. */
export const RELINK_NO_FINGERPRINT = "RELINK_NO_FINGERPRINT";

export const PROBLEM_TITLES: Record<ProblemAction, string> = {
  save: "沒有存檔成功",
  open: "打不開這個專案",
  import: "素材沒有加進來",
  export: "影片沒有輸出完成",
  relink: "沒有接回這個素材",
  reload: "沒辦法載入新的版本",
};

export const PROBLEM_WHAT: Record<ProblemCause, string> = {
  retentionCapacity: "目前無法安全建立新的專案暫存檔，原有檔案都保留了。",
  changedElsewhere: "專案檔剛被其他視窗或 AI 助手改過。為了不蓋掉那些修改，這次沒有存。",
  outputUnverified: "影片已經做好了，但最後的檢查沒有通過。",
  diskFull: "存放的磁碟空間不夠了。",
  gpuEncoder: "顯示卡的影片編碼出了問題。",
  outOfMemory: "電腦的記憶體不夠用了。",
  networkPath: "檔案在網路磁碟或共用資料夾上，Editkin 不能直接使用。",
  noPermission: "Editkin 沒有權限使用這個位置，或檔案正被其他程式打開。",
  inUse: "檔案正被其他程式使用中。",
  notSameFile: "你選的檔案和原本的不是同一個（內容不一樣）。",
  noFingerprint: "這個素材當初沒有記下檔案指紋，沒辦法確認是不是同一個檔案。",
  newerProject: "這個專案是用比較新的 Editkin 存的。",
  damagedProject: "這個專案檔的內容有問題，或不是 Editkin 的專案檔。",
  notFound: "找不到檔案，它可能被移動、改名或刪除了。",
  unsupportedMedia: "Editkin 讀不懂這個檔案，可能是格式不支援或檔案壞了。",
  outputCheckFailed: "做出來的影片長度或聲音不對，所以沒有存下來。",
  tooSlow: "處理太久沒有進展，已經先停下來了。",
  busy: "Editkin 還在忙上一件工作。",
  badName: "檔名或資料夾路徑太長，或用了不能用的字。",
  engineStopped: "Editkin 的處理程式意外停了。",
  unsupportedCombination: "這個專案用到目前還不能一起輸出的功能。",
  unknown: "發生了沒有預料到的問題。",
};

export const PROBLEM_TODO: Record<ProblemCause, string> = {
  retentionCapacity: "請先確認磁碟空間與保留版本，或另存新檔到空間足夠的資料夾。",
  changedElsewhere: "請用「另存新檔」把你的版本存成另一個檔案，或重新載入檔案裡的新版本。",
  outputUnverified: "可以先打開資料夾看看影片；如果畫面或聲音不對，請再輸出一次。",
  diskFull: "請刪掉一些用不到的大檔案，或換一個空間夠的磁碟，再試一次。",
  gpuEncoder: "請更新顯示卡驅動程式，或重新開啟 Editkin 後再試一次。",
  outOfMemory: "請關掉其他程式，再試一次。",
  networkPath: "請先把檔案複製到這台電腦的磁碟，再試一次。",
  noPermission: "請換一個資料夾（例如「文件」或「影片」），或關掉正在用這個檔案的程式，再試一次。",
  inUse: "請關掉正在用這個檔案的程式（例如播放器或雲端同步），再試一次。",
  notSameFile: "請選原本那個檔案。如果原本的檔案已經不見了，可以在剪輯台用「替換影片」改用新的檔案。",
  noFingerprint: "請在剪輯台用「替換影片」選這個檔案，替換後再檢查一次畫面。",
  newerProject: "請先更新 Editkin，再打開這個專案。",
  damagedProject: "請選另一個專案檔。剛存過的專案，同一個資料夾裡會有一份結尾是 .previous 的備份。",
  notFound: "請確認檔案還在原來的地方，再重新選一次。",
  unsupportedMedia: "請換成 MP4、MOV、JPG、PNG、MP3 或 WAV 檔，再試一次。",
  outputCheckFailed: "請再輸出一次。如果一直發生，請按「查看原因」，把內容複製給幫你處理的人。",
  tooSlow: "請關掉其他很耗電腦資源的程式，再試一次。",
  busy: "請等它做完，再試一次。",
  badName: "請換一個短一點的檔名或資料夾，再試一次。",
  engineStopped: "請再試一次。如果還是不行，請先存檔，再重新開啟 Editkin。",
  unsupportedCombination: "請按「查看原因」看是哪個功能，調整後再輸出。你的專案內容都還在。",
  unknown: "請再試一次。如果一直發生，請按「查看原因」，把內容複製給幫你處理的人。",
};

/** A few causes need different advice for a different action. */
const TODO_BY_ACTION: Partial<Record<ProblemAction, Partial<Record<ProblemCause, string>>>> = {
  open: { notFound: "請確認檔案還在原來的地方，或用「開啟專案」重新選一次。" },
  reload: { notFound: "專案檔可能被移走了。請用「另存新檔」把你的版本存起來。" },
  save: { notFound: "存放的資料夾可能不見了。請用「另存新檔」換個地方存。" },
  export: { notFound: "有素材找不到了。請先把素材接回來，再輸出一次。" },
};

interface CauseRule { cause: ProblemCause; pattern: RegExp; actions?: readonly ProblemAction[] }

/** First match wins; specific signatures come before broad ones. */
const RULES: readonly CauseRule[] = [
  { cause: "engineStopped", pattern: /RENDER_WORK_CLEANUP_FAILED/, actions: ["export"] },
  { cause: "busy", pattern: /RENDER_WORK_(?:CLEANUP_BUSY|CLOSE_PENDING)|NATIVE_AUDIO_STAGE_CLEANUP_BUSY/, actions: ["export"] },
  { cause: "retentionCapacity", pattern: /EDITKIN_PROJECT_RETENTION_CAPACITY/, actions: ["save"] },
  { cause: "notSameFile", pattern: new RegExp(RELINK_NOT_SAME_FILE) },
  { cause: "noFingerprint", pattern: new RegExp(`${RELINK_NO_FINGERPRINT}|Relink requires the existing pinned source SHA-256`) },
  { cause: "changedElsewhere", pattern: /已被其他視窗或 Agent 更新|ProjectRevisionConflict|revision conflict/i },
  { cause: "outputUnverified", pattern: /影片已產生並保留於|輸出身分未驗證/ },
  { cause: "diskFull", pattern: /ENOSPC|no space left|not enough space|disk (is )?full|磁碟空間不足|磁碟已滿/i },
  { cause: "gpuEncoder", pattern: /nvenc|OpenEncodeSession|nvEncodeAPI|nvcuda|No capable devices found|DXGI_ERROR|DEVICE_REMOVED|device (was )?(lost|removed)|_amf\b|_qsv\b/i },
  { cause: "outOfMemory", pattern: /ENOMEM|out of memory|bad_alloc|Cannot allocate memory|記憶體不足/i },
  { cause: "networkPath", pattern: /網路共用|裝置路徑|network (share|path)|\bUNC\b/i },
  { cause: "inUse", pattern: /\bEBUSY\b|resource busy|used by another process|正在被其他程式使用|is locked|已被鎖定/i },
  { cause: "noPermission", pattern: /\bEACCES\b|\bEPERM\b|permission denied|access is denied|operation not permitted|拒絕存取|存取被拒|唯讀|read-only/i },
  { cause: "newerProject", pattern: /不支援的 EditGraph schema：(?:1[1-9]|[2-9]\d|\d{3,})\b|newer version of Editkin/i, actions: ["open", "reload"] },
  { cause: "damagedProject", pattern: /Unexpected token|is not valid JSON|Unexpected end of JSON|JSON at position|ZodError|invalid_type|"code":\s*"invalid|不支援的 EditGraph schema|專案內容不是有效物件|專案缺少|這不是 Editkin 的專案檔|超過 64 MiB/i, actions: ["open", "reload"] },
  { cause: "notFound", pattern: /ENOENT|no such file|cannot find the (file|path)|系統找不到|找不到這個|找不到檔案|檔案不存在|沒有這個檔案/i },
  { cause: "unsupportedMedia", pattern: /Invalid data found|moov atom not found|could not find codec|Unknown format|unsupported (codec|format|file)|not supported|不支援的(檔案|格式|媒體)|無法辨識|ffprobe exit/i, actions: ["import", "relink"] },
  { cause: "outputCheckFailed", pattern: /輸出 QA 失敗|QA 失敗/, actions: ["export"] },
  { cause: "tooSlow", pattern: /逾時|timed? ?out|deadline exceeded|停滯/i },
  { cause: "busy", pattern: /queue is full|仍在儲存|已經在進行|still running|請等它完成|太多了/i },
  { cause: "badName", pattern: /ENAMETOOLONG|name too long|path too long|路徑太長|檔名不合法|invalid (file ?)?name/i },
  { cause: "engineStopped", pattern: /Resident (output|worker|service|protocol|response|request)|service 失敗|\bEPIPE\b|ECONNRESET|spawn|exit code|SIGKILL|未在取消後關閉/i },
  { cause: "unsupportedCombination", pattern: /尚未支援|只支援|不可降級|silently|不接受|需要原生|缺少原生|尚未完成|要求全部|必須等待/i, actions: ["export"] },
];

const MAX_DETAIL = 4000;

export function rawProblemDetail(error: unknown): string {
  const text = error instanceof Error ? error.message : typeof error === "string" ? error : (() => {
    try { return JSON.stringify(error); } catch { return String(error); }
  })();
  const trimmed = (text ?? "").trim();
  return trimmed.length > MAX_DETAIL ? `${trimmed.slice(0, MAX_DETAIL)}…` : trimmed;
}

export function problemCause(action: ProblemAction, detail: string): ProblemCause {
  for (const rule of RULES) {
    if (rule.actions && !rule.actions.includes(action)) continue;
    if (rule.pattern.test(detail)) return rule.cause;
  }
  return "unknown";
}

export function describeProblem(action: ProblemAction, error: unknown): PlainProblem {
  const detail = rawProblemDetail(error);
  const cause = problemCause(action, detail);
  return {
    action, cause, detail,
    title: PROBLEM_TITLES[action],
    what: PROBLEM_WHAT[cause],
    todo: TODO_BY_ACTION[action]?.[cause] ?? PROBLEM_TODO[cause],
  };
}

/** Every zh-TW key this module can return (the i18n catalog test checks each has translations). */
export function plainProblemMessageKeys(): string[] {
  return [...new Set([
    ...Object.values(PROBLEM_TITLES), ...Object.values(PROBLEM_WHAT), ...Object.values(PROBLEM_TODO),
    ...Object.values(TODO_BY_ACTION).flatMap(byCause => Object.values(byCause ?? {})),
  ])];
}
