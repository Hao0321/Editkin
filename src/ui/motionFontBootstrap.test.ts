import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

describe("actual application font bootstrap wiring (source AST, not desktop runtime)", () => {
  it("keeps App free of unconditional missing-static-face CSS and awaits conditional bootstrap before App evaluation", async () => {
    const app = ts.createSourceFile("App.tsx", await readFile(resolve("src/App.tsx"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const main = ts.createSourceFile("main.tsx", await readFile(resolve("src/main.tsx"), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const staticFontCss = app.statements.filter(ts.isImportDeclaration).filter(node => ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === "./generated/fontFaces.css");
    expect(staticFontCss).toHaveLength(0);
    let bridge = -1, bootstrap = -1, appEvaluation = -1, fontImport = -1;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])) {
        if (node.arguments[0].text === "./desktop/tauriBridge") bridge = node.pos;
        if (node.arguments[0].text === "./App") appEvaluation = node.pos;
        if (node.arguments[0].text === "./generated/fontFaces.css") fontImport = node.pos;
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "bootstrapMotionFontCss") {
        expect(ts.isAwaitExpression(node.parent)).toBe(true); expect(node.arguments).toHaveLength(2);
        expect(ts.isArrowFunction(node.arguments[1])).toBe(true); bootstrap = node.pos;
      }
      ts.forEachChild(node, visit);
    };
    visit(main); expect(bridge).toBeGreaterThanOrEqual(0); expect(bootstrap).toBeGreaterThan(bridge);
    expect(fontImport).toBeGreaterThan(bootstrap); expect(appEvaluation).toBeGreaterThan(fontImport);
  });
});
