//! Real H264 decode controls; synthetic texture tests do not prove source handles.
use super::*;
use hao_core::engine::{model::{NodeFrameRange, RationalTimebase},
    timeline_pair_v1::{TimelinePairEndpointV1, TimelineSourceReadV1}};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::os::windows::process::CommandExt;

static FIXTURE_ID: AtomicUsize = AtomicUsize::new(0);

fn fixture() -> Result<(PathBuf, PathBuf, TimelineSourceReadV1)> {
    let ffmpeg = PathBuf::from(std::env::var("EDITKIN_PAIR_MEDIA_FFMPEG")?);
    let output = PathBuf::from(std::env::var("EDITKIN_PAIR_MEDIA_OUTPUT")?);
    if !output.is_absolute() || !ffmpeg.is_absolute() || !ffmpeg.is_file() {
        bail!("paired media control requires explicit absolute owned output and FFmpeg paths");
    }
    let root = output.join(format!("native-pair-media-{}-{}", std::process::id(), FIXTURE_ID.fetch_add(1, Ordering::Relaxed)));
    fs::create_dir_all(&root)?;
    let path = root.join("short-video-long-audio.mp4");
    let mut command = std::process::Command::new(&ffmpeg);
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: fixture generation needs no console window.
    let mut child = command.args([
        "-nostdin", "-hide_banner", "-loglevel", "error", "-n",
        "-f", "lavfi", "-i", "nullsrc=size=64x32:rate=10:duration=0.8,geq=lum='16+N*24':cb=128:cr=128",
        "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2",
        "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-profile:v", "high", "-crf", "18",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-color_primaries", "bt709",
        "-color_trc", "bt709", "-colorspace", "bt709",
    ]).arg(&path).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn()?;
    let started = Instant::now();
    while child.try_wait()?.is_none() {
        if started.elapsed() > Duration::from_secs(30) {
            let _ = child.kill(); let _ = child.wait();
            bail!("owned paired media fixture generation timed out");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let result = child.wait_with_output()?;
    fs::write(root.join("fixture-stdout.log"), &result.stdout)?;
    fs::write(root.join("fixture-stderr.log"), &result.stderr)?;
    if !result.status.success() { bail!("owned paired fixture generation failed: {}", result.status); }
    // The authored asset declares two seconds, just like the longer container.
    // Its incoming clip has real pre-roll at .2 and post-roll at .7, but no .9 frame.
    let endpoint = TimelinePairEndpointV1 { branch_node_id:"transform:incoming".into(),
        source_node_id:"source:incoming".into(), asset_id:"incoming".into(), media_kind:"video".into(),
        nominal:NodeFrameRange {timeline_start_frame:4,source_start_frame:4,duration_frames:2},
        source_start_seconds:0.4,asset_duration_seconds:2.0 };
    let read = TimelineSourceReadV1::new(&endpoint,2,10,&RationalTimebase {numerator:1,denominator:10}).map_err(anyhow::Error::msg)?;
    Ok((path,root,read))
}

fn clock(read:&TimelineSourceReadV1, frame:f64)->f64 {
    read.source_seconds(frame).unwrap().unwrap()
}

#[test]
fn timeline_pair_direct_decodes_real_pre_post_roll_and_refuses_current_video_eof() -> Result<()> {
    let (path,root,read)=fixture()?; let engine=GpuCompositor::new_dx12_video()?;
    let mut session=VideoInteropSession::open_with_ring_size(&engine,&path,3)?;
    session.require_timeline_pair_frames=true;
    let pre=session.stage_at(&engine,clock(&read,2.0),0.01)?.context("real pre-roll missing")?;
    let pre_slot=pre["frameRingSlot"].as_u64().context("pre-roll slot missing")? as usize;
    let (_,pre_pixels)=consume_bgra_with_wgpu(&engine,&session.frame_ring[pre_slot].staged_texture,64,32)?;
    let post=session.stage_at(&engine,clock(&read,7.0),0.01)?.context("real post-roll missing")?;
    let post_slot=post["frameRingSlot"].as_u64().context("post-roll slot missing")? as usize;
    let (_,post_pixels)=consume_bgra_with_wgpu(&engine,&session.frame_ring[post_slot].staged_texture,64,32)?;
    assert_ne!(pre_pixels,post_pixels,"native decoder must read different real source frames");
    let repeated=session.stage_at(&engine,clock(&read,2.0),0.01)?.context("reseek pre-roll missing")?;
    let slot=repeated["frameRingSlot"].as_u64().context("reseek slot missing")? as usize;
    let (_,again)=consume_bgra_with_wgpu(&engine,&session.frame_ring[slot].staged_texture,64,32)?;
    assert_eq!(pre_pixels,again,"backward source seek must return the original decoded frame");
    let error=session.stage_at(&engine,clock(&read,9.0),0.01).unwrap_err();
    assert!(error.to_string().contains("ACTUAL_HANDLE_MISSING"));
    let mut legacy=VideoInteropSession::open_with_ring_size(&engine,&path,3)?;
    assert!(!legacy.require_timeline_pair_frames);
    assert!(legacy.stage_at(&engine,clock(&read,9.0),0.01)?.is_none());
    super::super::save_rgba(&root.join("pre.png"),pre_pixels,64,32)?;
    super::super::save_rgba(&root.join("post.png"),post_pixels,64,32)?;
    fs::write(root.join("direct-control.json"),serde_json::to_vec_pretty(&serde_json::json!({
        "pre":pre,"post":post,"reseek":repeated,"missingVideoTail":error.to_string(),
        "declaredAssetDurationSeconds":2,"actualVideoDurationSeconds":0.8,"artStatus":"ART_PENDING_CLAUDE"}))?)?;
    Ok(())
}

#[test]
fn timeline_pair_worker_cache_keeps_original_frame_and_refuses_video_tail_despite_long_audio() -> Result<()> {
    let (path,root,read)=fixture()?; let engine=GpuCompositor::new_dx12_video()?;
    let worker=VideoInteropWorker::open_with_timeline_pair_reads(&engine,&path,3,true)?;
    let stage=|frame:f64|->Result<serde_json::Value>{
        let mut staged=stage_video_workers_at(&engine,&[&worker],&[clock(&read,frame)],&[0.01])?;
        staged.remove(0).context("real paired worker source frame missing")
    };
    let pre=stage(2.0)?; let post=stage(7.0)?; let cached=stage(2.0)?;
    assert_eq!(pre["sourceTimestampSeconds"],cached["sourceTimestampSeconds"]);
    assert_eq!(pre["timestampSeconds"],cached["timestampSeconds"]);
    assert_ne!(pre["sourceTimestampSeconds"],post["sourceTimestampSeconds"]);
    assert_eq!(cached["decoderSourceCacheHit"],true);
    let error=stage(9.0).unwrap_err(); assert!(error.to_string().contains("ACTUAL_HANDLE_MISSING"));
    fs::write(root.join("worker-control.json"),serde_json::to_vec_pretty(&serde_json::json!({
        "pre":pre,"post":post,"cached":cached,"missingVideoTail":error.to_string(),
        "declaredAssetDurationSeconds":2,"actualVideoDurationSeconds":0.8}))?)?;
    Ok(())
}
