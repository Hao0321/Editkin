import { createEmptyProject } from "../domain/editGraph";
import { LONGFORM70_CATALOG_V1 } from "./longform70NativeCatalogV1";
import type { Longform70NativeSceneRequestV1 } from "../domain/longform70NativeSceneV1";

/** New owned copy, not a historical tutorial/topic/evidence claim. Real
 * renders replace the source URI with an owned generated recording. */
export function longform70NativeFixtureV1(recipeId:Longform70NativeSceneRequestV1["recipeId"],startFrame=0){
  const project=createEmptyProject("Owned longform70 native recipe fixture",{width:1920,height:1080,fps:30});
  const endFrame=startFrame+180,recipe=LONGFORM70_CATALOG_V1.recipes.find(row=>row.id===recipeId)!;
  const texts:Record<string,string>={verified_number:"42",number_context:"測試步驟",setup:"保留原文",focus_claim:"核對時間",
    connection_claim:"先看來源",payoff_claim:"再看結果",step_number:"01",action:"讀素材",support:"核對來源",
    verified_domain:"example.org",brand:"範例專案",invitation:"一起檢查"};
  const bindings:Longform70NativeSceneRequestV1["bindings"]={};
  for(const element of recipe.elements)if("binding"in element){
    const name=element.binding,first=recipeId==="relationship"&&name==="connection_claim",last=recipeId==="relationship"&&name==="payoff_claim";
    bindings[name]={text:texts[name],startFrame:last?startFrame+90:startFrame,endFrame:first?startFrame+90:endFrame,
      readingHoldFrames:24,minimumFontSize:name==="step_number"?300:Math.min(96,element.authoringOverrides.fontSize),
      evidenceRefs:["owned-fixture-copy:"+name]};
  }
  const request:Longform70NativeSceneRequestV1={schema:"editkin.longform70-native-scene-request/v1",expectedRevision:project.revision,
    sceneId:"fixture-"+recipeId,recipeId,startFrame,endFrame,scope:"empty_canvas",bindings,evidenceRefs:["owned-fixture-purpose"]};
  return{project,request};
}
