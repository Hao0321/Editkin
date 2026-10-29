import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AutoReframeDesktopControlV1 } from "./AutoReframeDesktopControlV1";
import { autoReframeWorkflowFixtureV1 } from "../application/__fixtures__/autoReframeWorkflowV1.fixture";
import { createProjectSession } from "../application/projectSession";
import type { HaoDesktopApi } from "../desktop/apiTypes";
describe("mounted desktop reframe dimensions",()=>{
  it.each([[90,160],[720,1280],[1080,1920]])("keeps %s x %s portrait canvas eligible for current-project apply",(width,height)=>{
    const project=autoReframeWorkflowFixtureV1(false);project.width=width;project.height=height;
    const html=renderToStaticMarkup(<AutoReframeDesktopControlV1 project={project} session={createProjectSession(project)} clipId="selected"
      api={{runEngineTaskV1:async()=>{throw Error("not called by rendering");}} as unknown as HaoDesktopApi}
      onPause={()=>{}} onCommand={()=>({status:"applied"})} onNewProject={()=>({status:"created"})} />);
    expect(html).toContain('aria-pressed="true" data-testid="reframe-mode-current"');
    expect(html).not.toContain('disabled="" data-testid="reframe-mode-current"');
    expect(html).not.toContain('disabled="" data-testid="reframe-analyze"');
  });
});
