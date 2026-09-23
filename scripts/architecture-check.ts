import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import ts from "typescript";

interface Finding {
  status: "PASS" | "FAIL";
  code: string;
  message: string;
  path?: string;
  line?: number;
}

interface Report {
  schemaVersion: 1;
  target: string;
  evaluatorSha256: string;
  parser: string;
  scope: string;
  files: number;
  edges: number;
  cycles: string[][];
  findings: Finding[];
  decision: "ALLOW" | "BLOCK";
}

interface CliArguments {
  root: string;
  output?: string;
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.ReactJSX,
  allowJs: true, resolveJsonModule: true, noResolve: true, noLib: true,
};

function parseCliArguments(args: string[], fallbackRoot: string): CliArguments {
  const outputIndex = args.indexOf("--output");
  if (outputIndex >= 0 && !args[outputIndex + 1]) {
    throw new Error("--output requires a path");
  }
  const optionValueIndexes = new Set(outputIndex >= 0 ? [outputIndex + 1] : []);
  const positionalRoot = args.find((argument, index) => !argument.startsWith("--") && !optionValueIndexes.has(index));
  return {
    root: resolve(positionalRoot ?? fallbackRoot),
    output: outputIndex >= 0 ? resolve(args[outputIndex + 1]) : undefined,
  };
}

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (SOURCE_EXTENSIONS.includes(extname(entry.name))) files.push(path);
  }
  return files;
}

