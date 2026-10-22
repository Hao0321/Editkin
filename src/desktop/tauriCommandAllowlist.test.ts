import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The Tauri app manifest (src-tauri/build.rs APP_COMMANDS) makes every native command require an explicit
// capability grant. These checks keep the handler list, the manifest and the main-window grants in sync, so a
// new command cannot ship ungated and a command the GUI calls cannot be silently denied at runtime.
const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const permission = (command: string) => `allow-${command.replaceAll("_", "-")}`;
const sorted = (values: Iterable<string>) => [...values].sort();

// Granted at runtime only: by the isolated integration runtime (EDITKIN_INTEGRATION_SMOKE=1) or a research build.
const INTEGRATION_ONLY = ["render_project_smoke", "render_openexr_sequence_smoke", "batch_auto_edit_smoke", "inject_gpu_device_loss_for_test"];
const RESEARCH_ONLY = ["inspect_auto_roto_video_model", "install_auto_roto_video_model", "pick_and_install_auto_roto_video_model", "repair_auto_roto_video_model"];
// Registered for in-process use (unit tests read it directly); no window needs it over IPC.
const NOT_EXPOSED = ["release_input_manifest"];

function registeredCommands(main = read("src-tauri/src/main.rs")): string[] {
  const start = main.indexOf("tauri::generate_handler![");
  expect(start).toBeGreaterThan(0);
  const body = main.slice(start + "tauri::generate_handler![".length, main.indexOf("])", start));
  const paths = body.replace(/#\[[^\]]*\]/g, "").replace(/\/\/[^\n]*/g, "").split(",").map((name) => name.trim()).filter(Boolean);
  return paths.map((path) => {
    // Tauri exposes the final function identifier over IPC, including commands in a leaf module.
    // Module resolution is qualified by the real offline Cargo check; this guard checks app IPC names.
    expect(path).toMatch(/^(?:[A-Za-z_][A-Za-z0-9_]*::)*[A-Za-z_][A-Za-z0-9_]*$/);
    return path.split("::").at(-1)!;
  });
}

function manifestList(name: string): string[] {
  const build = read("src-tauri/build.rs");
  const start = build.indexOf(`const ${name}: &[&str] = &[`);
  expect(start).toBeGreaterThan(0);
  return [...build.slice(start, build.indexOf("];", start)).matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]);
}

function assertHandlerManifest(main: string): void {
  const registered = registeredCommands(main);
  const product = manifestList("PRODUCT_APP_COMMANDS"), research = manifestList("RESEARCH_ONLY_APP_COMMANDS");
  expect(new Set(registered).size).toBe(registered.length);
  expect(sorted([...product, ...research])).toEqual(sorted(registered));
  expect(product.filter((name) => research.includes(name))).toEqual([]);
}

function researchGatedHandlers(): string[] {
  const main = read("src-tauri/src/main.rs");
  const start = main.indexOf("tauri::generate_handler![");
  const body = main.slice(start, main.indexOf("])", start));
  return [...body.matchAll(/#\[cfg\(feature = "auto-roto-research"\)\]\s*([a-z0-9_]+)/g)].map((match) => match[1]);
}

function staticGrants(): string[] {
  const capability = JSON.parse(read("src-tauri/capabilities/main-window-commands.json")) as { windows: string[]; permissions: string[] };
  expect(capability.windows).toEqual(["main"]);
  return capability.permissions;
}

function* frontendSources(directory = resolve(root, "src")): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* frontendSources(path);
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.includes(".test.")) yield readFileSync(path, "utf8");
  }
}

