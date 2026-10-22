/** From the app root: node --import tsx scripts/beat-review-contact-sheet-v1.ts --request <absolute.json> --out <new-absolute-folder> [--ffmpeg <absolute.exe>] */
import { resolve, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readBoundedFile } from "../src/shared/boundedFile";
import { assertLocalMediaPath } from "../src/shared/localMediaPath";
import { createBeatReviewContactSheetV1 } from "./lib/beatReviewContactSheetV1";

export async function runBeatReviewCliV1(args: string[]) {
  const { values } = parseArgs({ args, options: { request: { type: "string" }, out: { type: "string" }, ffmpeg: { type: "string" } } });
  if (!values.request || !values.out) throw Error("--request <absolute.json> and --out <new-absolute-folder> are required");
  assertLocalMediaPath(values.request);
  if (!isAbsolute(values.request)) throw Error("Request path must be absolute");
  const request = JSON.parse((await readBoundedFile(values.request, 65536)).toString("utf8"));
  return createBeatReviewContactSheetV1(request, values.out, { ffmpegPath: values.ffmpeg ?? resolve("vendor/ffmpeg/win32-x64/ffmpeg.exe") });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runBeatReviewCliV1(process.argv.slice(2)).then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1;
  });
}
