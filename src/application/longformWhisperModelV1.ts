import {PINNED_WHISPER_MODEL} from './automaticCaptions';
import {withWhisperModelRuntimeV1,type WhisperModelRuntimeFieldsV1} from './whisperModelChoiceV1';
export interface LongformWhisperModelRuntimeFieldsV1 extends WhisperModelRuntimeFieldsV1 {modelPath:string}
/** Select a fixed admitted family; no model URL/descriptor comes from a
 * tool request. Preserve the original configured small path across choices. */
export function withLongformWhisperModelV1<T extends LongformWhisperModelRuntimeFieldsV1>(runtime:T,input:unknown):T {
 return withWhisperModelRuntimeV1(runtime,input,PINNED_WHISPER_MODEL);
}
