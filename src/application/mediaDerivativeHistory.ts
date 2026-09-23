import type {EditProject,MediaDerivatives} from '../domain/types';

export interface AcceptedDerivativeUpdate {assetId:string;sourceUri:string;derivatives:MediaDerivatives}
/** Already domain-validated metadata only. Never edits historical timeline/source decisions. */
export function synchronizeHistoricalDerivatives(project:EditProject,updates:AcceptedDerivativeUpdate[]):EditProject {
  let changed=false;
  const assets=project.assets.map(asset=>{
    let next=asset;
    for(const update of updates){
      if(asset.id!==update.assetId||asset.uri!==update.sourceUri)continue;
      if(next.derivatives?.sourceSha256&&next.derivatives.sourceSha256!==update.derivatives.sourceSha256)continue;
      next={...next,derivatives:structuredClone(update.derivatives)};
    }
    if(next!==asset)changed=true;
    return next;
  });
  return changed?{...project,assets}:project;
}
