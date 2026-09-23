import { spawn } from "node:child_process";
import electron from "electron";

const child = spawn(electron, ["."], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, HAO_EDITOR_SMOKE: "1" },
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => { stdout += String(chunk); });
child.stderr.on("data", (chunk) => { stderr += String(chunk); });
const timer = setTimeout(() => child.kill(), 30_000);
child.on("exit", (code) => {
  clearTimeout(timer);
  if (code === 0 && stdout.includes('"status":"GREEN"')) {
    console.log(stdout.trim());
  } else {
    console.error(stderr || stdout || `Electron exit ${code}`);
    process.exitCode = 1;
  }
});
