// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
// Read a command branch from the authoritative MCP schema; never invent or relax validation.
import { readOwnSchemaProperty } from "./jsonSchemaTraversal";

type JsonSchema = Record<string, any>;
const pointerKey = (value: string) => value.replace(/~/g, "~0").replace(/\//g, "~1");
function localReference(root: JsonSchema, node: JsonSchema, sourcePath: string) {
  const seen = new Set<string>();
  while (typeof node?.$ref === "string") {
    const ref = node.$ref;
    if (!ref.startsWith("#/") || seen.has(ref) || seen.size >= 12) throw Error("Command schema reference is not a bounded local reference");
    seen.add(ref);
    sourcePath = ref.slice(1);
    let current: any = root;
    for (const encoded of ref.slice(2).split("/")) {
      const key = encoded.replace(/~1/g, "/").replace(/~0/g, "~");
      current = readOwnSchemaProperty(current, key, "Command schema reference does not exist");
    }
    node = current;
  }
  return { node, sourcePath };
}

export function editCommandSchemaView(schema: JsonSchema, commandType: unknown) {
  if (typeof commandType !== "string" || !/^[a-z][a-z0-9_]{0,79}$/.test(commandType)) throw Error("commandType must be a bounded editor command name");
  const commands = schema.properties?.commands;
  if (!commands?.items || !schema.properties?.projectPath) throw Error("Tool has no editor command schema");
  const resolved = localReference(schema, commands.items, "/properties/commands/items");
  const unionKey = Array.isArray(resolved.node.oneOf) ? "oneOf" : Array.isArray(resolved.node.anyOf) ? "anyOf" : undefined;
  if (!unionKey) throw Error("Editor command union is missing");
  let branch: JsonSchema | undefined, sourceSchemaPath = "";
  for (const [index, candidate] of resolved.node[unionKey].entries()) {
    const result = localReference(schema, candidate, `${resolved.sourcePath}/${unionKey}/${index}`);
    const type = result.node.properties?.type;
    if (type?.const === commandType || type?.enum?.length === 1 && type.enum[0] === commandType) {
      branch = result.node; sourceSchemaPath = result.sourcePath; break;
    }
  }
  if (!branch) throw Error("Unknown editor command type");
  const references = new Set<string>();
  function collect(value: unknown, depth = 0) {
    if (!value || typeof value !== "object") return;
    if (depth > 30) throw Error("Command schema is too deep");
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string" && child.startsWith("#/")) references.add(child.slice(1));
      else collect(child, depth + 1);
    }
  }
  collect(branch);
  return { commandType, sourceSchemaPath, referencePaths: [...references], inputSchema: {
    type: schema.type || "object", properties: {
      projectPath: structuredClone(schema.properties.projectPath),
      commands: { ...structuredClone(commands), items: structuredClone(branch) },
    }, required: structuredClone(schema.required || ["projectPath", "commands"]),
  }, note: references.size
    ? "This command contains references to the original tool schema. Inspect referencePaths with path and without commandType when needed."
    : "Exact selected command format from the original backend. Normal backend validation still applies." };
}
