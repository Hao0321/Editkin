import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../public/color/aces2");
const files = [
  {
    name: "studio-config-v4.0.0_aces-v2.0_ocio-v2.5.ocio",
    url: "https://github.com/AcademySoftwareFoundation/OpenColorIO-Config-ACES/releases/download/v4.0.0/studio-config-v4.0.0_aces-v2.0_ocio-v2.5.ocio",
    sha256: "eda5b0008a43b72b98ad540e32eb0eb83b340dde54e35bddba64ccbaFAC1029A".toLowerCase(),
  },
  {
    name: "LICENSE.txt",
    url: "https://raw.githubusercontent.com/AcademySoftwareFoundation/OpenColorIO-Config-ACES/v4.0.0/LICENSE",
    sha256: "82a40c52065ee968aa62015735e84378ac11425db7a233e6a2dcd2c83fc24276",
  },
];

await mkdir(root, { recursive: true });
for (const file of files) {
  const response = await fetch(file.url, { redirect: "follow" });
  if (!response.ok) throw new Error(`ACES 下載失敗：${response.status} ${file.url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== file.sha256) throw new Error(`ACES 檔案雜湊不符：${file.name} ${actual}`);
  await writeFile(resolve(root, file.name), bytes);
}
const config = await readFile(resolve(root, files[0].name));
process.stdout.write(`ACES_CONFIG_READY ${createHash("sha256").update(config).digest("hex")}\n`);
