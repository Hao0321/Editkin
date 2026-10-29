import { open, readFile, rename, rm } from "node:fs/promises";

async function exists(path) {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function writeDurableExclusive(path, contents) {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function replaceFileTransactionally({ filePath, expectedBytes, replacementBytes, transactionName }) {
  if (!Buffer.isBuffer(expectedBytes) || !Buffer.isBuffer(replacementBytes) || replacementBytes.length === 0) {
    throw new TypeError("Transactional replacement requires non-empty Buffer identities");
  }
  const lockPath = `${filePath}.editkin-update.lock`;
  const temporaryPath = `${filePath}.editkin-update.tmp`;
  const legacyBackupPath = `${filePath}.editkin-update.backup`;
  let lock;
  try {
    lock = await open(lockPath, "wx");
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`Another product-ledger transaction is active: ${transactionName}`);
    throw error;
  }

  let failure;
  try {
    await lock.writeFile(`${JSON.stringify({ schema: "editkin.product-ledger-lock/v1", transactionName, pid: process.pid })}\n`);
    await lock.sync();
    if (await exists(temporaryPath) || await exists(legacyBackupPath)) {
      throw new Error("A previous product-ledger transaction residue exists; inspect it before retrying");
    }
    const currentBytes = await readFile(filePath);
    if (!currentBytes.equals(expectedBytes)) {
      throw new Error("Product ledger changed after it was read; refusing to overwrite concurrent work");
    }
    await writeDurableExclusive(temporaryPath, replacementBytes);
    const preCommitBytes = await readFile(filePath);
    if (!preCommitBytes.equals(expectedBytes)) {
      throw new Error("Product ledger changed before commit; refusing to overwrite concurrent work");
    }
    await rename(temporaryPath, filePath);
  } catch (error) {
    failure = error;
  } finally {
    await rm(temporaryPath, { force: true }).catch((error) => { failure ??= error; });
    await lock.close().catch((error) => { failure ??= error; });
    await rm(lockPath, { force: true }).catch((error) => { failure ??= error; });
  }
  if (failure) throw failure;
}
