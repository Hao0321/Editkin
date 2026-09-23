import { useCallback, useEffect, useRef, useState } from "react";
import type { CreativeLibraryAsset, CreativeLibrarySummary } from "../application/creativeLibrary";
import { creativeAssetUri } from "../shared/creativeAssetUri";
import type { EditorCommand } from "../domain/commands";
import type { MediaAsset } from "../domain/types";
import type { HaoDesktopApi, PickedMedia, PluginRegistrySummary, PrepareMediaResult } from "./types";
import type { EditkinWorkflowProfile } from "../plugins/skillPack";
import type { ProjectSession } from "../application/projectSession";
import { acceptProjectTask } from "../application/projectTask";
import {useMediaPreviewRepair} from "./useMediaPreviewRepair";

interface DesktopMediaLibraryOptions {
  api?: HaoDesktopApi;
  projectSession: ProjectSession;
  onPicked: (items: PickedMedia[], options?: { backgroundMusic?: boolean }) => void;
  onPrepared: (items: PrepareMediaResult[], isCurrent?: () => boolean) => void;
  onStatus: (message: string) => void;
  onCommands: (commands: EditorCommand[], message: string) => void;
}
export interface MediaImportState {phase:"idle"|"preparing"|"failed"|"partial";total:number;completed:number;failed:number;message:string;sessionId?:number;timelineCommitted?:boolean;}
interface FailedPendingImport {items:PickedMedia[];backgroundMusic:boolean;isCurrent:()=>boolean;}
interface FailedCommittedCreative {picked:PickedMedia;isCurrent:()=>boolean;}

let provisionalCreativeSequence = 0;

/**
 * Build only from the metadata returned by listCreativeLibrary.  Visual media
 * must already have its measured duration and dimensions; otherwise the hook
 * deliberately falls back to the native resolve/probe path instead of making
 * up timeline geometry.
 */
export function provisionalCreativePick(assetId:string,listed:CreativeLibraryAsset|undefined):PickedMedia|undefined{
  const duration=listed?.duration,width=listed?.width,height=listed?.height;
  if(!listed||listed.id!==assetId||!assetId.trim()||assetId.includes("/")||assetId.includes("\\")
    ||!listed.name.trim()||!Number.isSafeInteger(listed.bytes)||listed.bytes<=0
    ||typeof duration!=="number"||!Number.isFinite(duration)||duration<=0
    ||!["video","audio","image"].includes(listed.mediaKind))return;
  const visual=listed.mediaKind!=="audio";
  if(visual&&(typeof width!=="number"||!Number.isSafeInteger(width)||width<=0||typeof height!=="number"||!Number.isSafeInteger(height)||height<=0))return;
  const uri=creativeAssetUri(assetId),colorMetadata=listed.colorMetadata;
  const asset:MediaAsset={
    id:`asset-creator-${Date.now().toString(36)}-${(++provisionalCreativeSequence).toString(36)}`,
    name:listed.name.trim(),kind:listed.mediaKind,uri,duration,
    ...(visual?{width:width!,height:height!}:{}),
    ...(listed.role?{role:listed.role}:{}),...(listed.bpm!==undefined?{bpm:listed.bpm}:{}),
    ...(listed.license?{license:listed.license}:{}),...(listed.provenance?{provenance:listed.provenance}:{}),
    ...(listed.redistributable!==undefined?{redistributable:listed.redistributable}:{}),
    ...(listed.rightsBasis?{rightsBasis:listed.rightsBasis}:{}),
    ...(listed.distributionScope?{distributionScope:listed.distributionScope}:{}),
    color:{interpretation:"auto",
      ...(colorMetadata?.primaries?{primaries:colorMetadata.primaries}:{}),
      ...(colorMetadata?.transfer?{transfer:colorMetadata.transfer}:{}),
      ...(colorMetadata?.matrix?{matrix:colorMetadata.matrix}:{}),
      ...(colorMetadata?.range?{range:colorMetadata.range}:{})},
  };
  // The virtual URI is intentionally not a browser file URL.  It keeps the
  // project portable and makes every native consumer resolve + hash-check the
  // pack entry before use; prepareMedia replaces this runtime URL in background.
  return{asset,previewUrl:uri};
}

