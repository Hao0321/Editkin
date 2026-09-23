import { resolve } from "node:path";
import { acquireFontSources } from "./lib/font-source-acquisition.mjs";

const COMMIT = "ec626514f79f831f1ab848a82114a0ce7e2d6372";
const RAW = `https://raw.githubusercontent.com/google/fonts/${COMMIT}/ofl`;
if (process.argv.some(argument => argument.startsWith("--") && argument !== "--bootstrap")) throw new Error("Unknown font acquisition option");
const fonts = [
  { id: "noto-sans-tc", family: "Noto Sans TC", file: "NotoSansTC[wght].ttf", directory: "notosanstc", sha256: "864727d210d54f2537bbe23b3a839436c3992af72de9322af5270897246bd44f" },
  { id: "noto-serif-tc", family: "Noto Serif TC", file: "NotoSerifTC[wght].ttf", directory: "notoseriftc", sha256: "0077e18f57c6908f4a000969880940bdb0dad057c0e8d98b49dc364c3d1b09c6" },
  { id: "lxgw-wenkai-mono-tc", family: "LXGW WenKai Mono TC", file: "LXGWWenKaiMonoTC-Regular.ttf", directory: "lxgwwenkaimonotc", sha256: "ea6707f71c862f4f255cbe510148b676ca8f5360872633de88694f8004f3f8b3" },
  { id: "bebas-neue", family: "Bebas Neue", file: "BebasNeue-Regular.ttf", directory: "bebasneue", sha256: "08e4623805102d819f58601e46e345648846075e363b2ceb23313c2d1c83ec73" },
  { id: "fredoka", family: "Fredoka", file: "Fredoka[wdth,wght].ttf", directory: "fredoka", sha256: "2ba02e68b152868aef9ba28e24b3648c7d457fe6f25c761f2c2c53fb61a73fc8" },
];

const licenseHashes = [
  "1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9",
  "5e0da210fb04058a8c0087985d2d456b931c2579811a49655721d3cf0c36b6d6",
  "4fff27d35db0e22cd81d58da6f20e09f415cf354a3338e3cf1fc0eb9222c7174",
  "72082f6cb4d04be2ecf7cc7d9e1e7d73787f0af8a5a278a47cade70c16b78341",
  "5c9e7eee5c6b25f4b05b8d53b2e470ea4962f9ced742d044a98f7d95d1375bab",
];

async function fetchBytes(url) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`font download failed ${response.status}: ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

const root = resolve(import.meta.dirname, "../public/fonts");
const result = await acquireFontSources({ root, fetchBytes, bootstrap: process.argv.includes("--bootstrap"),
  metadata: { id: "studio.hao.editkin-open-fonts", version: "0.15.0", sourceRepository: "https://github.com/google/fonts", sourceCommit: COMMIT, redistribution: "community-installer" },
  fonts: fonts.map((font, index) => ({ ...font, licenseSha256: licenseHashes[index], source: `${RAW}/${font.directory}/${encodeURIComponent(font.file)}`, licenseSource: `${RAW}/${font.directory}/OFL.txt` })),
});
process.stdout.write(`${JSON.stringify(result)}\n`);
