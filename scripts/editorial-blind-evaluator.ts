import { prepareBlindPacket, scoreBlindResponses, type BlindResponse } from "./lib/editorial-blind";

if (!process.argv.includes("--self-test")) throw new Error("目前請以 --self-test 驗證 evaluator；真實盲測需先提供凍結案例、隱藏 mapping 與獨立 reviewers。");
const cases = [
  { id: "case-a", brief: "60 秒知識短片", baselineId: "baseline-a", editkinId: "editkin-a" },
  { id: "case-b", brief: "30 秒產品短片", baselineId: "baseline-b", editkinId: "editkin-b" },
];
const prepared = prepareBlindPacket(cases, "frozen-self-test-seed");
const responses: BlindResponse[] = [];
for (const reviewerId of ["reviewer-1", "reviewer-2", "reviewer-3"]) {
  for (const assignment of prepared.secret.assignments) responses.push({ reviewerId, caseId: assignment.caseId, preference: assignment.editkinSide, leftScore: assignment.editkinSide === "left" ? 5 : 3, rightScore: assignment.editkinSide === "right" ? 5 : 3, leftSevereError: false, rightSevereError: false });
}
const scored = scoreBlindResponses(prepared.secret, responses);
const leaked = JSON.stringify(prepared.packet).includes("editkin-") || JSON.stringify(prepared.packet).includes("baseline-");
let minimumRejected = false;
try { scoreBlindResponses(prepared.secret, responses.filter((item) => item.reviewerId === "reviewer-1")); } catch { minimumRejected = true; }
const status = !leaked && minimumRejected && scored.winRateExcludingTies === 1 && scored.reviewerCount === 3 ? "GREEN" : "BLOCK";
process.stdout.write(`${JSON.stringify({ status, assignmentHidden: !leaked, minimumReviewerGate: minimumRejected, scoreUnmasked: scored })}\n`);
if (status !== "GREEN") process.exitCode = 1;