function referencedCommands(sources: Iterable<string>, registered: Iterable<string>): string[] {
  const quoted = new Set<string>();
  // Same conservative quoted-token predicate, including overlapping/mixed
  // quotes. Scan each source once instead of once per registered command.
  for (const source of sources) for (const match of source.matchAll(/(?=["'`]([A-Za-z_][A-Za-z0-9_]*)["'`])/g)) quoted.add(match[1]);
  return [...registered].filter(name => quoted.has(name));
}

describe("Tauri native command allowlist", () => {
  it("declares exactly the registered handler commands in the app manifest", () => {
    assertHandlerManifest(read("src-tauri/src/main.rs"));
  });

  it("uses the same IPC identities for flat and module-qualified batch handlers", () => {
    const main = read("src-tauri/src/main.rs");
    expect(main).toContain("desktop_batch_commands_v1::get_batch_session,");
    assertHandlerManifest(main);
    assertHandlerManifest(main.replaceAll("desktop_batch_commands_v1::", ""));
  });

  it.each(["missing", "renamed", "duplicate", "unregistered", "malformed"] as const)("rejects a %s command in the actual handler registry", kind => {
    const main = read("src-tauri/src/main.rs");
    const marker = "desktop_batch_commands_v1::get_batch_session,";
    expect(main.split(marker)).toHaveLength(2);
    const replacement = kind === "missing" ? ""
      : kind === "renamed" ? "desktop_batch_commands_v1::unregistered_batch_session,"
      : kind === "duplicate" ? marker + "desktop_batch_commands_v1::get_batch_session,"
      : kind === "unregistered" ? marker + "desktop_batch_commands_v1::unregistered_batch_session,"
      : "desktop_batch_commands_v1::get_batch_session(),";
    const mutant = main.replace(marker, replacement);
    expect(mutant).not.toBe(main);
    expect(() => assertHandlerManifest(mutant)).toThrow();
  });

  it("keeps research command names out of the product build's manifest", () => {
    // The Auto Roto freshness gate rejects these names inside the product editkin.exe.
    expect(sorted(manifestList("RESEARCH_ONLY_APP_COMMANDS"))).toEqual(sorted(RESEARCH_ONLY));
    expect(sorted(researchGatedHandlers())).toEqual(sorted(RESEARCH_ONLY));
    const build = read("src-tauri/build.rs");
    expect(build).toContain('env::var_os("CARGO_FEATURE_AUTO_ROTO_RESEARCH").is_none()');
    expect(build).not.toContain(".commands(PRODUCT_APP_COMMANDS)");
    // Both build paths go through the helper that first deletes stale permissions/autogenerated/*.toml files,
    // because tauri-build never removes them and an old research file would re-enter a product ACL.
    expect(build.match(/build_with_app_manifest\(&manifest_dir\)/g)).toHaveLength(2);
    expect(build).toContain('manifest_dir.join("permissions").join("autogenerated")');
    expect(build).toContain("!commands.contains(&stem)");
  });

  it("preserves the quoted-token predicate while scanning each source once", () => {
    const names = ["a", "get_batch_session", "render_project", "missing"];
    const quotes = ['"', "'", "`"];
    const sources = ["a get_batch_session", '"a"get_batch_session"', "'render_project_extra'"];
    for (const left of quotes) for (const right of quotes) for (const name of names.slice(0, 3)) sources.push(`${left}${name}${right}`);
    const original = names.filter(name => sources.some(source => new RegExp(`["'\`]${name}["'\`]`).test(source)));
    expect(referencedCommands(sources, names)).toEqual(original);
    expect(referencedCommands(["get_batch_session", "'get_batch_session_extra'"], names)).toEqual([]);
    expect(referencedCommands(['"a"get_batch_session"'], names)).toEqual(["a", "get_batch_session"]);
  });

  it("grants every command the frontend references and nothing unregistered", () => {
    const registered = new Set(registeredCommands());
    const grants = new Set(staticGrants());
    const sources = frontendSources();
    const referenced = referencedCommands(sources, registered);
    expect(referenced.length).toBeGreaterThan(80);
    expect(referenced.filter((name) => !grants.has(permission(name)))).toEqual([]);
    expect([...grants].filter((grant) => ![...registered].some((name) => permission(name) === grant))).toEqual([]);
    // Every registered command is either granted to the GUI or deliberately kept off the static IPC surface.
    expect(sorted([...registered].filter((name) => !grants.has(permission(name))))).toEqual(sorted([...INTEGRATION_ONLY, ...RESEARCH_ONLY, ...NOT_EXPOSED]));
  });

  it("ships the in-app template Shorts commands as product commands the main window may call", () => {
    const shorts = ["template_short_prepare", "template_short_confirm_rights", "start_template_short_job", "template_short_job_status",
      "cancel_template_short_job", "save_template_short_video", "open_template_short_project", "reveal_in_folder"];
    const registered = registeredCommands(), product = manifestList("PRODUCT_APP_COMMANDS"), grants = staticGrants();
    for (const name of shorts) {
      expect(registered, name).toContain(name);
      expect(product, name).toContain(name);
      expect(grants, name).toContain(permission(name));
    }
    // The defaults file is written only after the creator's explicit click: the command refuses without `confirmed`.
    const main = read("src-tauri/src/main.rs").replaceAll("\r\n", "\n");
    const confirm = main.slice(main.indexOf("async fn template_short_confirm_rights("), main.indexOf("fn start_template_short_job("));
    expect(confirm.indexOf("if !confirmed {")).toBeGreaterThan(0);
    expect(confirm.indexOf("if !confirmed {")).toBeLessThan(confirm.indexOf("run_one_shot"));
  });

  it("keeps test, smoke and research commands out of the static capability", () => {
    const grants = staticGrants();
    for (const name of [...INTEGRATION_ONLY, ...RESEARCH_ONLY, ...NOT_EXPOSED]) expect(grants).not.toContain(permission(name));
  });

  it("grants isolated commands only through the runtime capability, gated by its environment", () => {
    const main = read("src-tauri/src/main.rs").replaceAll("\r\n", "\n");
    const start = main.indexOf("fn grant_isolated_runtime_commands(app: &AppHandle)");
    expect(start).toBeGreaterThan(0);
    const body = main.slice(start, main.indexOf("\n}\n", start));
    expect(body).toContain('env::var("EDITKIN_INTEGRATION_SMOKE").as_deref() == Ok("1")');
    expect(body).toContain('#[cfg(feature = "auto-roto-research")]');
    for (const name of [...INTEGRATION_ONLY, ...RESEARCH_ONLY]) expect(body).toContain(`.permission("${permission(name)}")`);
    expect(main).toContain("            grant_isolated_runtime_commands(app.handle())?;");
  });
});
