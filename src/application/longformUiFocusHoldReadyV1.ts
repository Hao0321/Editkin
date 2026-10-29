import type { LongformUiFocusArtifactV1 } from "../domain/longformUiFocusFileV1";
import type { LongformUiFocusHoldResultV1 } from "./longformUiFocusHoldJobsV1";
import { longformUiFocusHoldTargetV1 } from "./longformUiFocusHoldV1";
import { colorDigest } from "./materialColorSamplingRuntime";
export interface LongformUiFocusHoldReadyPortV1 {
  admit:()=>void;snapshot:()=>LongformUiFocusHoldResultV1|undefined;
  read:(signal?:AbortSignal)=>Promise<LongformUiFocusArtifactV1>;
  assertViewed:(frameId:string)=>void;
  validate:(result:LongformUiFocusHoldResultV1,signal?:AbortSignal)=>Promise<void>;
}
export function assertLongformUiFocusHoldReadyV1(port:LongformUiFocusHoldReadyPortV1){
  port.admit();const result=port.snapshot();if(!result||result.state!=='TRACKING_EVIDENCE_READY'||result.flags.length||!result.pixelTemplateContinuityVerified)
    throw Error('UI_FOCUS_HOLD_READY_OWNED_REQUIRED');const{receiptSha256,...body}=result;
  if(receiptSha256!==colorDigest(body))throw Error('UI_FOCUS_HOLD_READY_RECEIPT');return result;
}
/** Only the existing owner's private row creates this port. A serialized page
 * or a caller-sealed receipt can never establish ownership of a ready hold. */
export async function withLongformUiFocusHoldReadyV1<T>(port:LongformUiFocusHoldReadyPortV1,
  operation:(hold:LongformUiFocusHoldResultV1,validateCurrent:()=>Promise<void>,artifact:LongformUiFocusArtifactV1)=>Promise<T>,signal?:AbortSignal){
  signal?.throwIfAborted();const initial=structuredClone(assertLongformUiFocusHoldReadyV1(port));
  let latestArtifact:LongformUiFocusArtifactV1;
  const validateCurrent=async()=>{
    signal?.throwIfAborted();const current=assertLongformUiFocusHoldReadyV1(port);
    if(colorDigest(current)!==colorDigest(initial))throw Error('UI_FOCUS_HOLD_READY_CHANGED');
    const artifact=await port.read(signal);signal?.throwIfAborted();
    if(artifact.draft.draftId!==initial.draftId||artifact.draft.source.sha256!==initial.sourceSha256)throw Error('UI_FOCUS_HOLD_READY_ARTIFACT_CHANGED');
    const target=longformUiFocusHoldTargetV1(artifact.draft,{draftId:initial.draftId,candidateId:initial.candidateId,duration:initial.requestedDuration});
    port.assertViewed(target.candidate.frameId);await port.validate(structuredClone(initial),signal);signal?.throwIfAborted();
    if(colorDigest(assertLongformUiFocusHoldReadyV1(port))!==colorDigest(initial))throw Error('UI_FOCUS_HOLD_READY_CHANGED');
    port.assertViewed(target.candidate.frameId);
    latestArtifact=structuredClone(artifact);
  };
  await validateCurrent();const result=await operation(structuredClone(initial),validateCurrent,structuredClone(latestArtifact!));await validateCurrent();return result;
}
