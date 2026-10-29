import ts from "typescript";
import { readFile, readdir } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { CORE_MESSAGES } from "../src/ui/i18n/coreMessages";

export async function auditInterfaceLocales() {
  const root = resolve("."), ui = join(root, "src/ui/i18n");
  const messages = new Set(CORE_MESSAGES.map(row => row[0]));
  for (const file of (await readdir(ui)).filter(f => /^interfaceMessages\.\d+\.ts$/.test(f))) {
    const rows = (await import(new URL(`../src/ui/i18n/${file}`, import.meta.url).href)).INTERFACE_MESSAGES as string[][];
    for (const row of rows) messages.add(row[0]);
  }
  const missing: Array<{ file: string; line: number; source: string }> = [];
  const untranslated: Array<{ file: string; line: number; source: string; surface: string }> = [];
  const calls = new Set<string>();
  const preserved: Array<{file:string;line:number;source:string;reason:string}> = [];
  const cjk = /[\u3400-\u9fff]/;
  // Recursive: feature folders such as src/ui/easy are product UI too.
  for (const file of [...(await readdir(join(root, "src/ui"), { recursive: true })).filter(f => f.endsWith(".tsx") && !f.includes(".test.")).map(f => join(root, "src/ui", f)), join(root,"src/main.tsx"), join(root,"src/App.tsx")]) {
    const source = await readFile(file, "utf8");
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const entry = (node: ts.Node, text: string) => ({file:relative(root,file).replaceAll("\\","/"),line:tree.getLineAndCharacterOfPosition(node.getStart(tree)).line+1,source:text});
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ["t", "uiText"].includes(node.expression.text)) {
        const inspect = (value: ts.Node) => {
          if (ts.isStringLiteralLike(value)) { calls.add(value.text); if (cjk.test(value.text) && !messages.has(value.text) && !messages.has(value.text.trim())) missing.push(entry(value,value.text)); }
          if (ts.isConditionalExpression(value)) { inspect(value.whenTrue); inspect(value.whenFalse); }
        };
        if(node.arguments[0]) inspect(node.arguments[0]);
      }
      if(ts.isJsxText(node) && cjk.test(node.text)) untranslated.push({...entry(node,node.text.trim()),surface:"jsx-text"});
      if(ts.isJsxAttribute(node) && ["title","aria-label","placeholder","aria-description","alt"].includes(node.name.getText(tree)) && node.initializer && ts.isStringLiteral(node.initializer) && cjk.test(node.initializer.text)) untranslated.push({...entry(node,node.initializer.text),surface:node.name.getText(tree)});
      if (ts.isJsxExpression(node) && node.expression && (!ts.isJsxAttribute(node.parent) || ["title","aria-label","placeholder","aria-description","alt"].includes(node.parent.name.getText(tree)))) {
        if (ts.isJsxElement(node.parent) && node.parent.openingElement.attributes.properties.some(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(tree) === "data-authored-content")) {
          preserved.push({...entry(node,node.expression.getText(tree)),reason:"Explicit authored instructions: display and copied payload must stay identical."});
          return;
        }
        const inspectPresentation = (value: ts.Node) => {
          // Calls and identifiers can carry authored values. Only literal
          // presentation branches are included in this additional inventory.
          if (ts.isCallExpression(value) || ts.isIdentifier(value) || ts.isArrowFunction(value) || ts.isFunctionExpression(value) || ts.isJsxElement(value) || ts.isJsxSelfClosingElement(value) || ts.isJsxFragment(value)) return;
          if (ts.isStringLiteralLike(value) && cjk.test(value.text)) untranslated.push({...entry(value,value.text),surface:"jsx-expression"});
          if (ts.isTemplateExpression(value) && cjk.test([value.head.text,...value.templateSpans.map(span=>span.literal.text)].join(""))) untranslated.push({...entry(value,value.getText(tree)),surface:"jsx-template"});
          else ts.forEachChild(value,inspectPresentation);
        };
        inspectPresentation(node.expression);
      }
      ts.forEachChild(node,visit);
    };
    visit(tree);
  }
  return {schema:"editkin.interface-message-audit/v1",translatedMessages:messages.size,staticUiKeys:calls.size,missing,untranslated,preserved,scope:"Explicit UI calls/text/attributes and inline JSX literal/conditional/template branches only; dynamic application labels and engine diagnostics require separate review. Does not translate or infer authored/project/media content."};
}
if (process.argv[1]?.replaceAll("\\","/").endsWith("scripts/audit-interface-locales.ts")) {
  const report = await auditInterfaceLocales();
  console.log(JSON.stringify(report,null,2));
  if (process.argv.includes("--check") && (report.missing.length || report.untranslated.length)) process.exitCode = 1;
}
