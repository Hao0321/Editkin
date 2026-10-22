import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { createOriginalSfxListeningSheetV1 } from "./lib/originalSfxListeningSheetV1";

const { values } = parseArgs({ options: { "pack-root": { type: "string" }, output: { type: "string" } }, strict: true, allowPositionals: false });
if (!values["pack-root"] || !values.output) throw Error("Usage: original-sfx-listening-sheet-v1.ts --pack-root <existing private original pack> --output <new review directory>");
const owner = new AbortController(), stop = () => owner.abort(Error("SFX_SHEET_OWNER_CANCELLED"));
process.once("SIGINT", stop); process.once("SIGTERM", stop);
try { console.log(JSON.stringify(await createOriginalSfxListeningSheetV1(resolve(values["pack-root"]), resolve(values.output), { signal: owner.signal }))); }
finally { process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop); }
