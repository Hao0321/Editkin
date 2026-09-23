import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const PREVIEW_FAMILIES = ["media", "caption", "look", "effect", "color", "card", "tag", "textAnimation", "transition"];
const AUTOPILOT_FAMILIES = ["speechRecognition", "editableCaptions", "captionDesign", "rhythm", "music", "ducking", "look", "effect", "transition", "motionGraphic", "tracking", "undo"];
const REMOTE_REQUIREMENTS = ["crossNetwork", "permanentBinding", "revocation", "outboundDesktop", "outboundMobile", "stableOrigin", "authenticatedRelay"];

export function evaluateNativeAutopilotExperience(evidence) {
  const failures = [];
  for (const family of PREVIEW_FAMILIES) {
    const item = evidence?.previews?.[family];
    if (!item?.visible || !item?.previewable || !item?.applicable) failures.push(`preview:${family}`);
  }
  for (const family of AUTOPILOT_FAMILIES) {
    const item = evidence?.autopilot?.[family];
    if (!item?.planned || !item?.mutatesEditableProject || !item?.reasonRecorded) failures.push(`autopilot:${family}`);
  }
  for (const requirement of REMOTE_REQUIREMENTS) {
    if (evidence?.remote?.[requirement] !== true) failures.push(`remote:${requirement}`);
  }
  if (evidence?.remote?.quickTunnelAccepted === true) failures.push("remote:quick-tunnel-must-not-close-production");
  if (evidence?.artifact?.installerExtracted !== true) failures.push("artifact:installer-extracted");
  if (evidence?.artifact?.renderVerified !== true) failures.push("artifact:render-verified");
  return { decision: failures.length ? "BLOCK" : "PASS", failures };
}

function completeFixture() {
  const previewItem = { visible: true, previewable: true, applicable: true };
  const autopilotItem = { planned: true, mutatesEditableProject: true, reasonRecorded: true };
  return {
    previews: Object.fromEntries(PREVIEW_FAMILIES.map((family) => [family, previewItem])),
    autopilot: Object.fromEntries(AUTOPILOT_FAMILIES.map((family) => [family, autopilotItem])),
    remote: Object.fromEntries([...REMOTE_REQUIREMENTS.map((item) => [item, true]), ["quickTunnelAccepted", false]]),
    artifact: { installerExtracted: true, renderVerified: true },
  };
}

async function selfTest() {
  const positive = evaluateNativeAutopilotExperience(completeFixture());
  if (positive.decision !== "PASS") throw new Error(`positive fixture blocked: ${positive.failures.join(", ")}`);
  for (const family of PREVIEW_FAMILIES) {
    const fixture = structuredClone(completeFixture());
    fixture.previews[family].previewable = false;
    if (!evaluateNativeAutopilotExperience(fixture).failures.includes(`preview:${family}`)) throw new Error(`missing preview family was not blocked: ${family}`);
  }
  for (const family of AUTOPILOT_FAMILIES) {
    const fixture = structuredClone(completeFixture());
    fixture.autopilot[family].reasonRecorded = false;
    if (!evaluateNativeAutopilotExperience(fixture).failures.includes(`autopilot:${family}`)) throw new Error(`missing autopilot reason was not blocked: ${family}`);
  }
  for (const requirement of REMOTE_REQUIREMENTS) {
    const fixture = structuredClone(completeFixture());
    fixture.remote[requirement] = false;
    if (!evaluateNativeAutopilotExperience(fixture).failures.includes(`remote:${requirement}`)) throw new Error(`missing remote requirement was not blocked: ${requirement}`);
  }
  const tunnelFixture = completeFixture();
  tunnelFixture.remote.quickTunnelAccepted = true;
  if (!evaluateNativeAutopilotExperience(tunnelFixture).failures.includes("remote:quick-tunnel-must-not-close-production")) throw new Error("quick tunnel false positive was not blocked");
  console.log("native autopilot experience gate self-test passed");
}

async function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  const path = resolve(process.argv[2] ?? ".rd/benchmarks/editkin-native-autopilot-experience.json");
  const evidence = JSON.parse(await readFile(path, "utf8"));
  const result = evaluateNativeAutopilotExperience(evidence);
  console.log(JSON.stringify({ evidence: path, ...result }, null, 2));
  if (result.decision !== "PASS") process.exitCode = 1;
}

await main();
