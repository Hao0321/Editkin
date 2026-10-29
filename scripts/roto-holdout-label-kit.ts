import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRotoHoldoutLabelKitV1 } from "../src/application/rotoHoldoutLabelFilesV1";
import { draftRotoHoldoutReviewV1, importRotoHoldoutLabelsV1 } from "../src/application/rotoHoldoutLabelImportV1";
import { prepareRotoHoldoutGateInputV1 } from "../src/application/rotoHoldoutGateInputV1";
import { readRotoHoldoutFileV1 } from "../src/application/rotoHoldoutIoV1";

export async function runRotoHoldoutLabelKitCliV1(argv: string[], signal?: AbortSignal) {
  const [mode, ...args] = argv;
  const options = new Map<string, string>(), known = new Set(["--request", "--output", "--kit", "--review", "--labels", "--evidence", "--ffmpeg", "--ffprobe", "--timeout-ms"]);
  if (args.length % 2) throw Error("ROTO_HOLDOUT_USAGE: options require values");
  for (let i = 0; i < args.length; i += 2) {
    if (!known.has(args[i]) || options.has(args[i]) || !args[i + 1] || args[i + 1].startsWith("--")) throw Error("ROTO_HOLDOUT_USAGE: unknown, missing or duplicate option");
    options.set(args[i], args[i + 1]);
  }
  const fields: Record<string, string[]> = { create: ["--request", "--ffmpeg", "--ffprobe"], "review-draft": ["--kit"],
    import: ["--kit", "--review"], "gate-input": ["--labels", "--evidence"] };
  if (!Object.hasOwn(fields, mode) || [...options.keys()].some(key => !["--output", "--timeout-ms", ...fields[mode]].includes(key))) throw Error("ROTO_HOLDOUT_USAGE: option does not belong to mode");
  const need = (key: string) => { const value = options.get(key); if (!value) throw Error("ROTO_HOLDOUT_USAGE: required " + key); return resolve(value); };
  const app = resolve(dirname(fileURLToPath(import.meta.url)), ".."), platform = `${process.platform}-${process.arch}`;
  const runtime = { signal, ffmpegPath: resolve(options.get("--ffmpeg") ?? `${app}/vendor/ffmpeg/${platform}/ffmpeg${process.platform === "win32" ? ".exe" : ""}`),
    ffprobePath: resolve(options.get("--ffprobe") ?? `${app}/vendor/ffmpeg/${platform}/ffprobe${process.platform === "win32" ? ".exe" : ""}`),
    timeoutMs: Number(options.get("--timeout-ms") ?? 120000) };
  const read = async (path: string) => JSON.parse((await readRotoHoldoutFileV1(path, 4 * 1024 * 1024)).toString("utf8"));
  const output = need("--output");
  if (mode === "create") return createRotoHoldoutLabelKitV1(await read(need("--request")), output, runtime);
  if (mode === "review-draft") return draftRotoHoldoutReviewV1(need("--kit"), output, runtime);
  if (mode === "import") return importRotoHoldoutLabelsV1(need("--kit"), need("--review"), output, runtime);
  if (mode === "gate-input") return prepareRotoHoldoutGateInputV1(need("--labels"), await read(need("--evidence")), output, runtime);
  throw Error("ROTO_HOLDOUT_USAGE: create | review-draft | import | gate-input; --output required");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController(), cancel = () => controller.abort(Error("ROTO_HOLDOUT_CANCELLED"));
  process.once("SIGINT", cancel);
  try { console.log(JSON.stringify(await runRotoHoldoutLabelKitCliV1(process.argv.slice(2), controller.signal))); }
  catch (error) { console.error(String(error)); process.exitCode = 1; }
  finally { process.removeListener("SIGINT", cancel); }
}
