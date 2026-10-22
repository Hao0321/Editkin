//! Load receipts for explicit zero-video programs retain real null primary fields, never a phantom decoder.
use anyhow::{Context, Result, bail};
use serde_json::Value;

pub struct PrimaryFieldsV1 {
    pub decoder: Value,
    pub visual_graph: Value,
    pub initial_frame: Value,
}

pub fn primary_fields(
    receipts: &[Value],
    program_video_count: Option<usize>,
) -> Result<PrimaryFieldsV1> {
    if program_video_count.is_some_and(|count| count != receipts.len()) {
        bail!("UNIFIED_NATIVE_LOAD_VIDEO_COUNT_MISMATCH");
    }
    if let Some(first) = receipts.first() {
        return Ok(PrimaryFieldsV1 {
            decoder: first["decoder"].clone(),
            visual_graph: first["visualGraph"].clone(),
            initial_frame: first["initialFrame"].clone(),
        });
    }
    if program_video_count != Some(0) {
        bail!("common video graph produced no resident layers");
    }
    Ok(PrimaryFieldsV1 {
        decoder: Value::Null,
        visual_graph: Value::Null,
        initial_frame: Value::Null,
    })
}

pub fn finalize_load_receipt(
    mut receipt: Value,
    program_video_count: Option<usize>,
) -> Result<Value> {
    let object = receipt
        .as_object_mut()
        .context("UNIFIED_NATIVE_LOAD_RECEIPT_INVALID")?;
    let count = object
        .get("layerCount")
        .and_then(Value::as_u64)
        .context("UNIFIED_NATIVE_LOAD_VIDEO_COUNT_MISMATCH")?;
    if program_video_count.is_some_and(|expected| count != expected as u64) {
        bail!("UNIFIED_NATIVE_LOAD_VIDEO_COUNT_MISMATCH");
    }
    if count > 0 {
        if object.contains_key("videoAbsent") {
            bail!("UNIFIED_NATIVE_LOAD_VIDEO_STATE_INVALID");
        }
        return Ok(receipt);
    }
    if program_video_count != Some(0)
        || object.get("compositeMode").and_then(Value::as_str) != Some("unified-layer-order/v1")
    {
        bail!("UNIFIED_NATIVE_LOAD_VIDEO_STATE_INVALID");
    }
    for key in ["decoder", "visualGraph", "initialFrame"] {
        if object.get(key) != Some(&Value::Null) {
            bail!("UNIFIED_NATIVE_LOAD_PHANTOM_VIDEO");
        }
    }
    for key in ["layers", "visualLayers", "controllers"] {
        if !object
            .get(key)
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
        {
            bail!("UNIFIED_NATIVE_LOAD_PHANTOM_VIDEO");
        }
    }
    for key in [
        "matteCount",
        "precompositionCount",
        "parentCount",
        "controllerCount",
        "particleCount",
    ] {
        if object.get(key).and_then(Value::as_u64) != Some(0) {
            bail!("UNIFIED_NATIVE_LOAD_PHANTOM_VIDEO");
        }
    }
    if object
        .get("resourcePlan")
        .and_then(|plan| plan.get("videoLayerCount"))
        .and_then(Value::as_u64)
        != Some(0)
    {
        bail!("UNIFIED_NATIVE_LOAD_VIDEO_COUNT_MISMATCH");
    }
    for key in [
        "frame",
        "uniform",
        "sourceNodeId",
        "sourceFrame",
        "sourceTimeSeconds",
    ] {
        if object.contains_key(key) {
            bail!("UNIFIED_NATIVE_LOAD_PHANTOM_VIDEO");
        }
    }
    object.insert("videoAbsent".to_owned(), Value::Bool(true));
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn empty() -> Value {
        serde_json::json!({"layerCount":0,"compositeMode":"unified-layer-order/v1","decoder":null,"visualGraph":null,"initialFrame":null,
            "layers":[],"visualLayers":[],"controllers":[],"matteCount":0,"precompositionCount":0,"parentCount":0,"controllerCount":0,"particleCount":0,
            "resourcePlan":{"videoLayerCount":0}})
    }
    #[test]
    fn explicit_zero_source_load_has_only_truthful_null_primary_fields() {
        let primary = primary_fields(&[], Some(0)).unwrap();
        assert_eq!(primary.decoder, Value::Null);
        assert_eq!(primary.visual_graph, Value::Null);
        assert_eq!(primary.initial_frame, Value::Null);
        let value = finalize_load_receipt(empty(), Some(0)).unwrap();
        assert_eq!(value["videoAbsent"], true);
        assert_eq!(value["layers"], serde_json::json!([]));
    }
    #[test]
    fn legacy_empty_and_mismatching_declared_sources_still_refuse() {
        assert!(primary_fields(&[], None).is_err());
        assert!(primary_fields(&[], Some(1)).is_err());
        assert!(primary_fields(&[serde_json::json!({})], Some(0)).is_err());
        assert!(finalize_load_receipt(empty(), None).is_err());
        assert!(finalize_load_receipt(empty(), Some(1)).is_err());
    }
    #[test]
    fn legacy_and_explicit_positive_video_fields_and_receipts_are_unchanged() {
        let first = serde_json::json!({"decoder":{"resident":true},"visualGraph":{"schema":"original"},"initialFrame":{"active":false,"timelineFrame":0}});
        for count in [None, Some(1)] {
            let primary = primary_fields(std::slice::from_ref(&first), count).unwrap();
            assert_eq!(primary.decoder, first["decoder"]);
            assert_eq!(primary.visual_graph, first["visualGraph"]);
            assert_eq!(primary.initial_frame, first["initialFrame"]);
            let original =
                serde_json::json!({"layerCount":1,"decoder":first["decoder"],"layers":[first]});
            assert_eq!(
                finalize_load_receipt(original.clone(), count).unwrap(),
                original
            );
        }
    }
    #[test]
    fn absent_load_never_accepts_missing_or_fake_primary_video_metadata() {
        for key in ["decoder", "visualGraph", "initialFrame"] {
            let mut value = empty();
            value.as_object_mut().unwrap().remove(key);
            assert!(finalize_load_receipt(value, Some(0)).is_err());
            let mut value = empty();
            value[key] = serde_json::json!({});
            assert!(finalize_load_receipt(value, Some(0)).is_err());
        }
        for key in [
            "frame",
            "uniform",
            "sourceNodeId",
            "sourceFrame",
            "sourceTimeSeconds",
        ] {
            let mut value = empty();
            value[key] = Value::Null;
            assert!(finalize_load_receipt(value, Some(0)).is_err());
        }
        for key in ["layers", "visualLayers", "controllers"] {
            let mut value = empty();
            value[key] = serde_json::json!([{}]);
            assert!(finalize_load_receipt(value, Some(0)).is_err());
        }
    }
}
