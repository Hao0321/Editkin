import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const valueAfter = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const candidatePath = resolve(valueAfter("--candidate") ?? "native/bin/win32-x64/editkin-gpu-compositor.exe");
const baselineArg = valueAfter("--baseline");
const baselinePath = baselineArg ? resolve(baselineArg) : undefined;
const reportPath = resolve(
  valueAfter("--report")
    ?? "../../.rd/benchmarks/editkin-native-hdr-surface/report.json",
);

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

async function withServer(executable, run) {
  const child = spawn(executable, ["serve"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const stdout = createInterface({ input: child.stdout });
  const responses = new Map();
  const waiters = new Map();
  let ready;
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  stdout.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.event === "ready") {
      ready = message;
      waiters.get("ready")?.(message);
      return;
    }
    responses.set(message.id, message);
    waiters.get(message.id)?.(message);
  });
  const waitFor = (id, timeoutMs = 20_000) => new Promise((resolvePromise, reject) => {
    const existing = id === "ready" ? ready : responses.get(id);
    if (existing) return resolvePromise(existing);
    const timeout = setTimeout(() => reject(new Error(`native HDR surface request ${id} timed out: ${stderr.slice(-2000)}`)), timeoutMs);
    timeout.unref();
    waiters.set(id, (value) => { clearTimeout(timeout); waiters.delete(id); resolvePromise(value); });
  });
  let sequence = 0;
  const request = async (command, payload = {}) => {
    const id = `hdr-surface-${++sequence}`;
    child.stdin.write(`${JSON.stringify({ id, command, ...payload })}\n`);
    return waitFor(id);
  };
  try {
    await waitFor("ready", 30_000);
    return await run({ request, ready });
  } finally {
    if (child.exitCode === null) {
      try { await request("surface_release"); } catch {}
      try { await request("shutdown"); } catch {}
    }
    stdout.close();
    child.stdin.end();
    if (child.exitCode === null) child.kill();
  }
}

function verifySurface(receipt, expected) {
  requireCondition(receipt.ok, `${expected.name} surface bind failed: ${JSON.stringify(receipt)}`);
  const value = receipt.result;
  requireCondition(value.backend === "Dx12", `${expected.name} did not use DX12`);
  requireCondition(value.surfaceFormat === expected.format, `${expected.name} format mismatch: ${value.surfaceFormat}`);
  requireCondition(value.surfaceColorSpace === expected.colorSpace, `${expected.name} color-space mismatch: ${value.surfaceColorSpace}`);
  requireCondition(value.requestedColorSpace === expected.requested, `${expected.name} request receipt mismatch`);
  requireCondition(value.pixelContract === expected.pixelContract, `${expected.name} pixel contract mismatch`);
  requireCondition(value.hdrTransportConfigured === expected.hdr, `${expected.name} HDR transport flag mismatch`);
  requireCondition(value.legacyVideoPresentationAllowed === !expected.hdr, `${expected.name} legacy presentation guard mismatch`);
  requireCondition(value.dxgiColorSpaceConfiguration === "wgpu-dx12-IDXGISwapChain3-SetColorSpace1/v1", `${expected.name} DXGI receipt missing`);
  requireCondition(value.physicalDisplayHdrVisibility === "advisory-unverified", `${expected.name} overclaims physical display verification`);
  requireCondition(value.displayHdrInfo?.advisoryOnly === true, `${expected.name} live display evidence is not bounded`);
  return value;
}

