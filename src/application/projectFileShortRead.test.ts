import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      return new Proxy(handle, {
        get(target, property) {
          if (property === "read") {
            // A regular file handle is allowed to return fewer bytes than requested.
            return (buffer: Buffer, offset: number, length: number, position: number) =>
              target.read(buffer, offset, Math.min(3, length), position);
          }
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
});

import { readProjectText } from "./projectFiles";

it("reads the entire project through repeated short reads on a real handle", async () => {
  const root = await mkdtemp(join(tmpdir(), "editkin-project-short-read-"));
  try {
    const path = join(root, "synthetic.editkin.json");
    const text = JSON.stringify({ synthetic: "a project with more than three bytes" });
    await writeFile(path, text);
    expect(await readProjectText(path)).toBe(text);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