export function useCreativeLibrary({ api, projectSession, onPicked, onPrepared, onStatus, onCommands }: DesktopMediaLibraryOptions) {
  const {repairPreview,previewRepair}=useMediaPreviewRepair(api,projectSession,onPrepared);
  const [library, setLibrary] = useState<CreativeLibrarySummary>();
  const [plugins, setPlugins] = useState<PluginRegistrySummary>();
  const [workflowProfile, setWorkflowProfile] = useState<EditkinWorkflowProfile>();
  const [loading, setLoading] = useState(Boolean(api));
  const [pluginLoading, setPluginLoading] = useState(Boolean(api));
  const [pluginBusy, setPluginBusy] = useState<string>();
  const [importingId, setImportingId] = useState<string>();
  const [previewingId, setPreviewingId] = useState<string>();
  const libraryScope = useRef<{api?:HaoDesktopApi;summary?:CreativeLibrarySummary}>({api});
  if(libraryScope.current.api!==api)libraryScope.current={api};
  const audioRef = useRef<HTMLAudioElement | undefined>(undefined);
  const audioMounted = useRef(true);
  const audioScope = useRef({ api, projectSession });
  audioScope.current = { api, projectSession };
  const audioRequest = useRef<{ assetId: string; api: HaoDesktopApi; session: ProjectSession; sessionId: number } | undefined>(undefined);
  const pluginPending = useRef(false);
  const creativeImportPending = useRef(false);
  const mediaImportPending = useRef(false);
  const failedPendingImport = useRef<FailedPendingImport|undefined>(undefined);
  const failedCommittedCreative = useRef<Map<string,FailedCommittedCreative>>(new Map());
  const creativePrepareLanes = useRef<[Promise<void>, Promise<void>]>([Promise.resolve(), Promise.resolve()]);
  const creativePrepareCursor = useRef(0);
  const [importState,setImportState]=useState<MediaImportState>({phase:"idle",total:0,completed:0,failed:0,message:""});

  const refreshPlugins = useCallback(async () => {
    if (!api) { setPluginLoading(false); return; }
    setPluginLoading(true);
    try {
      const [nextPlugins, nextProfile] = await Promise.all([api.listInstalledPlugins(), api.getWorkflowProfile()]);
      setPlugins(nextPlugins);
      setWorkflowProfile(nextProfile.profile);
    } catch (error) {
      onStatus(error instanceof Error ? `外掛載入失敗：${error.message}` : "外掛載入失敗");
    } finally {
      setPluginLoading(false);
    }
  }, [api, onStatus]);

  useEffect(() => {
    let active = true;
    if (!api) { setLoading(false); return; }
    setLoading(true);
    void api.listCreativeLibrary().then((loaded) => {
      if (active) { libraryScope.current={api,summary:loaded}; setLibrary(loaded); }
    }).catch((error) => {
      if (active) onStatus(error instanceof Error ? `Creator Pack 載入失敗：${error.message}` : "Creator Pack 載入失敗");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, onStatus]);

  useEffect(() => {
    void refreshPlugins();
  }, [refreshPlugins]);

  function stopAudioPreview(publish = true) {
    audioRequest.current = undefined;
    const audio = audioRef.current;
    audioRef.current = undefined;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
    }
    if (publish && audioMounted.current) setPreviewingId(undefined);
  }

  useEffect(() => {
    audioMounted.current = true;
    return () => { audioMounted.current = false; stopAudioPreview(false); };
  }, []);
  useEffect(() => {
    const cancelStale = () => {
      const request = audioRequest.current;
      if (request && (request.api !== api || request.session !== projectSession || !projectSession.isCurrentSession(request.sessionId))) stopAudioPreview();
    };
    cancelStale();
    const unsubscribe = projectSession.subscribe(cancelStale);
    return () => {
      unsubscribe();
      const request = audioRequest.current;
      if (request && request.api === api && request.session === projectSession) stopAudioPreview();
    };
  }, [api, projectSession]);

  const resolveCreativeAssetPreview = useCallback(async (assetId: string, mode: "poster" | "media" = "media") => {
    if (!api) throw new Error("Creator Pack 需要桌面版 runtime");
    return api.previewCreativeAsset(assetId, mode);
  }, [api]);

  async function prepareAndCommit(items:PickedMedia[],backgroundMusic:boolean,isCurrent:()=>boolean){
    if(!api||!items.length||!isCurrent())return;
    const sessionId=projectSession.getSnapshot().sessionId;
    const ready:Array<{picked:PickedMedia;prepared:PrepareMediaResult}|undefined>=new Array(items.length),failed:PickedMedia[]=[];
    let next=0,completed=0;const errors:string[]=[];
    const publish=()=>{if(isCurrent())setImportState({phase:"preparing",total:items.length,completed,failed:failed.length,sessionId,message:`正在準備可播放預覽 ${completed}/${items.length}；完成前不會加入時間軸。`});};publish();
    const worker=async()=>{while(next<items.length&&isCurrent()){const index=next++,picked=items[index]!;try{
      const prepared=await api.prepareMedia(picked.asset),url=prepared.runtimeUrls?.[picked.asset.id];
      if(prepared.assetId!==picked.asset.id||typeof url!=="string"||!url.trim())throw Error("預覽準備未回傳對應素材的可用網址");
      ready[index]={picked:{...picked,asset:{...picked.asset,derivatives:prepared.derivatives},previewUrl:url},prepared};
    }catch(error){failed.push(picked);errors.push(error instanceof Error?error.message:String(error));}finally{completed++;publish();}}};
    await Promise.all(Array.from({length:Math.min(2,items.length)},worker));
    if(!isCurrent())return;
    const valid=ready.filter((item):item is NonNullable<typeof item>=>Boolean(item));
    failedPendingImport.current=failed.length?{items:failed,backgroundMusic,isCurrent}:undefined;
    if(valid.length){onPicked(valid.map(item=>item.picked),{backgroundMusic});applyCurrentPrepared(valid.map(item=>item.prepared),valid.map(item=>item.picked));}
    const message=failed.length?`已加入 ${valid.length} 份；${failed.length} 份預覽準備失敗，尚未加入時間軸。可重試失敗項目。${errors[0]?` ${errors[0]}`:""}`:`已加入 ${valid.length} 份素材，預覽已準備完成。`;
    setImportState({phase:failed.length?(valid.length?"partial":"failed"):"idle",total:items.length,completed,failed:failed.length,message,sessionId});onStatus(message);
  }
  async function importWith(pick:()=>Promise<PickedMedia[]>,backgroundMusic=false){
    if(!api||mediaImportPending.current)return;mediaImportPending.current=true;
    const task=projectSession.beginTask(),sessionId=projectSession.getSnapshot().sessionId;
    try{const picked=await pick();if(!task.isSessionCurrent()||!picked.length)return;failedPendingImport.current=undefined;await prepareAndCommit(picked,backgroundMusic,task.isSessionCurrent);}
    catch(error){if(task.isSessionCurrent()){const message=`匯入未完成：${error instanceof Error?error.message:String(error)}`;setImportState({phase:"failed",total:0,completed:0,failed:0,message,sessionId});onStatus(message);}}
    finally{mediaImportPending.current=false;}
  }
  const importDesktopMedia=()=>importWith(()=>api!.pickMedia());
  const importDesktopPaths=(paths:string[])=>paths.length?importWith(()=>api!.importMediaPaths(paths)):Promise.resolve();

  async function prepareCommittedCreative(items:PickedMedia[],backgroundMusic:boolean,isCurrent:()=>boolean){
    if(!api||!items.length||!isCurrent())return;
    const sessionId=projectSession.getSnapshot().sessionId;
    const ready:Array<{picked:PickedMedia;prepared:PrepareMediaResult}|undefined>=new Array(items.length),failed:PickedMedia[]=[];
    let next=0,completed=0;const errors:string[]=[];
    const publish=()=>{if(isCurrent())setImportState({phase:"preparing",total:items.length,completed,failed:failed.length,sessionId,timelineCommitted:true,message:`素材已加入時間軸；正在背景驗證來源並最佳化預覽 ${completed}/${items.length}。`});};publish();
    const worker=async()=>{while(next<items.length&&isCurrent()){const index=next++,picked=items[index]!;try{
      const prepared=await api.prepareMedia(picked.asset),url=prepared.runtimeUrls?.[picked.asset.id];
      if(prepared.assetId!==picked.asset.id||typeof url!=="string"||!url.trim())throw Error("預覽準備未回傳對應素材的可用網址");
      ready[index]={picked,prepared};
    }catch(error){failed.push(picked);errors.push(error instanceof Error?error.message:String(error));}finally{completed++;publish();}}};
    await Promise.all(Array.from({length:Math.min(2,items.length)},worker));
    if(!isCurrent())return;
    const valid=ready.filter((item):item is NonNullable<typeof item>=>Boolean(item));
    for(const item of items)failedCommittedCreative.current.delete(item.asset.id);
    for(const picked of failed)failedCommittedCreative.current.set(picked.asset.id,{picked,isCurrent});
    const pendingFailures=[...failedCommittedCreative.current.values()].filter(item=>item.isCurrent());
    if(valid.length)applyCurrentPrepared(valid.map(item=>item.prepared),valid.map(item=>item.picked));
    const message=pendingFailures.length
      ? `素材已在時間軸（目前只是占位）；${pendingFailures.length} 份來源驗證或預覽最佳化失敗。系統不會假裝成功，輸出時仍會重新驗證來源；可重試。${errors[0]?` ${errors[0]}`:""}`
      : `已加入 ${valid.length} 份內建素材；代理預覽已在背景完成。`;
    setImportState({phase:pendingFailures.length?"failed":"idle",total:Math.max(items.length,pendingFailures.length),completed,failed:pendingFailures.length,message,sessionId,timelineCommitted:true});onStatus(message);
  }

  function queueCreativePreparation(items:PickedMedia[],backgroundMusic:boolean,isCurrent:()=>boolean){
    const lane=creativePrepareCursor.current%creativePrepareLanes.current.length;
    creativePrepareCursor.current+=1;
    const run=creativePrepareLanes.current[lane].catch(()=>undefined).then(()=>prepareCommittedCreative(items,backgroundMusic,isCurrent));
    creativePrepareLanes.current[lane]=run.catch(()=>undefined);
  }

  const importCreativeAsset=async(assetId:string)=>{
    if(!api||creativeImportPending.current||mediaImportPending.current)return;
    creativeImportPending.current=true;setImportingId(assetId);
    const task=projectSession.beginTask(),sessionId=projectSession.getSnapshot().sessionId;
    try{
      const listed=libraryScope.current.api===api?libraryScope.current.summary?.assets.find(asset=>asset.id===assetId):undefined;
      const provisional=provisionalCreativePick(assetId,listed);
      if(provisional){
        failedCommittedCreative.current.delete(provisional.asset.id);
        const backgroundMusic=assetId.startsWith("music:");
        onPicked([provisional],{backgroundMusic});
        const message="內建素材已立即放入時間軸；來源驗證、代理檔與縮圖正在背景處理。";
        setImportState({phase:"preparing",total:1,completed:0,failed:0,message,sessionId,timelineCommitted:true});onStatus(message);
        queueCreativePreparation([provisional],backgroundMusic,task.isSessionCurrent);
        return;
      }
      const picked=await api.importCreativeAsset(assetId);
      if(!task.isSessionCurrent())return;
      failedCommittedCreative.current.delete(picked.asset.id);
      const backgroundMusic=assetId.startsWith("music:");
      onPicked([picked],{backgroundMusic});
      const message="內建素材已立即加入時間軸；代理檔與縮圖會在背景最佳化。";
      setImportState({phase:"preparing",total:1,completed:0,failed:0,message,sessionId,timelineCommitted:true});onStatus(message);
      queueCreativePreparation([picked],backgroundMusic,task.isSessionCurrent);
    }catch(error){if(task.isSessionCurrent()){const message=`匯入未完成：${error instanceof Error?error.message:String(error)}`;setImportState({phase:"failed",total:0,completed:0,failed:0,message,sessionId});onStatus(message);}}
    finally{creativeImportPending.current=false;setImportingId(undefined);}
  };
  const retryFailedImports=async()=>{
    const pending=failedPendingImport.current;
    const committed=[...failedCommittedCreative.current.values()].filter(item=>item.isCurrent());
    if((!pending||!pending.isCurrent())&&!committed.length||mediaImportPending.current)return;
    mediaImportPending.current=true;try{
      if(pending?.isCurrent())await prepareAndCommit(pending.items,pending.backgroundMusic,pending.isCurrent);
      if(committed.length){const isCurrent=()=>committed.every(item=>item.isCurrent());await prepareCommittedCreative(committed.map(item=>item.picked),false,isCurrent);}
    }catch(error){const current=pending?.isCurrent()||committed.some(item=>item.isCurrent());if(current){const message=`重試匯入未完成：${error instanceof Error?error.message:String(error)}`;setImportState({phase:"failed",total:0,completed:0,failed:0,message,sessionId:projectSession.getSnapshot().sessionId});onStatus(message);}}finally{mediaImportPending.current=false;}
  };

  function applyCurrentPrepared(prepared: PrepareMediaResult[], picked: PickedMedia[]) {
    const sources = new Map(picked.map(item => [item.asset.id, item.asset.uri]));
    const assets = projectSession.getSnapshot().history.present.assets;
    const current = prepared.filter(item => assets.some(asset => asset.id === item.assetId && asset.uri === sources.get(item.assetId)));
    if (current.length) onPrepared(current);
  }

  const previewCreativeAsset = async (assetId: string) => {
    if (!api || !audioMounted.current || audioScope.current.api !== api || audioScope.current.projectSession !== projectSession) return;
    const sessionId = projectSession.getSnapshot().sessionId;
    const previous = audioRequest.current;
    if (previous?.assetId === assetId && previous.api === api && previous.session === projectSession && previous.sessionId === sessionId) {
      stopAudioPreview();
      return;
    }
    stopAudioPreview();
    const request = { assetId, api, session: projectSession, sessionId };
    audioRequest.current = request;
    const current = () => audioMounted.current && audioRequest.current === request
      && audioScope.current.api === api && audioScope.current.projectSession === projectSession
      && projectSession.isCurrentSession(sessionId);
    // A pending selection is also stoppable: rapid second clicks must not start
    // a second resolver or resurrect playback after the user canceled it.
    setPreviewingId(assetId);
    try {
      const source = await resolveCreativeAssetPreview(assetId);
      if (!current()) return;
      const audio = new Audio(source);
      audio.volume = 0.65;
      audio.onended = () => { if (current() && audioRef.current === audio) stopAudioPreview(); };
      audio.onerror = () => {
        if (!current() || audioRef.current !== audio) return;
        stopAudioPreview();
        onStatus("音樂預聽失敗");
      };
      audioRef.current = audio;
      await audio.play();
    } catch (error) {
      if (!current()) return;
      stopAudioPreview();
      onStatus(error instanceof Error ? error.message : "音樂預聽失敗");
    }
  };

  const invokePluginTool = async (pluginId: string, capabilityId: string, targetClipId: string, parameters: Record<string, unknown> = {}) => {
    if (!api || pluginPending.current) return;
    const task = projectSession.beginTask();
    pluginPending.current = true;
    const busyId = `${pluginId}/${capabilityId}`;
    setPluginBusy(busyId);
    try {
      const commands = await api.compilePluginTool(pluginId, capabilityId, targetClipId, parameters);
      if (!acceptProjectTask(task, onStatus, "外掛處理")) return;
      const name = plugins?.plugins.find((plugin) => plugin.id === pluginId)?.capabilities.find((capability) => capability.id === capabilityId)?.name ?? capabilityId;
      const gpuEffect = commands.some((command) => command.type === "add_native_effect" && command.instance.runtimeType === "gpu_effect_graph");
      const cpuEffect = commands.some((command) => command.type === "add_native_effect" && command.instance.runtimeType !== "gpu_effect_graph");
      onCommands(commands, gpuEffect
        ? `已加入「${name}」；即時預覽與正式輸出使用同一 GPU shader graph，可直接復原。`
        : cpuEffect
          ? `已加入「${name}」；即時預覽會快取同一原生 worker 的影格，正式輸出沿用相同執行器，可直接復原。`
          : `已套用「${name}」；可直接復原。`);
    } catch (error) {
      if (acceptProjectTask(task, onStatus, "外掛處理")) onStatus(error instanceof Error ? error.message : `外掛執行失敗：${String(error)}`);
    } finally { pluginPending.current = false; setPluginBusy(undefined); }
  };

  const openPluginFolder = async () => {
    if (!api) return;
    try {
      const result = await api.openPluginFolder();
      onStatus(`外掛資料夾：${result.path}。放入外掛後按「重新掃描」，不必重開 Editkin。`);
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "無法開啟外掛資料夾");
    }
  };

  const updateWorkflowProfile = async (profile: EditkinWorkflowProfile) => {
    if (!api) throw new Error("Workflow Profile 需要桌面版原生儲存");
    const saved = await api.saveWorkflowProfile(profile);
    setWorkflowProfile(saved.profile);
    onStatus(`Workflow Profile r${saved.profile.revision} 已由 Editkin 原子保存，Codex／Claude 會讀取同一份授權。`);
  };

  return { repairPreview, previewRepair, library, plugins, workflowProfile, loading, pluginLoading, pluginBusy, importingId, previewingId, importState, retryFailedImports, importDesktopMedia, importDesktopPaths, importCreativeAsset, previewCreativeAsset, resolveCreativeAssetPreview, invokePluginTool, openPluginFolder, refreshPlugins, updateWorkflowProfile };
}