async function exerciseCandidate(executable) {
  return withServer(executable, async ({ request, ready }) => {
    const sdr = verifySurface(await request("surface_bind", {
      parentHwnd: "0", x: 8, y: 8, width: 64, height: 36,
    }), {
      name: "SDR", format: "Bgra8UnormSrgb", colorSpace: "Auto", requested: "srgb",
      pixelContract: "legacy-sdr-video/v1", hdr: false,
    });
    const sdrProbe = await request("surface_probe");
    requireCondition(sdrProbe.ok && sdrProbe.result.presentCount === 1, "SDR surface did not acquire and present");
    requireCondition((await request("surface_release")).result.released === true, "SDR surface did not release");

    const pq = verifySurface(await request("surface_bind", {
      parentHwnd: "0", x: 8, y: 8, width: 64, height: 36, surfaceColorSpace: "bt2100_pq",
    }), {
      name: "PQ", format: "Rgb10a2Unorm", colorSpace: "Bt2100Pq", requested: "bt2100_pq",
      pixelContract: "rec2020-pq-encoded-rgb/v1", hdr: true,
    });
    const pqProbe = await request("surface_probe");
    requireCondition(pqProbe.ok && pqProbe.result.presentCount === 1, "PQ surface did not acquire and present");
    const pqResize = await request("surface_bind", {
      parentHwnd: "0", x: 10, y: 10, width: 80, height: 45, surfaceColorSpace: "rec2100_pq_1000",
    });
    requireCondition(pqResize.ok && pqResize.result.width === 80 && pqResize.result.surfaceColorSpace === "Bt2100Pq", "PQ surface resize lost its contract");
    const illegalModeSwitch = await request("surface_bind", {
      parentHwnd: "0", x: 10, y: 10, width: 80, height: 45, surfaceColorSpace: "srgb",
    });
    requireCondition(!illegalModeSwitch.ok && String(illegalModeSwitch.error).includes("cannot change without release"), "live surface color-space switch was not rejected");
    requireCondition((await request("surface_release")).result.released === true, "PQ surface did not release");

    const scrgb = verifySurface(await request("surface_bind", {
      parentHwnd: "0", x: 8, y: 8, width: 64, height: 36, surfaceColorSpace: "extended_srgb_linear",
    }), {
      name: "scRGB", format: "Rgba16Float", colorSpace: "ExtendedSrgbLinear", requested: "extended_srgb_linear",
      pixelContract: "rec709-linear-scrgb/v1", hdr: true,
    });
    const scrgbProbe = await request("surface_probe");
    requireCondition(scrgbProbe.ok && scrgbProbe.result.presentCount === 1, "scRGB surface did not acquire and present");
    requireCondition((await request("surface_release")).result.released === true, "scRGB surface did not release");

    const hlg = await request("surface_bind", {
      parentHwnd: "0", x: 8, y: 8, width: 64, height: 36, surfaceColorSpace: "bt2100_hlg",
    });
    requireCondition(!hlg.ok && String(hlg.error).includes("no RGB HLG"), "direct DX12 HLG surface was not rejected");
    const unknown = await request("surface_bind", {
      parentHwnd: "0", x: 8, y: 8, width: 64, height: 36, surfaceColorSpace: "display_p3",
    });
    requireCondition(!unknown.ok && String(unknown.error).includes("unsupported"), "unknown surface color space was not rejected");
    const invalid = await request("surface_bind", {
      parentHwnd: "0", x: 8, y: 8, width: 0, height: 36,
    });
    requireCondition(!invalid.ok, "zero-width surface was not rejected");

    return { ready, sdr, pq, scrgb, pqResize: pqResize.result, negatives: { hlg, unknown, invalid, illegalModeSwitch } };
  });
}

async function baselineRejectsHdr(executable) {
  return withServer(executable, async ({ request }) => {
    const response = await request("surface_bind", {
      parentHwnd: "0", x: 8, y: 8, width: 64, height: 36, surfaceColorSpace: "bt2100_pq",
    });
    return !response.ok || response.result?.surfaceColorSpace !== "Bt2100Pq" || response.result?.hdrTransportConfigured !== true;
  });
}

const candidateStat = await stat(candidatePath);
const candidate = await exerciseCandidate(candidatePath);
let baseline;
if (baselinePath) {
  baseline = {
    path: baselinePath,
    sha256: await sha256(baselinePath),
    rejectsHdrSurfaceContract: await baselineRejectsHdr(baselinePath),
  };
  requireCondition(baseline.rejectsHdrSurfaceContract, "baseline unexpectedly satisfies the HDR surface contract");
}

const report = {
  schema: "editkin.native-hdr-surface-gate/v1",
  status: "GREEN",
  generatedAt: new Date().toISOString(),
  claim: "DX12 PQ/scRGB swap-chain transport and advisory live display query only; calibrated ACES pixels and physical visible HDR require separate gates",
  candidate: { path: candidatePath, bytes: candidateStat.size, sha256: await sha256(candidatePath) },
  baseline,
  evidence: candidate,
  thresholds: {
    pqSurface: "Rgb10a2Unorm + Bt2100Pq",
    scRgbSurface: "Rgba16Float + ExtendedSrgbLinear",
    directHlgSurface: "must reject on DX12",
    physicalDisplayVisibility: "advisory-unverified",
  },
};
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ status: report.status, reportPath, candidate: report.candidate, baseline }, null, 2));
