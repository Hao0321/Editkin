import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import ts from "typescript";

// The installed `agent-runtime-v3/` folder is not a hand-maintained list: it is the
// stable launcher plus every module the launcher actually imports, transitively,
// plus the embedded setup contract. Every packaging step (Tauri resource map,
// staged runtime, delivery and lifecycle gates) derives the set from here, so a
// new launcher import cannot ship without its file again (Editkin #102/#104/#105).

export const PRODUCT_AGENT_RUNTIME_DIRECTORY = "agent-runtime-v3";
export const PRODUCT_AGENT_LAUNCHER_SOURCE = "scripts/editkin-product-mcp-launcher.mjs";
export const PRODUCT_AGENT_LAUNCHER_DESTINATION = "launcher.mjs";
export const PRODUCT_AGENT_CONTRACT_SOURCE = "src/shared/agentSetupContract.json";
export const PRODUCT_AGENT_CONTRACT_DESTINATION = "agent-setup-contract.json";

// The launcher sits in scripts/ and is delivered as agent-runtime-v3/launcher.mjs,
// so a relative import keeps the same path below both folders.
const LAUNCHER_MODULE_ROOT = "scripts";

// Import edges from real module syntax (TypeScript AST), not text matching: string
// literals that merely contain import-like text create no edge. Kept here rather
// than shared, because this module ships in the public source and runs in the
// macOS community gate.
function moduleSpecifiers(source, fileName) {
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  if (parsed.parseDiagnostics.length) {
    throw new Error(`Unable to parse launcher module ${fileName}: ${ts.flattenDiagnosticMessageText(parsed.parseDiagnostics[0].messageText, " ")}`);
  }
  const values = new Set();
  const add = (node) => {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) values.add(node.text);
  };
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) add(node.arguments[0]);
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return [...values];
}

function toPosix(path) {
  return path.split(sep).join("/");
}

function byDestination(left, right) {
  return left.destination < right.destination ? -1 : left.destination > right.destination ? 1 : 0;
}

function assertRegularModule(path, label) {
  const details = lstatSync(path, { throwIfNoEntry: false });
  if (!details) throw new Error(`${label} does not exist: ${path}`);
  if (details.isSymbolicLink() || !details.isFile()) throw new Error(`${label} is not a regular file: ${path}`);
}

/**
 * Modules the stable launcher loads, launcher first, as `{ source, destination }`:
 * `source` is app-relative (posix), `destination` is relative to agent-runtime-v3.
 * Only `node:` builtins and relative `.mjs` files inside scripts/ are allowed; a
 * package, JSON, escaping or case-mismatched import fails here instead of failing
 * on a user's machine with ERR_MODULE_NOT_FOUND.
 */
export function productAgentLauncherModuleClosure(appRoot) {
  const root = resolve(appRoot);
  const moduleRoot = resolve(root, LAUNCHER_MODULE_ROOT);
  const canonicalModuleRoot = realpathSync.native(moduleRoot);
  const launcher = resolve(root, PRODUCT_AGENT_LAUNCHER_SOURCE);
  const destinations = new Map();
  const pending = [launcher];
  while (pending.length) {
    const current = pending.shift();
    if (destinations.has(current)) continue;
    assertRegularModule(current, "Product Agent launcher module");
    const relation = relative(moduleRoot, current);
    if (!relation || relation.startsWith("..") || isAbsolute(relation)) {
      throw new Error(`Product Agent launcher module escapes ${LAUNCHER_MODULE_ROOT}/: ${current}`);
    }
    // Exact on-disk spelling: the delivered tree is copied by name, and a case or
    // junction mismatch would load a different URL (or nothing) at runtime.
    if (relative(canonicalModuleRoot, realpathSync.native(current)) !== relation) {
      throw new Error(`Product Agent launcher module path differs from its on-disk spelling or traverses a link: ${current}`);
    }
    const destination = current === launcher ? PRODUCT_AGENT_LAUNCHER_DESTINATION : toPosix(relation);
    if (current !== launcher && destination === PRODUCT_AGENT_LAUNCHER_DESTINATION) {
      throw new Error(`Product Agent launcher module collides with the delivered launcher name: ${current}`);
    }
    destinations.set(current, destination);
    for (const specifier of moduleSpecifiers(readFileSync(current, "utf8"), current)) {
      if (specifier.startsWith("node:")) continue;
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
        throw new Error(`Product Agent launcher module ${destination} imports "${specifier}"; only node: builtins and relative .mjs modules can be delivered`);
      }
      if (!specifier.endsWith(".mjs")) {
        throw new Error(`Product Agent launcher module ${destination} imports non-.mjs "${specifier}"`);
      }
      const target = resolve(dirname(current), specifier);
      if (target === launcher) {
        throw new Error(`Product Agent launcher module ${destination} imports the launcher by its source name, which does not exist when delivered`);
      }
      pending.push(target);
    }
  }
  const [first, ...rest] = [...destinations].map(([path, destination]) => ({
    source: toPosix(relative(root, path)),
    destination,
  }));
  return [first, ...rest.sort(byDestination)];
}

/** Every file of the delivered agent-runtime-v3 folder, sorted by destination. */
export function productAgentRuntimeResources(appRoot) {
  return [
    { source: PRODUCT_AGENT_CONTRACT_SOURCE, destination: PRODUCT_AGENT_CONTRACT_DESTINATION },
    ...productAgentLauncherModuleClosure(appRoot),
  ].sort(byDestination);
}

/** Closed-world agent-runtime-v3 inventory (posix paths relative to that folder). */
export function productAgentRuntimeInventory(appRoot) {
  return productAgentRuntimeResources(appRoot).map(({ destination }) => destination);
}

/** Exact Tauri `bundle.resources` entries for agent-runtime-v3 (config lives in src-tauri/). */
export function productAgentTauriResourceMappings(appRoot) {
  return new Map(productAgentRuntimeResources(appRoot).map(({ source, destination }) => [
    `../${source}`,
    `${PRODUCT_AGENT_RUNTIME_DIRECTORY}/${destination}`,
  ]));
}
