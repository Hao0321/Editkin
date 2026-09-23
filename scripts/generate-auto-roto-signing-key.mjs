import { generateKeyPairSync } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "../..");
const keyRoot = resolve(repoRoot, ".rd/keys");
const privateKeyPath = resolve(keyRoot, "editkin-auto-roto-ed25519-private.pem");
const publicKeyPath = resolve(keyRoot, "editkin-auto-roto-ed25519-public.pem");

await mkdir(keyRoot, { recursive: true });
let privateKey;
try {
  privateKey = await readFile(privateKeyPath, "utf8");
} catch {
  const pair = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  privateKey = pair.privateKey;
  await writeFile(privateKeyPath, pair.privateKey, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await writeFile(publicKeyPath, pair.publicKey, { encoding: "utf8", mode: 0o644, flag: "wx" });
}

const { createPublicKey } = await import("node:crypto");
const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "pem" });
await writeFile(publicKeyPath, publicKey, { encoding: "utf8", mode: 0o644 });
process.stdout.write(JSON.stringify({ privateKeyPath, publicKeyPath, publicKey }, null, 2));
