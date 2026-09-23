import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Cross-process publish lock, not a transcoding lock. Never steals a lock by age.
 * A crashed owner leaves a visible lock requiring explicit operator recovery.
 */
export async function withMediaCachePublishLock<T>(directory: string, operation: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) throw new Error('媒體快取 publish lock 等待上限不合法');
  const lock = `${directory}.publish-lock`, ownerPath = join(lock, 'owner.json');
  const owner = JSON.stringify({ schema: 'editkin.media-cache-publish-lock/v1', pid: process.pid, token: randomUUID() });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { await mkdir(lock); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) throw new Error(`媒體快取發布鎖等待逾時；未覆寫任何有效快取。請確認其他產生工作已結束後再檢查：${lock}`);
      await new Promise(resolve => setTimeout(resolve, Math.min(40, Math.max(1, deadline - Date.now()))));
    }
  }
  try { await writeFile(ownerPath, owner, { flag: 'wx' }); }
  catch (error) { await rmdir(lock).catch(() => undefined); throw error; }
  try { return await operation(); }
  finally {
    // Unknown/replaced ownership is never removed; no recursive lock deletion.
    if (await readFile(ownerPath, 'utf8') !== owner) throw new Error('媒體快取發布鎖 owner 已改變；保留鎖與快取供檢查');
    await unlink(ownerPath);
    await rmdir(lock);
  }
}
