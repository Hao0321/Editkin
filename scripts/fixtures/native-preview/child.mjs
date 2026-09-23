// Owned fault fixture only. No network, user-state writes, or installer execution.
import { spawn } from 'node:child_process';
import { writeFile, rename } from 'node:fs/promises';
const mode = process.argv[2];
if (process.argv[3]) {
  await writeFile(`${process.argv[3]}.writing`, JSON.stringify({mode,pid:process.pid}), {flag:'wx'});
  await rename(`${process.argv[3]}.writing`, process.argv[3]);
}
const lifetime = setTimeout(() => process.exit(91), 15000);
const finish = (code = 0) => { clearTimeout(lifetime); process.exitCode = code; };
async function input() {
  let bytes = 0;
  for await (const chunk of process.stdin) bytes += chunk.length;
  return bytes;
}
async function write(stream, value) {
  await new Promise((resolve, reject) => stream.write(value, error => error ? reject(error) : resolve()));
}
switch (mode) {
  case 'echo': {
    const receivedBytes = await input();
    await write(process.stdout, JSON.stringify({ ok: true, result: { receivedBytes } }));
    finish(); break;
  }
  case 'dual-pipe': {
    const receivedBytes = await input();
    await Promise.all([
      write(process.stdout, JSON.stringify({ ok: true, result: { receivedBytes, payload: 'x'.repeat(131072) } })),
      write(process.stderr, 'diagnostic '.repeat(13108)),
    ]);
    finish(); break;
  }
  case 'hang': await input(); break;
  case 'no-read': break;
  case 'stdout-limit': await input(); await write(process.stdout, 'x'.repeat(1048576)); break;
  case 'stderr-limit': await input(); await write(process.stderr, 'x'.repeat(1048576)); break;
  case 'ok-nonzero': await input(); await write(process.stdout, '{"ok":true,"result":{}}'); finish(7); break;
  case 'error-nonzero': await input(); await write(process.stdout, '{"ok":false,"error":"素材完整性驗證失敗"}'); await write(process.stderr, 'fixture-stderr-diagnostic'); finish(1); break;
  case 'invalid-json': await input(); await write(process.stdout, 'not-json'); finish(); break;
  case 'missing-result': await input(); await write(process.stdout, '{"ok":true}'); finish(); break;
  case 'truncated-json': await input(); await write(process.stdout, '{"ok":'); finish(); break;
  case 'delayed':
    await input();
    setTimeout(async () => { await write(process.stdout, '{"ok":true,"result":{}}'); finish(); }, 2000);
    break;
  case 'hang-with-descendant':
  case 'descendant-holds-pipes': {
    await input();
    const child = spawn(process.execPath, [import.meta.filename, 'hold-pipes'], {
      stdio: ['ignore', process.stdout, process.stderr], windowsHide: true,
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    if (process.argv[3]) await writeFile(`${process.argv[3]}.descendant`, JSON.stringify({pid:child.pid}), {flag:'wx'});
    await write(process.stdout, JSON.stringify({ ok: true, result: { descendantPid: child.pid } }));
    child.unref();
    if (mode === 'descendant-holds-pipes') finish(); break;
  }
  case 'hold-pipes': break;
  default: await write(process.stderr, `Unknown fixture mode: ${mode}`); finish(2);
}
