use hao_core::engine::auto_roto::{AutoRotoRequest,run_auto_roto};
use hao_core::engine::auto_roto::streaming::run_guarded_coarse_streaming;
use hao_core::engine::region_memory_roto::{RegionMemorySeedRect,RegionMemorySettings,segment_region_memory_sequence_with_postprocess};
use hao_core::engine::region_memory_roto::streaming::{segment_region_memory_streaming,RegionMemoryStreamError};
use hao_core::engine::roto::MatteFrame;
use serde_json::{json,Value};
use std::fs;
use std::path::{Path,PathBuf};
use std::time::{SystemTime,UNIX_EPOCH};

fn rgb_fixture(width:usize,height:usize,count:usize)->Vec<u8>{
    let mut bytes=Vec::with_capacity(width*height*count*3);
    for frame in 0..count {
        let bg=if frame>=6 {[150,170,165]} else {[25,30,36]};
        let mut rgb=Vec::with_capacity(width*height*3);
        for y in 0..height {for x in 0..width {
            let left=width/4+frame%5;
            let mut p=bg;
            if frame!=4 && x>=left && x<left+width/3 && y>=height/4 && y<height*3/4 {
                p=[220-frame as u8,55+frame as u8,44];
            }
            rgb.extend_from_slice(&p);
        }}
        bytes.extend(rgb);
    }
    bytes
}
fn rect()->RegionMemorySeedRect {RegionMemorySeedRect{x:0.24,y:0.24,width:0.4,height:0.53}}
fn correction(m:&mut MatteFrame){
    if m.frame==2 || m.frame==7 {for y in 12..16 {for x in 20..24 {m.alpha[y*m.width as usize+x]=0;}}}
}

#[test]
fn streaming_matches_all_mattes_receipts_and_refinements_for_both_directions(){
    let (width,height,count)=(64,40,10);let bytes=rgb_fixture(width,height,count);let fb=width*height*3;
    for seed in [0,3,9] {
        let expected=segment_region_memory_sequence_with_postprocess(&bytes,width,height,count,seed,rect(),RegionMemorySettings::default(),correction).unwrap();
        let mut mattes:Vec<Option<MatteFrame>>=vec![None;count];let mut refinements=vec![None;count];let mut order=Vec::new();
        let receipt=segment_region_memory_streaming(width,height,count,seed,rect(),RegionMemorySettings::default(),
            |frame,rgb| {order.push(frame);rgb.copy_from_slice(&bytes[frame*fb..(frame+1)*fb]);Ok(())},
            |matte,refinement| {mattes[matte.frame as usize]=Some(matte.clone());refinements[matte.frame as usize]=Some(refinement);Ok(())},correction).unwrap();
        assert_eq!(serde_json::to_vec(&receipt).unwrap(),serde_json::to_vec(&expected.receipt).unwrap());
        for frame in 0..count {
            assert_eq!(serde_json::to_vec(mattes[frame].as_ref().unwrap()).unwrap(),serde_json::to_vec(&expected.mattes[frame]).unwrap());
            assert_eq!(serde_json::to_vec(refinements[frame].as_ref().unwrap()).unwrap(),serde_json::to_vec(&expected.refinements[frame]).unwrap());
        }
        let wanted=std::iter::once(seed).chain(seed+1..count).chain((0..seed).rev()).collect::<Vec<_>>();
        assert_eq!(order,wanted);assert!(receipt.scene_cut_reseeds>0);
    }
}

#[test]
fn frame_io_and_sink_failure_remain_distinct_from_algorithm_failure(){
    let bytes=rgb_fixture(64,40,10);let fb=64*40*3;
    let reader=segment_region_memory_streaming(64,40,10,0,rect(),RegionMemorySettings::default(),
        |frame,rgb| {if frame==3 {return Err("decoder truncated".into())};rgb.copy_from_slice(&bytes[frame*fb..(frame+1)*fb]);Ok(())},|_,_|Ok(()),|_|{}).unwrap_err();
    assert_eq!(reader,RegionMemoryStreamError::Read("decoder truncated".into()));
    let sink=segment_region_memory_streaming(64,40,10,0,rect(),RegionMemorySettings::default(),
        |frame,rgb|{rgb.copy_from_slice(&bytes[frame*fb..(frame+1)*fb]);Ok(())},
        |m,_|if m.frame==3 {Err("disk reserve lost".into())}else{Ok(())},|_|{}).unwrap_err();
    assert_eq!(sink,RegionMemoryStreamError::Emit("disk reserve lost".into()));
    let algorithm=segment_region_memory_streaming(64,40,10,0,RegionMemorySeedRect{width:0.001,..rect()},RegionMemorySettings::default(),
        |_,_|panic!("must not read an invalid seed"),|_,_|panic!("must not emit"),|_|{}).unwrap_err();
    assert!(matches!(algorithm,RegionMemoryStreamError::Algorithm(_)));
}

