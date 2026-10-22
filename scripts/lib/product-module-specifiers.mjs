import ts from "typescript";

/** Only executable/module syntax creates an edge; generated source text does not. */
export function productModuleSpecifiers(source, fileName) {
  const kind = /\.tsx$/iu.test(fileName) ? ts.ScriptKind.TSX
    : /\.jsx$/iu.test(fileName) ? ts.ScriptKind.JSX
      : /\.[cm]?js$/iu.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const parsed = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, false, kind);
  if (parsed.parseDiagnostics.length) {
    throw new Error(`Unable to parse product dependency syntax in ${fileName}: ${ts.flattenDiagnosticMessageText(parsed.parseDiagnostics[0].messageText, " ")}`);
  }
  const values = new Set();
  const add = node => {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) values.add(node.text);
  };
  function visit(node) {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
    else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) add(node.arguments[0]);
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return [...values];
}
