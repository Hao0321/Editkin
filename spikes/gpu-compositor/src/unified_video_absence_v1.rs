//! No active decoded video is an explicit frame state, never a fabricated decoder receipt.
use anyhow::{Result, bail};
use serde_json::Value;

pub fn finalize(
    mut receipt: Value,
    unified: bool,
    active_video_count: usize,
    active_steps: Option<usize>,
) -> Result<Value> {
    if !unified || active_video_count > 0 {
        return Ok(receipt);
    }
    let steps =
        active_steps.ok_or_else(|| anyhow::anyhow!("UNIFIED_NATIVE_ABSENCE_PROGRAM_MISSING"))?;
    if steps > 18 {
        bail!("UNIFIED_NATIVE_ABSENCE_PROGRAM_CAPACITY");
    }
    let row = receipt
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("UNIFIED_NATIVE_ABSENCE_RECEIPT_INVALID"))?;
    for key in ["layers", "layerFrames", "visualLayers"] {
        if !row
            .get(key)
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
        {
            bail!("UNIFIED_NATIVE_ABSENCE_VIDEO_ARRAY_NONEMPTY:{key}");
        }
    }
    for key in ["frame", "visualGraph", "sourceFrame", "sourceTimeSeconds"] {
        if !row.get(key).is_some_and(Value::is_null) {
            bail!("UNIFIED_NATIVE_ABSENCE_PRIMARY_VIDEO_PRESENT:{key}");
        }
    }
    row.remove("frame");
    row.remove("visualGraph");
    row.insert("videoAbsent".into(), Value::Bool(true));
    row.insert("active".into(), Value::Bool(steps > 0));
    if row.contains_key("nativeSurfaceCleared") {
        row.insert("nativeSurfaceCleared".into(), Value::Bool(steps == 0));
    }
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn frame() -> Value {
        serde_json::json!({"active":true,"sourceFrame":null,"sourceTimeSeconds":null,"frame":null,"visualGraph":null,
            "layers":[],"layerFrames":[],"visualLayers":[],"nativeSurfaceCleared":false,"untouched":{"steps":["caption","adjustment"]}})
    }
    #[test]
    fn typography_or_adjustment_is_an_active_picture_without_an_invented_video() {
        let receipt = finalize(frame(), true, 0, Some(3)).unwrap();
        assert_eq!(receipt["videoAbsent"], true);
        assert_eq!(receipt["active"], true);
        assert_eq!(receipt["nativeSurfaceCleared"], false);
        assert!(receipt.get("frame").is_none() && receipt.get("visualGraph").is_none());
        assert_eq!(receipt["untouched"], frame()["untouched"]);
    }
    #[test]
    fn an_empty_program_clears_without_decoding_and_verification_has_no_surface_field() {
        let receipt = finalize(frame(), true, 0, Some(0)).unwrap();
        assert_eq!(receipt["active"], false);
        assert_eq!(receipt["nativeSurfaceCleared"], true);
        let mut offscreen = frame();
        offscreen
            .as_object_mut()
            .unwrap()
            .remove("nativeSurfaceCleared");
        let receipt = finalize(offscreen, true, 0, Some(0)).unwrap();
        assert!(receipt.get("nativeSurfaceCleared").is_none());
    }
    #[test]
    fn existing_video_and_legacy_receipts_are_exactly_unchanged() {
        let before = serde_json::json!({"arbitrary":"unchanged","frame":{"source":"original"}});
        assert_eq!(finalize(before.clone(), true, 1, Some(2)).unwrap(), before);
        assert_eq!(finalize(before.clone(), false, 0, None).unwrap(), before);
    }
    #[test]
    fn primary_video_staging_arrays_and_missing_program_cannot_be_erased() {
        for key in ["frame", "visualGraph", "sourceFrame", "sourceTimeSeconds"] {
            let mut receipt = frame();
            receipt[key] = serde_json::json!(1);
            assert!(finalize(receipt, true, 0, Some(1)).is_err());
        }
        for key in ["layers", "layerFrames", "visualLayers"] {
            let mut receipt = frame();
            receipt[key] = serde_json::json!([{"fake":"video"}]);
            assert!(finalize(receipt, true, 0, Some(1)).is_err());
        }
        assert!(finalize(frame(), true, 0, None).is_err());
        assert!(finalize(frame(), true, 0, Some(19)).is_err());
    }
}
