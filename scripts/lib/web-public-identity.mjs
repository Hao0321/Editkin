import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileIdentity } from "./regular-file.mjs";
import { WINDOWS_BRAND_ICON, verifyDesktopBranding } from "./desktop-branding.mjs";

const normalized = (path) => path.split(sep).join("/");
const same = (first, last) => JSON.stringify(first) === JSON.stringify(last);

function contained(root, path) {
  const relation = relative(root, path);
  if (!relation || relation.startsWith("..") || isAbsolute(relation)) {
    throw new Error(`Web asset escapes its managed directory: ${path}`);
  }
  return normalized(relation);
}

async function regularDirectory(path) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe web asset directory: ${path}`);
}

async function checkedFileIdentity(root, path) {
  contained(root, path);
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    await regularDirectory(parent);
    if (parent === root) break;
  }
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Unsafe web asset file: ${path}`);
  return fileIdentity(path);
}

function addAsset(tree, name, identity) {
  const folded = name.toLowerCase();
  if (tree.names.has(folded)) throw new Error(`Duplicate web asset path: ${name}`);
  tree.names.add(folded);
  tree.files[name] = identity;
  let parent = name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "";
  while (parent) {
    tree.directories.add(parent);
    parent = parent.includes("/") ? parent.slice(0, parent.lastIndexOf("/")) : "";
  }
}

function manifest(tree) {
  return { files: Object.fromEntries(Object.entries(tree.files).sort(([a], [b]) => a.localeCompare(b, "en"))),
    directories: [...tree.directories].sort() };
}

async function collectTree(root, folder, prefix, tree) {
  await regularDirectory(folder);
  if (prefix) tree.directories.add(prefix);
  const children = await readdir(folder, { withFileTypes: true });
  for (const entry of children.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const path = resolve(folder, entry.name);
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Linked web asset is not allowed: ${path}`);
    if (entry.isDirectory()) await collectTree(root, path, name, tree);
    else if (entry.isFile()) addAsset(tree, name, await checkedFileIdentity(root, path));
    else throw new Error(`Unsupported web asset type: ${path}`);
  }
}

async function expectedAssets(root, sources) {
  await verifyDesktopBranding(root);
  const tree = { files: {}, directories: new Set(), names: new Set() };
  const publicRoot = resolve(root, "public");
  await regularDirectory(root);
  await regularDirectory(publicRoot);
  for (const source of sources) {
    const path = resolve(root, source);
    const name = contained(publicRoot, path);
    addAsset(tree, name, await checkedFileIdentity(root, path));
  }
  addAsset(tree, "favicon.ico", await checkedFileIdentity(root, resolve(root, WINDOWS_BRAND_ICON)));
  await collectTree(root, resolve(publicRoot, "benchmarks"), "benchmarks", tree);
  return manifest(tree);
}

async function currentAssets(root, output) {
  contained(root, output);
  if (dirname(output) !== root) throw new Error(`Web output must be an immediate managed child: ${output}`);
  try { await lstat(output); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const tree = { files: {}, directories: new Set(), names: new Set() };
  await collectTree(root, output, "", tree);
  return manifest(tree);
}

/** Identity-only reuse. Extra regular cache entries require a fresh staged copy;
 * links and unsupported filesystem types are rejected before any replacement. */
export async function verifyWebPublicIdentity({ root, output, sources }) {
  root = resolve(root);
  output = resolve(output);
  const expected = await expectedAssets(root, sources);
  const actual = await currentAssets(root, output);
  const confirmed = await expectedAssets(root, sources);
  if (!same(expected, confirmed)) throw new Error("Web asset inputs changed during identity verification");
  const identitySha256 = createHash("sha256").update(JSON.stringify(expected)).digest("hex");
  return { matches: actual !== null && same(expected, actual), present: actual !== null,
    identitySha256, assetFiles: Object.keys(expected.files).length,
    assetBytes: Object.values(expected.files).reduce((total, item) => total + item.bytes, 0) };
}
