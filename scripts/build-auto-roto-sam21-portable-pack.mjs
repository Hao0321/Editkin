import { execFile } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { cp, copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "../..");
const candidateRoot = resolve(repoRoot, ".rd/tmp/auto-roto-sam2");
const sourcePython = resolve(candidateRoot, ".venv/Scripts/python.exe");
const sourceSam = resolve(candidateRoot, "sam2");
const sourceCommit = "2b90b9f5ceec907a1c18123530e92e794ad901a4";
const packId = "editkin-auto-roto-sam21-tiny-windows-cuda";
const packVersion = "1.0.3";
const publisherKeyId = "editkin-auto-roto-production-2026";
const packBase = resolve(repoRoot, ".rd/model-packs");
const finalRoot = resolve(packBase, `${packId}-${packVersion}`);
const stagingRoot = resolve(packBase, `${packId}-${packVersion}.staging-${process.pid}`);
const privateKeyPath = resolve(repoRoot, ".rd/keys/editkin-auto-roto-ed25519-private.pem");
const publicKeyPath = resolve(repoRoot, ".rd/keys/editkin-auto-roto-ed25519-public.pem");
const reportRoot = resolve(appRoot, ".rd/benchmarks/editkin-auto-roto-sam21-portable-pack");
const reportPath = resolve(reportRoot, "report.json");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function inside(root, target) {
  const value = relative(root, target);
  return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

async function copyOne(source, target) {
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}

let baseLibRoot = "";
function baseLibFilter(source) {
  const relativePath = relative(baseLibRoot, source).replaceAll("\\", "/").toLowerCase();
  const parts = relativePath.split("/");
  return !parts.some((part) => ["site-packages", "__pycache__", "test", "tests", "idlelib", "tkinter", "turtledemo", "ensurepip", "venv", "lib2to3"].includes(part))
    && !relativePath.endsWith(".pyc") && !relativePath.endsWith(".pyo");
}

async function walkPayload(root, directory = root) {
  const files = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const target = resolve(directory, entry.name);
    const metadata = await lstat(target);
    if (metadata.isSymbolicLink()) throw new Error(`portable pack 含 symlink：${target}`);
    if (metadata.isDirectory()) files.push(...await walkPayload(root, target));
    else if (metadata.isFile()) {
      const path = relative(root, target).replaceAll("\\", "/");
      if (!["manifest.json", "pack-receipt.json", "pack-receipt.sig"].includes(path)) {
        files.push({ path, bytes: metadata.size, sha256: sha256(await readFile(target)) });
      }
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

async function ensureInputs() {
  const inputs = [
    sourcePython, resolve(sourceSam, "sam2"), resolve(sourceSam, "LICENSE"),
    resolve(sourceSam, "sam2/configs/sam2.1/sam2.1_hiera_t.yaml"),
    resolve(sourceSam, "checkpoints/sam2.1_hiera_tiny.pt"),
    resolve(appRoot, "scripts/auto-roto-sam21-video-host.py"), privateKeyPath, publicKeyPath,
  ];
  for (const input of inputs) if (!(await stat(input)).isFile() && input !== resolve(sourceSam, "sam2")) throw new Error(`portable pack input 缺失：${input}`);
  if (!(await stat(resolve(sourceSam, "sam2"))).isDirectory()) throw new Error("SAM 2 source package 缺失");
  const [privatePem, publicPem] = await Promise.all([readFile(privateKeyPath, "utf8"), readFile(publicKeyPath, "utf8")]);
  const observedPublic = createPublicKey(createPrivateKey(privatePem)).export({ type: "spki", format: "pem" });
  if (observedPublic !== publicPem) throw new Error("Auto Roto publisher private/public key 不成對");
}

async function build() {
  await ensureInputs();
  await mkdir(packBase, { recursive: true });
  if (!inside(packBase, stagingRoot) || !inside(packBase, finalRoot)) throw new Error("portable pack target 超出 model-packs");
  try {
    await stat(finalRoot);
    throw new Error(`portable pack 已存在，拒絕覆寫：${finalRoot}`);
  } catch (error) {
    if (error?.code !== "ENOENT" && String(error).includes("拒絕覆寫")) throw error;
  }
  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });

  const inventoryScript = resolve(appRoot, "scripts/auto-roto-portable-runtime-inventory.py");
  const sourceInventory = JSON.parse((await run(sourcePython, ["-I", inventoryScript], { maxBuffer: 32 * 1024 * 1024 })).stdout);
  const pythonHome = resolve(sourceInventory.pythonHome);
  baseLibRoot = resolve(pythonHome, "Lib");
  const runtimeRoot = resolve(stagingRoot, "runtime");
  process.stdout.write(`AUTO_ROTO_PACK copying Python ${sourceInventory.pythonVersion}\n`);
  for (const name of ["python.exe", "python3.dll", "python310.dll", "vcruntime140.dll", "vcruntime140_1.dll", "LICENSE.txt"]) {
    await copyOne(resolve(pythonHome, name), resolve(runtimeRoot, name));
  }
  await cp(resolve(pythonHome, "DLLs"), resolve(runtimeRoot, "DLLs"), { recursive: true, force: false });
  await cp(resolve(pythonHome, "Lib"), resolve(runtimeRoot, "Lib"), { recursive: true, force: false, filter: baseLibFilter });
  process.stdout.write(`AUTO_ROTO_PACK copying ${sourceInventory.siteFiles.length} runtime package files\n`);
  for (const item of sourceInventory.siteFiles) await copyOne(item.source, resolve(runtimeRoot, "Lib/site-packages", item.relative));

  await cp(resolve(sourceSam, "sam2"), resolve(stagingRoot, "source/sam2"), {
    recursive: true, force: false,
    filter: (source) => !source.includes(`${resolve(sourceSam, "sam2")}\\__pycache__`) && !source.endsWith(".pyc"),
  });
  await copyOne(resolve(sourceSam, "checkpoints/sam2.1_hiera_tiny.pt"), resolve(stagingRoot, "source/checkpoints/sam2.1_hiera_tiny.pt"));
  await copyOne(resolve(sourceSam, "LICENSE"), resolve(stagingRoot, "licenses/SAM2-LICENSE.txt"));
  await copyOne(resolve(appRoot, "scripts/auto-roto-sam21-video-host.py"), resolve(stagingRoot, "host/auto-roto-sam21-video-host.py"));
  await writeFile(resolve(stagingRoot, "source/UPSTREAM_COMMIT"), `${sourceCommit}\n`, "utf8");
  await writeFile(resolve(stagingRoot, "licenses/THIRD-PARTY-NOTICES.json"), JSON.stringify({
    schema: "editkin.auto-roto-third-party-notices/v1",
    python: { version: sourceInventory.pythonVersion, license: "PSF-2.0", licensePath: "runtime/LICENSE.txt" },
    sam2: { commit: sourceCommit, license: "Apache-2.0", licensePath: "licenses/SAM2-LICENSE.txt" },
    packages: sourceInventory.versions,
  }, null, 2), "utf8");

  const probe = `import importlib,json,site,sys\nfrom pathlib import Path\nroot=Path(sys.executable).resolve().parent.parent\nsys.path.insert(0,str(root/'source'))\nnames=['torch','torchvision','numpy','PIL','hydra','omegaconf','iopath','sam2']\nmodules={name:importlib.import_module(name) for name in names}\npaths={name:str(Path(module.__file__).resolve().relative_to(root)).replace('\\\\','/') for name,module in modules.items()}\nimport torch\nprint(json.dumps({'schema':'editkin.auto-roto-python-runtime/v2','selfContained':all((root/Path(path)).is_file() for path in paths.values()),'isolated':sys.flags.isolated==1,'userSite':bool(site.ENABLE_USER_SITE),'externalImports':sum(0 if str(Path(module.__file__).resolve()).lower().startswith(str(root).lower()) else 1 for module in modules.values()),'pythonPath':'runtime/python.exe','pythonVersion':sys.version.split()[0],'torchVersion':torch.__version__,'cudaRuntime':torch.version.cuda,'cudaAvailable':torch.cuda.is_available(),'gpu':torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,'moduleRoots':paths},separators=(',',':')))\n`;
  const packPython = resolve(runtimeRoot, "python.exe");
  const environment = { ...process.env, PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", EDITKIN_AUTO_ROTO_OFFLINE: "1" };
  delete environment.PYTHONHOME; delete environment.PYTHONPATH;
  const runtimeReceipt = JSON.parse((await run(packPython, ["-I", "-B", "-c", probe], { cwd: stagingRoot, env: environment, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })).stdout);
  if (!runtimeReceipt.selfContained || !runtimeReceipt.isolated || runtimeReceipt.userSite || runtimeReceipt.externalImports !== 0 || !runtimeReceipt.cudaAvailable) {
    throw new Error(`portable runtime probe 未通過：${JSON.stringify(runtimeReceipt)}`);
  }
  await writeFile(resolve(runtimeRoot, "runtime-receipt.json"), JSON.stringify(runtimeReceipt, null, 2), "utf8");

  const fields = Object.fromEntries(await Promise.all([
    ["host", "host/auto-roto-sam21-video-host.py"], ["python", "runtime/python.exe"], ["sourceMarker", "source/UPSTREAM_COMMIT"],
    ["config", "source/sam2/configs/sam2.1/sam2.1_hiera_t.yaml"], ["checkpoint", "source/checkpoints/sam2.1_hiera_tiny.pt"],
    ["license", "licenses/SAM2-LICENSE.txt"], ["runtimeReceipt", "runtime/runtime-receipt.json"],
  ].map(async ([key, path]) => [key, { path, sha256: sha256(await readFile(resolve(stagingRoot, path))) }])));
  const manifestIdentity = {
    schema: "editkin.auto-roto-video-pack/v2", id: packId, version: packVersion, qualityTier: "production",
    publisherKeyId, signatureAlgorithm: "ed25519",
    hostPath: fields.host.path, hostSha256: fields.host.sha256,
    pythonPath: fields.python.path, pythonSha256: fields.python.sha256,
    sourceRoot: "source", sourceMarkerPath: fields.sourceMarker.path, sourceMarkerSha256: fields.sourceMarker.sha256,
    configPath: fields.config.path, configSha256: fields.config.sha256, configName: "configs/sam2.1/sam2.1_hiera_t.yaml",
    checkpointPath: fields.checkpoint.path, checkpointSha256: fields.checkpoint.sha256,
    licensePath: fields.license.path, licenseSha256: fields.license.sha256,
    runtimeReceiptPath: fields.runtimeReceipt.path, runtimeReceiptSha256: fields.runtimeReceipt.sha256,
    sourceCommit, precision: "float16", requiredDevice: "cuda",
  };
  const files = await walkPayload(stagingRoot);
  const receipt = {
    schema: "editkin.auto-roto-pack-receipt/v1", packId, packVersion, qualityTier: "production",
    publisherKeyId, sourceCommit, precision: "float16", requiredDevice: "cuda",
    manifestIdentitySha256: sha256(Buffer.from(JSON.stringify(manifestIdentity))),
    inventorySha256: sha256(Buffer.from(JSON.stringify(files))), files,
  };
  const receiptBytes = Buffer.from(JSON.stringify(receipt));
  const signatureText = `${sign(null, receiptBytes, await readFile(privateKeyPath, "utf8")).toString("base64")}\n`;
  await writeFile(resolve(stagingRoot, "pack-receipt.json"), receiptBytes);
  await writeFile(resolve(stagingRoot, "pack-receipt.sig"), signatureText, "utf8");
  const manifest = {
    ...manifestIdentity, receiptPath: "pack-receipt.json", receiptSha256: sha256(receiptBytes),
    signaturePath: "pack-receipt.sig", signatureSha256: sha256(Buffer.from(signatureText)),
  };
  await writeFile(resolve(stagingRoot, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  await rename(stagingRoot, finalRoot);
  const bytes = (await walkPayload(finalRoot)).reduce((sum, file) => sum + file.bytes, 0)
    + (await stat(resolve(finalRoot, "manifest.json"))).size + (await stat(resolve(finalRoot, "pack-receipt.json"))).size + (await stat(resolve(finalRoot, "pack-receipt.sig"))).size;
  await mkdir(reportRoot, { recursive: true });
  const report = {
    schema: "editkin.auto-roto-portable-pack-build/v1", status: "GREEN", packRoot: finalRoot, packId, packVersion,
    publisherKeyId, files: files.length + 3, bytes, runtime: runtimeReceipt,
    manifest: { path: resolve(finalRoot, "manifest.json"), sha256: sha256(await readFile(resolve(finalRoot, "manifest.json"))) },
    receipt: { path: resolve(finalRoot, "pack-receipt.json"), sha256: manifest.receiptSha256, inventorySha256: receipt.inventorySha256 },
    signature: { path: resolve(finalRoot, "pack-receipt.sig"), sha256: manifest.signatureSha256 },
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  process.stdout.write(`AUTO_ROTO_PACK status=GREEN files=${report.files} bytes=${bytes} root=${finalRoot}\n`);
}

try { await build(); }
catch (error) {
  if (inside(packBase, stagingRoot)) await rm(stagingRoot, { recursive: true, force: true });
  throw error;
}
