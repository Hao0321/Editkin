import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { portableBuildEnvironment, verifyPortablePrivacy } from "./portable-build-privacy.mjs";

test("portable flags preserve encoded arguments and resource caps", () => {
  const env = portableBuildEnvironment("C:\\Build Space\\editor", { CARGO_ENCODED_RUSTFLAGS: "-C\x1ftarget-feature=+sse2", CARGO_BUILD_JOBS: "2" }, "C:\\Users\\fixture");
  assert.equal(env.CARGO_BUILD_JOBS, "2");
  assert.equal(env.CARGO_PROFILE_DEV_DEBUG, "0");
  assert.equal(env.CARGO_PROFILE_DEV_STRIP, "debuginfo");
  assert.deepEqual(env.CARGO_ENCODED_RUSTFLAGS.split("\x1f").slice(0, 2), ["-C", "target-feature=+sse2"]);
  assert.ok(env.CARGO_ENCODED_RUSTFLAGS.split("\x1f").includes("--remap-path-prefix=C:\\Build Space\\editor=editkin-source"));
  assert.deepEqual(portableBuildEnvironment("/build/editor", { RUSTFLAGS: "-C opt-level=1" }, "/users/fixture").CARGO_ENCODED_RUSTFLAGS.split("\x1f").slice(0, 2), ["-C", "opt-level=1"]);
});

test("package gate catches credential stores, bytecode, binary paths and token boundaries without exposing values", async () => {
  const directory = await mkdtemp(join(tmpdir(), "editkin-privacy-"));
  const options = { root: join(directory, "private-build", "editor"), home: join(directory, "users", "fixture-person") };
  try {
    await writeFile(join(directory, "safe.txt"), "Public endpoints and syntax words: ask-user-about-supersession-threat");
    await writeFile(join(directory, "locale.bin"), Buffer.from("Petropavlovsk-Kamchatski-standerttiid", "utf16le"));
    assert.equal((await verifyPortablePrivacy(directory, options)).status, "PASS");
    await writeFile(join(directory, "auth.json"), "not read");
    await assert.rejects(verifyPortablePrivacy(directory, options), /private-state-or-build-cache/u);
    await rm(join(directory, "auth.json"));
    await mkdir(join(directory, "__pycache__"));
    await assert.rejects(verifyPortablePrivacy(directory, options), /private-state-or-build-cache/u);
    await rm(join(directory, "__pycache__"), { recursive: true });
    await writeFile(join(directory, "history.sqlite"), "synthetic private conversation database");
    await assert.rejects(verifyPortablePrivacy(directory, options), /private-state-or-build-cache/u);
    await rm(join(directory, "history.sqlite"));
    for (const encoding of ["utf8", "utf16le"]) {
      await writeFile(join(directory, "app.exe"), Buffer.from(join(options.root, "source.rs"), encoding));
      await assert.rejects(verifyPortablePrivacy(directory, options), /local-build-identity/u);
    }
    for (const credential of ["sk-" + "x".repeat(32), "xai-" + "x".repeat(40), "ASIA" + "X".repeat(16)]) {
      await writeFile(join(directory, "app.exe"), Buffer.concat([Buffer.alloc(1024 * 1024 - 10), Buffer.from(credential)]));
      await assert.rejects(verifyPortablePrivacy(directory, options), error => error.message.includes("credential-token") && !error.message.includes(credential));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
