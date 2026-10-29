import type { LongformUiFocusGeometryWitnessV1, LongformUiFocusProjectedQuadV1 } from "./longformUiFocusProjectGeometryV1";
export interface PreparedLongformUiFocusGeometryV1 {schema:'editkin.prepared-longform-ui-focus-geometry/v1';draftId:string;frameCount:number}
export interface LongformUiFocusGeometryDraftV1 {
  schema:'editkin.longform-ui-focus-geometry-draft/v1';draftId:string;artifactId:string;holdReceiptSha256:string;clockReceiptSha256:string;
  projectCanonicalSha256:string;sourceSha256:string;candidateId:string;canvas:{width:number;height:number};
  frames:Array<{projectFrame:number;sourcePts:number;sourceTime:number;imageSha256:string;sourceQuad:Array<{x:number;y:number}>;
    witness:LongformUiFocusGeometryWitnessV1;projected:LongformUiFocusProjectedQuadV1}>;
  provider:{route:'ffmpeg-source-hold-project-geometry';decodeRuntimeIdentitySha256:string;implementationSha256:string;
    processStdoutSha256:string;processStderrSha256:string;projectFrameHashSha256:string;outputFramesObserved:number};
  actualSourceHoldGeometryIntegrated:true;projectModified:false;editableProjectGraphCompiled:false;nativePresentationVerified:false;
  browserPresentationVerified:false;focusHintsReady:false;artworkStatus:'ART_PENDING_CLAUDE';selectableByDefault:false;
}
