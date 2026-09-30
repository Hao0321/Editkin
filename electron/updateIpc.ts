import { app, dialog, ipcMain } from "electron";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { verifyStagedUpdateCache } from "../src/application/updateCache";
import {
  compareVersions,
  createUpdateTransaction,
  loadUpdateManifest,
  readUpdateTransaction,
  signerIdentityMatches,
  stageUpdate,
  UPDATE_PUBLISHER_PIN,
  type StagedUpdate,
  type UpdatePublisherPin,
} from "../src/application/updateManager";

type SecureIpcHandle = (channel: string, listener: Parameters<typeof ipcMain.handle>[1]) => void;

function verifyAuthenticode(path: string, expectedSubject: string, expectedSha256: string): Promise<void> {
  if (process.platform !== "win32") return Promise.reject(new Error("Authenticode 驗證目前只支援 Windows"));
  const script = "$s=Get-AuthenticodeSignature -LiteralPath $env:HAO_UPDATE_SIGNATURE_TARGET; $c=$s.SignerCertificate; $sha=if($c){[BitConverter]::ToString($c.GetCertHash([Security.Cryptography.HashAlgorithmName]::SHA256)).Replace('-','').ToLowerInvariant()}else{''}; [pscustomobject]@{Status=[string]$s.Status;Subject=[string]$c.Subject;CertificateSha256=$sha} | ConvertTo-Json -Compress";
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolvePromise, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HAO_UPDATE_SIGNATURE_TARGET: path },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`Authenticode 驗證失敗：${stderr.trim()}`));
      try {
        const signature = JSON.parse(stdout.trim()) as { Status: string; Subject: string; CertificateSha256: string };
        if (signature.Status !== "Valid" || !signerIdentityMatches(
          { subject: signature.Subject, certificateSha256: signature.CertificateSha256 },
          { subject: expectedSubject, certificateSha256: expectedSha256 },
        )) return reject(new Error(`更新簽章不符合：${signature.Status} / ${signature.Subject || "unsigned"}`));
        resolvePromise();
      } catch (error) { reject(error); }
    });
  });
}

function spawnInstaller(path: string): Promise<void> {
  return new Promise((resolveSpawn, reject) => {
    const child = spawn(path, ["/S"], { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolveSpawn();
    });
  });
}

/** Starts the previous installer only if it carries the build's pinned publisher signature. */
export async function launchRollbackInstaller(path: string, publisher: UpdatePublisherPin | undefined = UPDATE_PUBLISHER_PIN): Promise<void> {
  if (!publisher) throw new Error("此版本沒有內建釘選的發布者 Authenticode 身分，拒絕執行 rollback installer");
  await verifyAuthenticode(path, publisher.signatureSubject, publisher.signatureSha256);
  await spawnInstaller(path);
}

export function registerUpdateIpc(secureIpcHandle: SecureIpcHandle, publisher: UpdatePublisherPin | undefined = UPDATE_PUBLISHER_PIN): void {
  let pendingUpdate: Readonly<StagedUpdate> | undefined;
  let operation: "checking" | "installing" | "started" | undefined;
  secureIpcHandle("hao:check-updates", async (_event, options?: { download?: boolean }) => {
    if (operation) return { status: "busy", message: "已有更新檢查或安裝正在進行，請稍候。" };
    operation = "checking";
    try {
      // Only development builds may redirect the channel; a packaged build follows its pinned manifest URL.
      const developmentManifestUrl = app.isPackaged ? undefined
        : process.env.EDITKIN_UPDATE_MANIFEST_URL ?? process.env.HAO_EDITOR_UPDATE_MANIFEST_URL;
      const manifestUrl = developmentManifestUrl ?? publisher?.manifestUrl;
      if (!manifestUrl) return { status: "unconfigured", message: "更新頻道尚未設定；本機 checksum／rollback 引擎已啟用。" };
      const manifest = await loadUpdateManifest(manifestUrl, { publisher });
      if (compareVersions(manifest.version, app.getVersion()) <= 0) {
        pendingUpdate = undefined;
        return { status: "current", message: "目前已是最新版。" };
      }
      if (manifest.minimumProjectSchema > 6) throw new Error("這個更新需要尚未支援的專案 schema");
      if (options?.download === false) return { status: "available", version: manifest.version, message: `有新版本 ${manifest.version}；尚未下載。` };
      const staged = await stageUpdate(manifest, {
        currentVersion: app.getVersion(), currentProjectSchema: 6, cacheRoot: join(app.getPath("userData"), "updates"), publisher,
      });
      pendingUpdate = staged ? Object.freeze({ ...staged }) : undefined;
      return pendingUpdate
        ? { status: "ready", version: pendingUpdate.version, cacheHit: pendingUpdate.cacheHit, message: `版本 ${pendingUpdate.version} 已下載並通過 SHA-256。` }
        : { status: "current", message: "目前已是最新版。" };
    } finally {
      operation = undefined;
    }
  });

  secureIpcHandle("hao:install-update", async () => {
    if (operation) return { started: false, message: "已有更新檢查或安裝正在進行，請稍候。" };
    if (!pendingUpdate) return { started: false, message: "沒有已驗證、待安裝的更新。" };
    const selected = Object.freeze({ ...pendingUpdate });
    const cacheRoot = join(app.getPath("userData"), "updates");
    operation = "installing";
    try {
      const unsignedDevelopmentUpdate = !publisher && !app.isPackaged && process.env.HAO_EDITOR_ALLOW_UNSIGNED_UPDATES === "1";
      if (!publisher && !unsignedDevelopmentUpdate) {
        return { started: false, message: "此版本沒有內建釘選的發布者 Authenticode 身分，release 模式拒絕執行 installer。" };
      }
      await verifyStagedUpdateCache(cacheRoot, selected);
      if (publisher) await verifyAuthenticode(selected.artifactPath, publisher.signatureSubject, publisher.signatureSha256);
      const choice = await dialog.showMessageBox({
        type: "question", title: "安裝更新", message: `安裝版本 ${selected.version}？`,
        detail: "專案檔不會被移動；應用程式將關閉，由已驗證的 installer 完成更新。", buttons: ["安裝並重新啟動", "取消"], defaultId: 0, cancelId: 1,
      });
      if (choice.response !== 0) return { started: false, message: "已取消更新。" };
      const transactionPath = join(cacheRoot, "transaction.json");
      const previousTransaction = await readUpdateTransaction(transactionPath);
      const cachedCurrentInstaller = previousTransaction?.status === "healthy" && previousTransaction.toVersion === app.getVersion()
        ? previousTransaction.stagedArtifact : undefined;
      await createUpdateTransaction(transactionPath, {
        fromVersion: app.getVersion(), toVersion: selected.version, stagedArtifact: selected.artifactPath,
        previousInstaller: (app.isPackaged ? undefined : process.env.HAO_EDITOR_PREVIOUS_INSTALLER) ?? cachedCurrentInstaller,
      });
      // Recheck the same selected digest after every asynchronous confirmation /
      // transaction step, immediately before starting that exact installer path.
      await verifyStagedUpdateCache(cacheRoot, selected);
      await spawnInstaller(selected.artifactPath);
      pendingUpdate = undefined;
      operation = "started";
      setTimeout(() => app.quit(), 250);
      return { started: true, message: "更新 installer 已啟動。" };
    } finally {
      if (operation === "installing") operation = undefined;
    }
  });
}
