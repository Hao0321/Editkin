import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const appRoot = resolve(import.meta.dirname, "..");
const workspaceRoot = resolve(appRoot, "../..");
const ffmpeg = resolve(appRoot, "vendor/ffmpeg/win32-x64/ffmpeg.exe");
const manifestPath = resolve(workspaceRoot, "community/hao-motion-kit/PUBLIC_ASSET_MANIFEST.json");
const assetRoot = resolve(workspaceRoot, "community/hao-motion-kit/assets/sfx/editkin-core");

const definitions = [
  {
    id: "sfx:editkin-whoosh-01", file: "editkin-whoosh-01.wav", role: "transition-whoosh", domains: ["all", "gaming", "shorts", "reels"],
    inputs: ["-f", "lavfi", "-i", "anoisesrc=color=pink:amplitude=0.32:d=0.42:r=48000"],
    filter: "highpass=f=280,lowpass=f=7200,afade=t=in:st=0:d=0.035,afade=t=out:st=0.2:d=0.22,volume=0.78,alimiter=limit=0.72",
  },
  {
    id: "sfx:editkin-impact-01", file: "editkin-impact-01.wav", role: "payoff-impact", domains: ["all", "gaming", "shorts", "reels"],
    inputs: ["-f", "lavfi", "-i", "sine=frequency=72:sample_rate=48000:duration=0.52", "-f", "lavfi", "-i", "anoisesrc=color=brown:amplitude=0.18:d=0.52:r=48000"],
    filterComplex: "[0:a]afade=t=out:st=0.08:d=0.44,volume=0.95[low];[1:a]highpass=f=110,lowpass=f=2400,afade=t=out:st=0.03:d=0.33,volume=0.6[noise];[low][noise]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.78[out]",
  },
  {
    id: "sfx:editkin-countdown-01", file: "editkin-countdown-01.wav", role: "countdown-tick", domains: ["all", "gaming", "shorts", "reels"],
    inputs: ["-f", "lavfi", "-i", "sine=frequency=1180:sample_rate=48000:duration=0.14"],
    filter: "afade=t=out:st=0.025:d=0.11,volume=0.42,alimiter=limit=0.55",
  },
  {
    id: "sfx:editkin-reveal-01", file: "editkin-reveal-01.wav", role: "reveal-spark", domains: ["all", "gaming", "shorts", "reels"],
    inputs: ["-f", "lavfi", "-i", "aevalsrc=0.22*sin(2*PI*(520*t+1400*t*t)):s=48000:d=0.46"],
    filter: "highpass=f=360,afade=t=in:st=0:d=0.025,afade=t=out:st=0.22:d=0.24,aecho=0.7:0.4:45:0.22,alimiter=limit=0.62",
  },
];

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

await mkdir(assetRoot, { recursive: true });
const generated = [];
for (const definition of definitions) {
  const output = resolve(assetRoot, definition.file);
  const filterArgs = definition.filterComplex ? ["-filter_complex", definition.filterComplex, "-map", "[out]"] : ["-af", definition.filter];
  await run(ffmpeg, ["-y", "-hide_banner", "-loglevel", "error", ...definition.inputs, ...filterArgs, "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", output], { windowsHide: true, timeout: 30_000 });
  const info = await stat(output);
  generated.push({
    asset_id: definition.id,
    path: `community/hao-motion-kit/assets/sfx/editkin-core/${definition.file}`,
    category: "sfx",
    role: definition.role,
    domains: definition.domains,
    license: "CC-BY-4.0",
    provenance: "Editkin Core SFX procedural DSP v1; no sampled third-party audio",
    bytes: info.size,
    sha256: await sha256(output),
  });
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const ids = new Set(definitions.map((item) => item.id));
manifest.assets = [...manifest.assets.filter((item) => !ids.has(item.asset_id)), ...generated].sort((left, right) => String(left.asset_id).localeCompare(String(right.asset_id)));
manifest.asset_count = manifest.assets.length;
manifest.generated_at = new Date().toISOString();
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ status: "GREEN", manifestPath, generated: generated.map(({ asset_id, bytes, sha256 }) => ({ asset_id, bytes, sha256 })) })}\n`);
