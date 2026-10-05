//! Compares the independent native sampler with the actual TS public factory/layout.
//! Input artifact is produced by the bounded source control, never by this sampler.
use hao_core::engine::floating_video_frame::{FloatingVideoFrameSpec, FloatingVideoFrameSample};
use serde::Deserialize;
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Fixture {schema:String, geometry_pixels:f64, opacity_error:f64,cases:Vec<Case>}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Case {preset:String,aspect:String,spec:FloatingVideoFrameSpec,local_frame:i64,expected:Expected}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Expected {outer_rect:[f64;4],content_rect:[f64;4],quad:[[f64;2];4],opacity:f64,radius:f64,feather:f64,border:f64,shadow:[f64;4]}
#[test]
fn floating_assembly_ts_native_geometry_all_styles_aspects_and_phases() -> anyhow::Result<()> {
    let path=std::env::var("EDITKIN_FLOATING_FIXTURE_OUT")?;
    let fixture:Fixture=serde_json::from_slice(&std::fs::read(path)?)?;
    assert_eq!(fixture.schema,"editkin.native-floating-independent-comparison/v1");
    assert_eq!(fixture.cases.len(),84); assert_eq!(fixture.geometry_pixels,0.002);assert_eq!(fixture.opacity_error,0.000001);
    let mut maximum_error=0.0_f64;
    for case in &fixture.cases {
        let actual:FloatingVideoFrameSample=case.spec.sample(case.local_frame).map_err(anyhow::Error::msg)?;
        for (label,native,ts) in [("outer",actual.outer_rect,case.expected.outer_rect),("content",actual.content_rect,case.expected.content_rect),("shadow",actual.shadow,case.expected.shadow)] {
            for i in 0..4 {let error=(f64::from(native[i])-ts[i]).abs();maximum_error=maximum_error.max(error);
                assert!(error<=fixture.geometry_pixels,"{} {} frame{} {label}[{i}] error{error}",case.preset,case.aspect,case.local_frame);}
        }
        for corner in 0..4 { for axis in 0..2 {
            let size=if axis==0 {case.spec.canvas_width} else {case.spec.canvas_height};
            let error=(actual.quad[corner][axis]-case.expected.quad[corner][axis]).abs()*f64::from(size);
            maximum_error=maximum_error.max(error); assert!(error<=fixture.geometry_pixels,"full canvas corner projection mismatch {error}");
        } }
        for (native,ts) in [(actual.radius,case.expected.radius),(actual.feather,case.expected.feather),(actual.border,case.expected.border)] {
            assert!((f64::from(native)-ts).abs()<=fixture.geometry_pixels); }
        assert!((f64::from(actual.opacity)-case.expected.opacity).abs()<=fixture.opacity_error);
    }
    if let Ok(output)=std::env::var("EDITKIN_FLOATING_TEST_OUTPUT") {
        std::fs::write(std::path::Path::new(&output).join("INDEPENDENT_GEOMETRY_RESULT.json"),serde_json::to_vec_pretty(&serde_json::json!({
            "status":"PASS","cases":fixture.cases.len(),"maxPixelsError":maximum_error,"threshold":fixture.geometry_pixels,
            "comparison":"actual TS factory/shared layout vs independently implemented hao-core Rust sampler"
        }))?)?;
    }
    Ok(())
}
