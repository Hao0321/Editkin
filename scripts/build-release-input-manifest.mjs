import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { computeBuildReceipt, productReleaseManifestFindings } from "./lib/build-input-identity.mjs";

const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const output = resolve(root, ".release-input-manifest.json");
const temporary = `${output}.${process.pid}.${randomUUID()}.tmp`;
const receipt = await computeBuildReceipt(root);
const manifest = {
  schemaVersion: 2,
  product: packageJson.productName,
  productVersion: packageJson.version,
  ...receipt,
};
const findings = productReleaseManifestFindings(manifest);
if (findings.length) throw new Error(`Product-scoped release manifest rejected: ${JSON.stringify(findings)}`);
try {
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rm(output, { force: true });
  await rename(temporary, output);
} finally {
  await rm(temporary, { force: true });
}
process.stdout.write(`${JSON.stringify({
  status: "GREEN",
  output,
  product: manifest.product,
  productVersion: manifest.productVersion,
  scope: manifest.scope,
  inputIdentity: manifest.inputIdentity,
  outputIdentity: manifest.outputIdentity,
})}\n`);
