import {hashBytes} from './editkin-mcp-generation-contract.mjs';
import {verifyMaterialColorRuntimePair} from './material-color-runtime-pair.mjs';

const key=Symbol.for('editkin.material-color.verified-data-bundle/v1');
/** Caller supplies a fully verified generation snapshot; imports only those bytes.
 * The module independently compares its data URL bytes, live files and sidecar.
 * This context is an integrity binding, not an authentication boundary in JS. */
export async function importVerifiedMaterialColorGeneration(snapshot,importModule){
  const bytes=Buffer.from(snapshot.entrypointBytes),bundleSha256=hashBytes(bytes);
  const sidecarPath=`${snapshot.manifest.entrypoint}.material-color-identity.json`;
  const record=snapshot.manifest.files.find(file=>file.path===sidecarPath);
  if(!record)throw Error('generation-material-color-sidecar-required');
  const pair=await verifyMaterialColorRuntimePair(snapshot.entrypoint);
  if(pair.bundleSha256!==bundleSha256||pair.sidecarSha256!==record.sha256)throw Error('generation-material-color-identity-drift');
  if(Object.hasOwn(globalThis,key))throw Error('generation-material-color-bridge-busy');
  const context=Object.freeze({schema:'editkin.material-color-data-context/v1',entrypoint:snapshot.entrypoint,bundleSha256,sidecarSha256:record.sha256});
  // Node caches ESM by URL. Equal bytes in distinct immutable generations must
  // not reuse the first generation's captured live-file identity context.
  const instance=hashBytes(JSON.stringify(context));
  Object.defineProperty(globalThis,key,{value:context,configurable:true,writable:false});
  try{return await importModule(`data:text/javascript;base64,${bytes.toString('base64')}#editkin-generation-${instance}`);}
  finally{delete globalThis[key];}
}
