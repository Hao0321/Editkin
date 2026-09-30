// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
// The gateway remains generic: the original selected backend tool validates
// required fields and commands. Declared envelope fields help model tool calls
// preserve projectPath without imposing it on tools that do not accept it.
export const agentToolCallSchema = {
  type: "object", properties: {
    name: { type: "string" },
    arguments: { type: "object", additionalProperties: true, properties: {
      projectPath: { type: "string", description: "For apply_edit_commands and other project tools, put the exact current Editkin project file path here, inside arguments beside commands. Do not omit it or put it at the top level." },
      commands: { type: "array", items: { type: "object", additionalProperties: true },
        description: "For apply_edit_commands, pass original editor commands here. Inspect the exact commandType when its format is unfamiliar." },
    } },
    retainResult: { type: "boolean" }, run: { type: "string" }, claimToken: { type: "string" },
  }, required: ["name", "arguments"],
};