#[test]
fn invalid_layout_is_refused_before_allocating_or_calling_io(){
    for (width,height,count,seed) in [(usize::MAX,40,10,0),(64,40,36_001,0),(64,40,10,10),(8192,8192,10,0),(64,40,0,0)] {
        assert!(segment_region_memory_streaming(width,height,count,seed,rect(),RegionMemorySettings::default(),
            |_,_|panic!("invalid layout read"),|_,_|panic!("invalid layout emit"),|_|{}).is_err());
    }
}

struct Case(PathBuf);
impl Case {
    fn new()->Self {let p=std::env::temp_dir().join(format!("editkin-coarse-stream-{}-{}",std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));fs::create_dir(&p).unwrap();Self(p)}
    fn request(&self,name:&str,count:usize,seed:usize)->Value {json!({"rawPath":self.0.join("frames.rgb24"),"outputDir":self.0.join(name),"width":64,"height":40,"frameCount":count,"analysisFps":4,"initialFrame":seed,"initialRect":{"x":0.24,"y":0.24,"width":0.4,"height":0.53},"temporalStability":0.16,"feather":0.01,"edgeShift":0,"contrast":1.7,"corrections":[{"id":"bg","frame":2,"mode":"background","radius":0.1,"points":[{"x":0.4,"y":0.5}]}],"regionMemoryPolicy":"guarded_experimental"})}
}
impl Drop for Case {fn drop(&mut self){fs::remove_dir_all(&self.0).unwrap();}}
fn normalized(value:&Value,root:&Path)->String {serde_json::to_string(value).unwrap().replace(&root.to_string_lossy().replace('\\',"\\\\"),"ROOT")}

#[test]
fn streamed_coarse_png_alpha_and_complete_receipt_are_bit_exact(){
    let case=Case::new();fs::write(case.0.join("frames.rgb24"),rgb_fixture(64,40,10)).unwrap();
    for seed in [0,3,9] {
        let old_name=format!("old-{seed}");let new_name=format!("new-{seed}");
        let old=run_auto_roto(serde_json::from_value(case.request(&old_name,10,seed)).unwrap()).unwrap();
        let new=run_guarded_coarse_streaming(serde_json::from_value(case.request(&new_name,10,seed)).unwrap()).unwrap();
        assert_eq!(fs::read(&old.sequence_path).unwrap(),fs::read(&new.sequence_path).unwrap());
        for frame in 0..10 {assert_eq!(fs::read(case.0.join(&old_name).join(format!("frame-{frame:06}.png"))).unwrap(),fs::read(case.0.join(&new_name).join(format!("frame-{frame:06}.png"))).unwrap());}
        assert_eq!(normalized(&serde_json::to_value(&old).unwrap(),&case.0.join(&old_name)),normalized(&serde_json::to_value(&new).unwrap(),&case.0.join(&new_name)));
    }
}

#[test]
fn coarse_admission_is_exclusive_and_has_no_partial_manifest_on_bad_input(){
    let case=Case::new();fs::write(case.0.join("frames.rgb24"),rgb_fixture(64,40,10)).unwrap();
    for patch in [json!({"frameCount":11}),json!({"regionMemoryPolicy":"fixed_baseline"}),json!({"width":usize::MAX}),json!({"analysisFps":0})] {
        let mut v=case.request("rejected",10,0);for(k,x)in patch.as_object().unwrap(){v[k]=x.clone();}
        assert!(run_guarded_coarse_streaming(serde_json::from_value(v).unwrap()).is_err());assert!(!case.0.join("rejected").exists());
    }
    fs::create_dir(case.0.join("existing")).unwrap();fs::write(case.0.join("existing/keep"),b"keep").unwrap();
    assert!(run_guarded_coarse_streaming(serde_json::from_value(case.request("existing",10,0)).unwrap()).is_err());
    assert_eq!(fs::read(case.0.join("existing/keep")).unwrap(),b"keep");
}

/// Run only by the bounded memory measurement script, in a fresh measured process.
/// Normal regression invocation is an inert pass; it does not duplicate the benchmark.
#[test]
fn memory_worker(){
    let Ok(path)=std::env::var("EDITKIN_ROTO_STREAM_WORKER_REQUEST") else {return};
    let request:AutoRotoRequest=serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    let result=if std::env::var("EDITKIN_ROTO_STREAM_WORKER_MODE").unwrap()=="streaming" {run_guarded_coarse_streaming(request)}else{run_auto_roto(request)}.unwrap();
    assert_eq!(result.frames.len(),360);assert_eq!(result.region_memory_routing.executed,"guarded_experimental");
}
