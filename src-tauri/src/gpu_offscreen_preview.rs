//! Fixed-frame whole-composition transport. Only generated PNG slots enter this
//! module; callers never supply an output path and bytes outlive slot reuse.
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::Path};
const MAX_PNG_BYTES: u64 = 40 * 1024 * 1024;
const MAX_PIXELS: u64 = 8_294_400;
fn error() -> String { "Offscreen PNG preview receipt/identity mismatch".into() }
pub fn graph_size(graph: &Value) -> Result<(u64,u64),String> {
    let w=graph.get("width").and_then(Value::as_u64).ok_or_else(error)?;
    let h=graph.get("height").and_then(Value::as_u64).ok_or_else(error)?;
    if w<2 || h<2 || w>8192 || h>8192 || w.checked_mul(h).is_none_or(|n| n>MAX_PIXELS)
        || graph.pointer("/output/colorSpace").and_then(Value::as_str).is_some_and(|v| v!="rec709_sdr") { return Err(error()); }
    Ok((w,h))
}
pub fn validate_ready(ready:&Value, sha:&str, bytes:u64)->Result<(),String> {
    if ready.get("offscreenVideoProtocol").and_then(Value::as_str)!=Some("editkin.resident-offscreen-video-target/v1")
        || ready.pointer("/nativeRuntimeMetadata/executableSha256").and_then(Value::as_str)!=Some(sha)
        || ready.pointer("/nativeRuntimeMetadata/executableBytes").and_then(Value::as_u64)!=Some(bytes) { return Err(error()); }
    Ok(())
}
pub fn validate_release(value:&Value, session:&str)->Result<(),String> {
    if value.get("sessionId").and_then(Value::as_str)!=Some(session)
        || value.get("released").and_then(Value::as_bool).is_none()
        || value.pointer("/fences/pendingFenceCount").and_then(Value::as_u64)!=Some(0) { return Err(error()); }
    Ok(())
}
pub fn validate_identity(value:&Value, generation:u64,w:u64,h:u64)->Result<(),String> {
    if value.get("schema").and_then(Value::as_str)!=Some("editkin.actual-video-target-identity/v1")
        || generation==0 || value.get("generation").and_then(Value::as_u64)!=Some(generation)
        || value.get("backend").and_then(Value::as_str)!=Some("Dx12")
        || value.pointer("/target/renderTargetContract").and_then(Value::as_str)!=Some("editkin.resident-offscreen-render-target/v1")
        || value.pointer("/target/offscreen").and_then(Value::as_bool)!=Some(true)
        || value.pointer("/target/nativeWindow").and_then(Value::as_bool)!=Some(false)
        || value.pointer("/target/nativeSwapChain").and_then(Value::as_bool)!=Some(false)
        || value.pointer("/target/width").and_then(Value::as_u64)!=Some(w)
        || value.pointer("/target/height").and_then(Value::as_u64)!=Some(h) { return Err(error()); }
    Ok(())
}
pub fn validate_target(value:&Value,generation:u64,w:u64,h:u64,sha:&str,bytes:u64)->Result<(),String> {
    let identity=value.get("videoTargetIdentity").ok_or_else(error)?;
    validate_identity(identity,generation,w,h)?;
    if identity.get("executableSha256").and_then(Value::as_str)!=Some(sha)
        || identity.get("executableBytes").and_then(Value::as_u64)!=Some(bytes)
        || value.get("nativeWindow").and_then(Value::as_bool)!=Some(false)
        || value.get("nativeSwapChain").and_then(Value::as_bool)!=Some(false)
        || value.get("offscreen").and_then(Value::as_bool)!=Some(true) { return Err(error()); }
    Ok(())
}
pub fn validate_frame(value:&Value,session:&str,frame:u64)->Result<(u64,u64),String> {
    let target=value.get("renderTarget").ok_or_else(error)?;
    let w=target.get("width").and_then(Value::as_u64).ok_or_else(error)?;
    let h=target.get("height").and_then(Value::as_u64).ok_or_else(error)?;
    graph_size(&serde_json::json!({"width":w,"height":h}))?;
    let generation=value.get("generation").and_then(Value::as_u64).ok_or_else(error)?;
    validate_identity(value.get("videoTargetIdentity").ok_or_else(error)?,generation,w,h)?;
    if value.get("sessionId").and_then(Value::as_str)!=Some(session)
        || value.get("timelineFrame").and_then(Value::as_u64)!=Some(frame)
        || value.get("active").and_then(Value::as_bool)!=Some(true)
        || value.get("endOfStream").and_then(Value::as_bool)!=Some(false)
        || value.get("offscreen").and_then(Value::as_bool)!=Some(true)
        || value.get("nativeSurfacePresented").and_then(Value::as_bool)!=Some(false)
        || value.get("outputReadbackCopies").and_then(Value::as_u64)!=Some(1)
        || value.get("outputWritten").and_then(Value::as_bool)!=Some(true)
        || value.get("verificationReadback").and_then(Value::as_bool)!=Some(true)
        || value.get("outputSpace").and_then(Value::as_str)!=Some("rec709_sdr") { return Err(error()); }
    Ok((w,h))
}
pub fn read_png(path:&Path,w:u64,h:u64)->Result<(Vec<u8>,String),String> {
    let meta=fs::symlink_metadata(path).map_err(|e|e.to_string())?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len()<33 || meta.len()>MAX_PNG_BYTES { return Err(error()); }
    let mut file=fs::File::open(path).map_err(|e|e.to_string())?;
    let mut bytes=Vec::new();
    file.by_ref().take(MAX_PNG_BYTES+1).read_to_end(&mut bytes).map_err(|e|e.to_string())?;
    if bytes.len() as u64!=meta.len() || !bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || &bytes[12..16]!=b"IHDR" || u32::from_be_bytes(bytes[16..20].try_into().map_err(|_|error())?) as u64!=w
        || u32::from_be_bytes(bytes[20..24].try_into().map_err(|_|error())?) as u64!=h { return Err(error()); }
    let sha=format!("{:x}",Sha256::digest(&bytes));
    Ok((bytes,sha))
}
