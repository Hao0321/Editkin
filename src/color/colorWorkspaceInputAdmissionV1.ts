import {acesPrecisionBlockReason,resolveAcesInput,resolveInputColorSpace} from './primaryGrade';
import type {MediaAsset,ColorManagementSettings} from '../domain/types';
/** Invalid metadata remains blocked and editable in the workspace. No assumed
 * Rec.709 fallback, guessed HDR tags, or change to the formal render admission. */
export function colorWorkspaceInputAdmissionV1(asset:MediaAsset,management:ColorManagementSettings){
  try{return{acesInput:resolveAcesInput(asset),legacyInput:resolveInputColorSpace(asset),precisionBlock:management.mode==='aces2'?acesPrecisionBlockReason(asset,management):undefined,metadataInvalid:false};}
  catch{return{acesInput:'blocked_log' as const,legacyInput:'blocked_log' as const,precisionBlock:'素材色彩標記無法解讀，請先修正 Input Transform。',metadataInvalid:true};}
}
