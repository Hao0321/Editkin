// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 djguan-jpg (https://github.com/djguan-jpg)
// Agent contribution: urn:uuid:d366cab7-d5a4-44d8-b80d-4c7ce4daf65d. See AGENT-NOTICE.md.
const forbiddenSchemaKeys = new Set(["__proto__", "prototype", "constructor"]);

/** Read inert JSON-schema data without walking prototypes or invoking accessors. */
export function readOwnSchemaProperty(value: unknown, key: string, errorMessage: string): unknown {
  if (!value || typeof value !== "object" || forbiddenSchemaKeys.has(key)) throw new Error(errorMessage);
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) throw new Error(errorMessage);
  return descriptor.value;
}
