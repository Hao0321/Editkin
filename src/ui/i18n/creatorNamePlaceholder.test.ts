import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import en from "./locales/en";
import es from "./locales/es";
import ja from "./locales/ja";
import ko from "./locales/ko";

// The creator's real name must not ship as a UI example; test fixtures may still use it as data.
const CREATOR_REAL_NAME = "駱君昊";

async function shippedUiSources(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await shippedUiSources(path));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) files.push(path);
  }
  return files;
}

describe("name-field placeholder", () => {
  it("uses a neutral example name in every language", () => {
    expect([en, es, ja, ko].map(messages => messages["例如：王小明"])).toEqual(["Example: Alex Chen", "Ejemplo: Alex Chen", "例：山田太郎", "예: 홍길동"]);
  });

  it("ships no UI text containing the creator's real name", async () => {
    const offenders: string[] = [];
    for (const file of await shippedUiSources(resolve("src/ui"))) {
      if ((await readFile(file, "utf8")).includes(CREATOR_REAL_NAME)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
    for (const messages of [en, es, ja, ko]) {
      expect(Object.entries(messages).filter(([key, value]) => key.includes(CREATOR_REAL_NAME) || value.includes(CREATOR_REAL_NAME))).toEqual([]);
    }
  });
});