function resolveRelativeImport(specifier: string, file: string): string | undefined {
  const cleanSpecifier = specifier.split(/[?#]/, 1)[0];
  const absolute = resolve(dirname(file), cleanSpecifier);
  // Prefer the actual .mjs/.js implementation over its adjacent declaration.
  // Otherwise TypeScript handles .js -> .ts, .mjs -> .mts and index resolution.
  if (extname(cleanSpecifier) && ts.sys.fileExists(absolute)) return absolute;
  return ts.resolveModuleName(cleanSpecifier, file, COMPILER_OPTIONS, ts.sys).resolvedModule?.resolvedFileName;
}

function moduleReferences(source: ts.SourceFile): { references: Array<{ specifier: string; line: number }>; findings: Finding[] } {
  const references: Array<{ specifier: string; line: number }> = [];
  const findings: Finding[] = [];
  const add = (argument: ts.Node | undefined, owner: ts.Node) => {
    const line = source.getLineAndCharacterOfPosition(owner.getStart(source)).line + 1;
    if (argument && (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))) {
      references.push({ specifier: argument.text, line });
    } else {
      findings.push({ status: "FAIL", code: "non-static-module-import", line,
        message: "動態模組名稱無法靜態解析；不得宣稱此依賴圖完整" });
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) add(node.moduleSpecifier, node);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression, node);
    } else if (ts.isImportTypeNode(node)) {
      add(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined, node);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      add(node.arguments[0], node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { references, findings };
}

function normalized(root: string, file: string): string {
  return relative(root, file).replaceAll("\\", "/");
}

function forbiddenEdge(from: string, to: string): string | undefined {
  const isTest = (path: string) => /(?:^|\/)__tests__\//.test(path) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path);
  if (!isTest(from) && isTest(to)) return "production 不得依賴 test 模組";
  // Integration tests intentionally exercise multiple production adapters.
  // They still participate in resolution, cycle and production-to-test checks.
  if (isTest(from)) return undefined;
  if (from.startsWith("src/domain/") && /^(src\/(ui|mcp|render|desktop)\/|electron\/)/.test(to)) {
    return "domain 只能依賴 domain 或純 lib";
  }
  if (from.startsWith("src/render/") && /^(src\/(ui|mcp)\/|electron\/)/.test(to)) {
    return "render adapter 不得依賴 UI、MCP 或 Electron";
  }
  if (from.startsWith("src/mcp/") && /^(src\/(ui|render)\/|electron\/)/.test(to)) {
    return "MCP interface 不得依賴 UI、render 或 Electron";
  }
  if (from.startsWith("electron/") && /^(src\/(ui|render)\/)/.test(to)) {
    return "Electron interface 不得直接依賴 renderer UI 或 render infrastructure";
  }
  return undefined;
}

function findCycles(graph: Map<string, string[]>): string[][] {
  const visited = new Set<string>();
  const active = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  const visit = (node: string) => {
    if (active.has(node)) {
      const start = stack.indexOf(node);
      cycles.push([...stack.slice(start), node]);
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    active.add(node);
    stack.push(node);
    for (const target of graph.get(node) ?? []) visit(target);
    stack.pop();
    active.delete(node);
  };

  for (const node of graph.keys()) visit(node);
  return cycles;
}

async function evaluatorHash(): Promise<string> {
  return createHash("sha256").update(await readFile(import.meta.filename)).digest("hex");
}

async function audit(rootInput: string): Promise<Report> {
  const root = resolve(rootInput);
  const roots = [join(root, "src"), join(root, "electron")];
  const files: string[] = [];
  for (const sourceRoot of roots) {
    try { files.push(...await walk(sourceRoot)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  files.sort();

  const graph = new Map<string, string[]>();
  const findings: Finding[] = [];
  const program = ts.createProgram(files, COMPILER_OPTIONS);
  let edgeCount = 0;
  for (const file of files) {
    const from = normalized(root, file);
    const source = program.getSourceFile(file);
    if (!source) throw new Error(`TypeScript AST missing for ${file}`);
    for (const diagnostic of program.getSyntacticDiagnostics(source)) {
      findings.push({ status: "FAIL", code: "source-parse-error", path: from,
        line: source.getLineAndCharacterOfPosition(diagnostic.start).line + 1,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n") });
    }
    const parsed = moduleReferences(source);
    findings.push(...parsed.findings.map((finding) => ({ ...finding, path: from })));
    const edges: string[] = [];
    for (const { specifier, line } of parsed.references) {
      if (!specifier.startsWith(".")) continue;
      const targetFile = resolveRelativeImport(specifier, file);
      if (!targetFile) {
        findings.push({ status: "FAIL", code: "unresolved-relative-import", message: `無法解析 ${specifier}`, path: from, line });
        continue;
      }
      // Asset imports must exist, but do not create executable module edges.
      if (!SOURCE_EXTENSIONS.includes(extname(targetFile))) continue;
      const to = normalized(root, targetFile);
      if (!edges.includes(to)) { edges.push(to); edgeCount += 1; }
      const reason = forbiddenEdge(from, to);
      if (reason) findings.push({ status: "FAIL", code: "forbidden-edge", message: `${from} → ${to}: ${reason}`, path: from, line });
    }
    graph.set(from, edges);
  }

  const cycles = findCycles(graph);
  for (const cycle of cycles) findings.push({ status: "FAIL", code: "dependency-cycle", message: cycle.join(" → ") });

  const requiredEdge = graph.get("src/domain/commands.ts")?.includes("src/domain/editGraph.ts") ?? false;
  findings.push(requiredEdge
    ? { status: "PASS", code: "required-domain-edge", message: "commands → editGraph 存在" }
    : { status: "FAIL", code: "required-domain-edge", message: "缺少 commands → editGraph" });
  findings.push(edgeCount > 0
    ? { status: "PASS", code: "non-empty-graph", message: `解析 ${edgeCount} 條內部 edges` }
    : { status: "FAIL", code: "non-empty-graph", message: "依賴圖為空" });

  return {
    schemaVersion: 1,
    target: root,
    evaluatorSha256: await evaluatorHash(),
    parser: `typescript-ast/${ts.version}`,
    scope: "TS/JS files in src and electron; all literal relative imports resolved, including test and asset imports. Bare packages, transitive modules outside these roots and cross-language/runtime loading are outside this graph.",
    files: files.length,
    edges: edgeCount,
    cycles,
    findings,
    decision: findings.some((finding) => finding.status === "FAIL") ? "BLOCK" : "ALLOW",
  };
}

async function selfTest(): Promise<void> {
  const parsed = parseCliArguments(["--output", "evidence.json"], "project-root");
  if (!parsed.root.endsWith("project-root") || !parsed.output?.endsWith("evidence.json")) {
    throw new Error(`architecture CLI self-test failed: ${JSON.stringify(parsed)}`);
  }
  const fixture = await mkdtemp(join(tmpdir(), "hao-architecture-fixture-"));
  const controls: Array<{ name: string; decision: string; detected: string[] }> = [];
  const base: Record<string, string> = {
    "src/domain/editGraph.ts": "export const graph = 1;\n",
    "src/domain/commands.ts": "import './editGraph';\nexport const command = 1;\n",
    "src/ui/Panel.tsx": "import './theme.css';\nexport const Panel = () => <div />;\n",
    "src/ui/theme.css": "div { color: black; }\n",
    "src/render/ffmpeg.ts": "export const render = 1;\n",
  };
  const check = async (name: string, changes: Record<string, string>, expectedFailures: string[]) => {
    const root = join(fixture, name);
    for (const [path, text] of Object.entries({ ...base, ...changes })) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
    const report = await audit(root);
    const detected = [...new Set(report.findings.filter((finding) => finding.status === "FAIL").map((finding) => finding.code))].sort();
    if (JSON.stringify(detected) !== JSON.stringify([...expectedFailures].sort())
      || report.decision !== (expectedFailures.length ? "BLOCK" : "ALLOW")) {
      throw new Error(`architecture control ${name} failed: ${JSON.stringify(report)}`);
    }
    controls.push({ name, decision: report.decision, detected });
    return report;
  };
  try {
    const inert = await check("comments-and-strings", { "src/domain/literal.ts": [
      "// import '../ui/Panel';", "/* export * from './missing'; */",
      "export const source = `import './absent.ts'; const lazy = import('../ui/Panel');`;",
      "export const quoted = \"require('./absent')\";",
    ].join("\n") }, []);
    if (inert.edges !== 1) throw new Error("inert text unexpectedly created a dependency");
    for (const extension of ["ts", "js"]) {
      await check(`explicit-${extension}`, { "src/domain/commands.ts": `import './editGraph.${extension}';` }, []);
    }
    await check("index-resolution", {
      "src/domain/commands.ts": "import './editGraph'; import './nested';",
      "src/domain/nested/index.ts": "export const nested = 1;",
    }, []);
    await check("js-module-implementations", {
      "src/domain/commands.ts": "import './editGraph'; import '../shared/value.mjs'; import '../shared/fallback.mjs'; import '../shared/legacy.cjs';",
      "src/shared/value.mjs": "export const value = 1;", "src/shared/value.d.mts": "export declare const value: number;",
      "src/shared/fallback.mts": "export const fallback = 1;", "src/shared/legacy.cjs": "module.exports = 1;",
    }, []);
    await check("integration-test-cross-layer", {
      "src/domain/commands.test.ts": "import '../ui/Panel'; import '../render/ffmpeg';",
    }, []);
    await check("production-imports-test", {
      "src/domain/commands.ts": "import './editGraph'; import './fixture.test';",
      "src/domain/fixture.test.ts": "export const fixture = 1;",
    }, ["forbidden-edge"]);
    await check("test-import-must-resolve", {
      "src/domain/commands.test.ts": "import './missing';",
    }, ["unresolved-relative-import"]);
    await check("production-cycle", { "src/domain/editGraph.ts": "import './commands';" }, ["dependency-cycle"]);
    await check("required-edge-missing", { "src/domain/commands.ts": "export const command = 1;" }, ["required-domain-edge", "non-empty-graph"]);
    await check("asset-must-exist", { "src/ui/Panel.tsx": "import './missing.css';" }, ["unresolved-relative-import"]);
    await check("syntax-error", { "src/domain/broken.ts": "export const broken = ;" }, ["source-parse-error"]);
    await check("electron-layer-violation", { "electron/main.ts": "import '../src/render/ffmpeg';" }, ["forbidden-edge"]);
    const forms: Record<string, string> = {
      "static-import": "import '../ui/Panel';", "re-export": "export * from '../ui/Panel';",
      "dynamic-import": "export const load = () => import('../ui/Panel');",
      "dynamic-template-literal": "export const load = () => import(`../ui/Panel`);",
      "import-type": "export type Panel = typeof import('../ui/Panel');",
      "import-equals": "import Panel = require('../ui/Panel');",
      "require": "const Panel = require('../ui/Panel');",
    };
    for (const [name, statement] of Object.entries(forms)) {
      await check(`${name}-layer-violation`, { "src/domain/adapter.ts": statement }, ["forbidden-edge"]);
    }
    await check("literal-dynamic-missing", { "src/domain/load.ts": "export const load = () => import('./missing');" }, ["unresolved-relative-import"]);
    await check("computed-import-not-proven", {
      "src/domain/load.ts": "export const load = (path: string) => import(path);",
    }, ["non-static-module-import"]);
    process.stdout.write(JSON.stringify({ status: "GREEN", parser: `typescript-ast/${ts.version}`, controls }));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--self-test")) return selfTest();
  const parsed = parseCliArguments(args, resolve(import.meta.dirname, ".."));
  const root = parsed.root;
  const report = await audit(root);
  if (parsed.output) {
    await mkdir(dirname(parsed.output), { recursive: true });
    await writeFile(parsed.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  } else {
    process.stdout.write(JSON.stringify(report));
  }
  if (report.decision !== "ALLOW") process.exitCode = 1;
}

void main();
