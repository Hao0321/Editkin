import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

async function readable(path) {
  try { await access(path); return true; } catch { return false; }
}

const pfxFile = process.env.HAO_WINDOWS_CERTIFICATE_FILE;
const pfxPassword = process.env.HAO_WINDOWS_CERTIFICATE_PASSWORD;
const signToolPath = process.env.HAO_WINDOWS_SIGNTOOL_PATH;
const signWithParams = process.env.HAO_WINDOWS_SIGN_PARAMS;
const tauriThumbprint = process.env.EDITKIN_WINDOWS_CERTIFICATE_THUMBPRINT;
const tauriSignCommand = process.env.EDITKIN_WINDOWS_SIGN_COMMAND;
let result;
if (tauriThumbprint) {
  result = /^[a-f0-9]{40}$/i.test(tauriThumbprint.replaceAll(" ", ""))
    ? { status: "READY", mode: "tauri-certificate-store", certificateThumbprintPresent: true }
    : { status: "BLOCK", mode: "tauri-certificate-store", reason: "certificate thumbprint 必須是 40 個 hex 字元" };
} else if (tauriSignCommand) {
  result = tauriSignCommand.includes("%1")
    ? { status: "READY", mode: "tauri-custom-or-cloud", commandPresent: true }
    : { status: "BLOCK", mode: "tauri-custom-or-cloud", reason: "sign command 必須包含 %1 binary placeholder" };
} else if (pfxFile || pfxPassword) {
  result = pfxFile && pfxPassword && await readable(pfxFile)
    ? { status: "BLOCK", mode: "electron-pfx-only", certificateFile: pfxFile, secretPresent: true, reason: "PFX 可簽 Electron 回退版；正式 Tauri 版需先匯入 CurrentUser certificate store 並提供 thumbprint" }
    : { status: "BLOCK", mode: "pfx", reason: "certificate file 不存在，或 password 尚未設定" };
} else if (signToolPath || signWithParams) {
  result = signToolPath && signWithParams && await readable(signToolPath)
    ? { status: "READY", mode: "custom-or-cloud", signToolPath, paramsPresent: true }
    : { status: "BLOCK", mode: "custom-or-cloud", reason: "signtool 不存在，或簽章參數尚未設定" };
} else {
  result = {
    status: "BLOCK",
    mode: "unsigned",
    reason: "尚未注入付費／合格憑證；本機 build 可用，但公開 release 不應 promotion",
    acceptedModes: ["EDITKIN_WINDOWS_CERTIFICATE_THUMBPRINT", "EDITKIN_WINDOWS_SIGN_COMMAND（含 %1）", "Microsoft Store submission"],
  };
}
const serialized = `${JSON.stringify(result, null, 2)}\n`;
const outputIndex = process.argv.indexOf("--output");
if (outputIndex >= 0 && process.argv[outputIndex + 1]) {
  const output = resolve(process.argv[outputIndex + 1]);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, serialized, "utf8");
}
process.stdout.write(serialized);
if (result.status !== "READY") process.exitCode = 2;
