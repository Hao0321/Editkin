import type {WhisperModelDescriptor} from './automaticCaptions';
import {join,resolve} from 'node:path';
export type WhisperModelChoiceV1='small'|'medium';
/** Fixed multilingual whisper.cpp data file, authorized by Hao LONG-Q009.
 * This does not select medium by default or activate an installed MCP. */
export const OPTIONAL_WHISPER_MEDIUM_MODEL_V1:Readonly<WhisperModelDescriptor>=Object.freeze({
 id:'whisper-medium-multilingual-q5_0-v1',fileName:'ggml-medium-q5_0.bin',
 url:'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-medium-q5_0.bin',
 bytes:539212467,sha256:'19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f',license:'MIT'
});
export function whisperModelChoiceV1(value:unknown):WhisperModelChoiceV1 {
 if(value===undefined||value==='small')return 'small';
 if(value==='medium')return 'medium';
 throw Error('WHISPER_MODEL_CHOICE_INVALID: expected small or medium');
}
export function selectedWhisperModelV1(value:unknown,small:WhisperModelDescriptor):WhisperModelDescriptor {
 return whisperModelChoiceV1(value)==='medium'?OPTIONAL_WHISPER_MEDIUM_MODEL_V1:small;
}
export interface WhisperModelRuntimeFieldsV1 {
 modelRoot:string;modelPath?:string;whisperModel?:WhisperModelChoiceV1;
 mediumModelPath?:string;smallModelPath?:string;
}
/** modelPath historically configures small. The medium family has its own
 * optional override; selecting it never borrows or replaces that small file. */
export function withWhisperModelRuntimeV1<T extends WhisperModelRuntimeFieldsV1>(runtime:T,input:unknown,small:WhisperModelDescriptor):T {
 const choice=whisperModelChoiceV1(input??runtime.whisperModel);
 if(choice==='small'){
  if(runtime.whisperModel!=='medium')return runtime;
  return {...runtime,whisperModel:'small',modelPath:runtime.smallModelPath??join(resolve(runtime.modelRoot),small.fileName)};
 }
 const path=runtime.mediumModelPath??(runtime.whisperModel==='medium'?runtime.modelPath:undefined)??join(resolve(runtime.modelRoot),OPTIONAL_WHISPER_MEDIUM_MODEL_V1.fileName);
 return {...runtime,whisperModel:'medium',modelPath:resolve(path),smallModelPath:runtime.smallModelPath??(runtime.whisperModel==='medium'?join(resolve(runtime.modelRoot),small.fileName):runtime.modelPath)};
}
