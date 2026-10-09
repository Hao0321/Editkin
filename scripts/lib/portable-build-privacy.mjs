import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

export function portableBuildEnvironment(root, env = process.env, home = homedir()) {
  const flags = env.CARGO_ENCODED_RUSTFLAGS !== undefined
    ? env.CARGO_ENCODED_RUSTFLAGS.split("\x1f").filter(Boolean)
    : (env.RUSTFLAGS || "").split(/\s+/u).filter(Boolean);
  for (const [path, replacement] of [[home, "build-user"], [dirname(root), "build-workspace"], [root, "editkin-source"]]) {
    for (const spelling of new Set([path, path.replaceAll("\\", "/")])) {
      flags.push(`--remap-path-prefix=${spelling}=${replacement}`);
    }
  }
  return { ...env, CARGO_ENCODED_RUSTFLAGS: flags.join("\x1f"),
    CARGO_PROFILE_DEV_DEBUG: "0", CARGO_PROFILE_DEV_STRIP: "debuginfo" };
}

const forbiddenName = /^(?:\.env(?:\..*)?|\.dev\.vars|auth\.json|credentials(?:\.json)?|origin\.json|id_rsa|id_ed25519)$|\.(?:pem|key|p12|pfx|pyc|pdb|jsonl)$/iu;
const token = /(?<![A-Za-z0-9])(?:sk-(?:proj-|ant-(?:api\d+-)?)?[A-Za-z0-9_-]{24,}|xai-[A-Za-z0-9_-]{32,}|(?:ghp_|gho_|ghu_|ghs_|github_pat_)[A-Za-z0-9_]{24,}|xox[baprs]-[A-Za-z0-9-]{24,}|AIza[0-9A-Za-z_-]{35}|(?:AKIA|ASIA)[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{16,})/u;

/** Local gate: never prints matched values or opens credential stores. */
export async function verifyPortablePrivacy(directory, { root, home = homedir() }) {
  const markers = [...new Set([resolve(root), dirname(resolve(root)), home].flatMap(path => [path, path.replaceAll("\\", "/")]))]
    .filter(Boolean).flatMap(path => [Buffer.from(path.toLowerCase()), Buffer.from(path.toLowerCase(), "utf16le")]);
  const user = basename(home);
  const userPattern = user.length >= 3 ? new RegExp(`(?<![A-Za-z0-9])${user.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![A-Za-z0-9])`, "iu") : undefined;
  const problems = [];
  let files = 0;
  async function visit(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name), location = relative(directory, path).replaceAll("\\", "/");
      if (entry.isSymbolicLink()) { problems.push({ location, category: "symlink" }); continue; }
      if (forbiddenName.test(entry.name) || /\.(?:sqlite|sqlite-wal|sqlite-shm)$/iu.test(entry.name) || entry.name === "__pycache__" || entry.name === "agent-library") {
        problems.push({ location, category: "private-state-or-build-cache" }); continue;
      }
      if (entry.isDirectory()) { await visit(path); continue; }
      if (!entry.isFile()) continue;
      files++;
      let tail = Buffer.alloc(0);
      const categories = new Set();
      for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) {
        const data = Buffer.concat([tail, chunk]);
        const text = data.toString("latin1"), wide = data.toString("utf16le");
        const lower = Buffer.from(text.toLowerCase(), "latin1");
        if (markers.some(marker => lower.includes(marker)) || userPattern?.test(text) || userPattern?.test(wide)) categories.add("local-build-identity");
        if (token.test(text) || token.test(wide)) categories.add("credential-token");
        if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\r\n]{64,}-----END/iu.test(text)) categories.add("private-key-material");
        tail = data.subarray(Math.max(0, data.length - 4096));
      }
      for (const category of categories) problems.push({ location, category });
    }
  }
  await visit(directory);
  if (problems.length) throw new Error(`Portable privacy gate blocked: ${JSON.stringify(problems)}`);
  return { status: "PASS", files, credentialStoresRead: false, rawMatchesIncluded: false };
}
