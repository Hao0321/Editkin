import { createHash } from "node:crypto";

export interface EditorialCase { id: string; brief: string; baselineId: string; editkinId: string }
export interface BlindResponse { reviewerId: string; caseId: string; preference: "left" | "right" | "tie"; leftScore: number; rightScore: number; leftSevereError: boolean; rightSevereError: boolean }

function swapFor(seed: string, caseId: string): boolean {
  return Number.parseInt(createHash("sha256").update(`${seed}:${caseId}`).digest("hex").slice(0, 8), 16) % 2 === 1;
}

export function prepareBlindPacket(cases: EditorialCase[], seed: string) {
  if (!seed || cases.length < 2 || new Set(cases.map((item) => item.id)).size !== cases.length) throw new Error("雙盲評測需要 seed 與至少兩個唯一案例");
  const secret = cases.map((item) => {
    const swap = swapFor(seed, item.id);
    return { caseId: item.id, leftId: swap ? item.editkinId : item.baselineId, rightId: swap ? item.baselineId : item.editkinId, editkinSide: swap ? "left" as const : "right" as const };
  });
  return {
    packet: { schemaVersion: 1, cases: cases.map((item) => ({ id: item.id, brief: item.brief, leftCandidate: `candidate://${item.id}/left`, rightCandidate: `candidate://${item.id}/right` })) },
    secret: { schemaVersion: 1, seedSha256: createHash("sha256").update(seed).digest("hex"), assignments: secret },
  };
}

export function scoreBlindResponses(secret: ReturnType<typeof prepareBlindPacket>["secret"], responses: BlindResponse[], minimumReviewers = 3) {
  const assignments = new Map(secret.assignments.map((item) => [item.caseId, item]));
  const reviewerIds = new Set(responses.map((item) => item.reviewerId));
  if (reviewerIds.size < minimumReviewers) throw new Error(`至少需要 ${minimumReviewers} 位獨立 reviewers`);
  let wins = 0; let losses = 0; let ties = 0; let severeErrors = 0; let scoreDelta = 0;
  for (const response of responses) {
    const assignment = assignments.get(response.caseId);
    if (!assignment || !response.reviewerId || ![response.leftScore, response.rightScore].every((score) => Number.isInteger(score) && score >= 1 && score <= 5)) throw new Error(`雙盲 response 不合法：${response.caseId}`);
    const editkinLeft = assignment.editkinSide === "left";
    const editkinPreference = response.preference === "tie" ? "tie" : (response.preference === assignment.editkinSide ? "win" : "loss");
    if (editkinPreference === "win") wins += 1; else if (editkinPreference === "loss") losses += 1; else ties += 1;
    severeErrors += Number(editkinLeft ? response.leftSevereError : response.rightSevereError);
    scoreDelta += editkinLeft ? response.leftScore - response.rightScore : response.rightScore - response.leftScore;
  }
  const decisions = wins + losses;
  return { reviewerCount: reviewerIds.size, responseCount: responses.length, wins, losses, ties, winRateExcludingTies: wins / Math.max(1, decisions), severeErrorRate: severeErrors / responses.length, meanScoreDelta: scoreDelta / responses.length };
}
