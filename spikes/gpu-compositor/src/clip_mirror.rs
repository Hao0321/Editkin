//! Clip reflection uses the existing projective sampling stage, with no shader/ABI change.
use crate::engine_graph::EngineVideoVisualPlan;

pub fn false_value(value: &bool) -> bool { !*value }
pub fn uniform_absolute_axes(x: f32, y: f32) -> bool {
    x.is_finite() && y.is_finite() && x.abs() > 0.0001 && y.abs() > 0.0001 && (x.abs() - y.abs()).abs() <= 0.000001
}
pub fn fixed_axis_signs(x: f32, y: f32, base_x: f32, base_y: f32) -> bool {
    uniform_absolute_axes(x,y) && x.is_sign_negative() == base_x.is_sign_negative() && y.is_sign_negative() == base_y.is_sign_negative()
}
/// Inverse of translate * rotate * scale * reflection, in centered screen pixels.
pub fn inverse_affine(x: f32, y: f32, scale: f32, rotation: f32, mirror_x: bool, mirror_y: bool) -> [f32;8] {
    let (sin,cos)=rotation.sin_cos();
    let sx=if mirror_x {-1.0} else {1.0};let sy=if mirror_y {-1.0} else {1.0};
    let a=sx*cos/scale;let b=sx*sin/scale;let c=-sy*sin/scale;let d=sy*cos/scale;
    [a,b,-a*x-b*y,c,d,-c*x-d*y,0.0,0.0]
}
pub fn compose_parent(parent: &EngineVideoVisualPlan, child: &mut EngineVideoVisualPlan) {
    let cosine=parent.rotation.cos();let sine=parent.rotation.sin();
    let sx=if parent.mirror_x {-1.0} else {1.0};let sy=if parent.mirror_y {-1.0} else {1.0};
    let x=child.translate_x*sx;let y=child.translate_y*sy;
    child.translate_x=parent.translate_x+(x*cosine-y*sine)*parent.scale;
    child.translate_y=parent.translate_y+(x*sine+y*cosine)*parent.scale;
    child.scale*=parent.scale;child.rotation=parent.rotation+sx*sy*child.rotation;child.opacity*=parent.opacity;
    child.mirror_x^=parent.mirror_x;child.mirror_y^=parent.mirror_y;
}
pub fn video_projection(plan: &EngineVideoVisualPlan) -> Option<[f32;8]> {
    (plan.mirror_x||plan.mirror_y).then(||inverse_affine(plan.translate_x,plan.translate_y,plan.scale,plan.rotation,plan.mirror_x,plan.mirror_y))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inverse_matches_independent_reflect_rotate_translate_for_all_axes() {
        for mx in [false,true] {for my in [false,true] {for angle in [-0.7_f32,0.0,0.43] {
            let h=inverse_affine(13.0,-7.0,0.8,angle,mx,my);let (s,c)=angle.sin_cos();
            for (x,y) in [(-40.0,15.0),(12.0,-20.0),(0.0,0.0)] {
                let qx=if mx {-x} else {x};let qy=if my {-y} else {y};
                let dx=13.0+(qx*c-qy*s)*0.8;let dy=-7.0+(qx*s+qy*c)*0.8;
                assert!((h[0]*dx+h[1]*dy+h[2]-x).abs()<0.00002);
                assert!((h[3]*dx+h[4]*dy+h[5]-y).abs()<0.00002);
            }
        }}}
    }
    #[test]
    fn mirrored_parent_composes_translation_and_rotation_without_losing_child_flags() {
        let parent=EngineVideoVisualPlan {translate_x:7.0,translate_y:-4.0,scale:0.8,rotation:0.4,mirror_x:true,..Default::default()};
        let mut child=EngineVideoVisualPlan {translate_x:12.0,translate_y:6.0,scale:0.6,rotation:0.2,mirror_y:true,..Default::default()};
        compose_parent(&parent,&mut child);assert!((child.rotation-0.2).abs()<1e-7);
        assert!(child.mirror_x&&child.mirror_y);assert!((child.scale-0.48).abs()<1e-7);
        let h=video_projection(&child).unwrap();let (s,c)=0.2_f32.sin_cos();
        let px=child.translate_x+(-9.0*c-(-3.0)*s)*child.scale;
        let py=child.translate_y+(-9.0*s+(-3.0)*c)*child.scale;
        assert!((h[0]*px+h[1]*py+h[2]-9.0).abs()<0.00002);
        assert!((h[3]*px+h[4]*py+h[5]-3.0).abs()<0.00002);
    }
    #[test]
    fn old_plans_omit_new_flags_and_keep_the_existing_projection_path() {
        let plan=EngineVideoVisualPlan::default();assert!(video_projection(&plan).is_none());
        let bytes=serde_json::to_string(&plan).unwrap();assert!(!bytes.contains("mirrorX")&&!bytes.contains("mirrorY"));
    }
    #[test]
    fn keyframes_keep_fixed_reflection_signs_and_cannot_cross_zero() {
        assert!(fixed_axis_signs(-0.6,0.6,-1.0,1.0));assert!(fixed_axis_signs(-0.6,-0.6,-1.0,-1.0));
        assert!(!fixed_axis_signs(0.6,0.6,-1.0,1.0));assert!(!uniform_absolute_axes(0.0,0.0));assert!(!uniform_absolute_axes(-0.6,0.7));
    }
    #[test]
    #[ignore = "Explicit physical WGPU fixture; prepare via tools/mirror_physical.mjs and set EDITKIN_CLIP_MIRROR_FIXTURE"]
    fn physical_gpu_pixels_follow_all_authored_axes() -> anyhow::Result<()> {
        use anyhow::{Context,bail};
        use sha2::{Digest,Sha256};
        use std::path::{Path,PathBuf};
        let root=PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.rd/benchmarks/usable-v1-20261009/work/codex-long-2/media/mirror-physical").canonicalize()?;
        let fixture_path=PathBuf::from(std::env::var("EDITKIN_CLIP_MIRROR_FIXTURE").context("fixture is required")?).canonicalize()?;
        assert_eq!(fixture_path,root.join("fixture.json"));
        let fixture:serde_json::Value=serde_json::from_slice(&std::fs::read(&fixture_path)?)?;
        assert_eq!(fixture["schema"],"editkin.clip-mirror-physical/v1");
        let source=Path::new(fixture["source"].as_str().unwrap());assert_eq!(source.canonicalize()?,root.join("source.png"));
        assert_eq!(format!("{:x}",Sha256::digest(std::fs::read(source)?)),fixture["sourceSha256"].as_str().unwrap());
        let cases=fixture["cases"].as_array().unwrap();assert_eq!(cases.len(),4);
        let mut baseline=None;let mut observations=Vec::new();
        for case in cases {
            let id=case["id"].as_str().unwrap();assert!(["control","horizontal","vertical","both"].contains(&id));
            let graph=Path::new(case["graph"].as_str().unwrap());assert!(graph.canonicalize()?.starts_with(&root));
            let output=root.join(format!("native-{id}.png"));if output.exists(){bail!("owned output already exists");}
            crate::engine_render_command(graph,Path::new(fixture["bindings"].as_str().unwrap()),0,&output,"gpu")?;
            let actual=image::open(&output)?.to_rgb8();assert_eq!(actual.dimensions(),(64,48));
            if id=="control" {baseline=Some(actual.clone());continue;}
            let control=baseline.as_ref().unwrap();let mx=case["flipX"].as_bool().unwrap();let my=case["flipY"].as_bool().unwrap();
            let mut worst=0_u8;let mut sum=0_u64;let mut wrong_sum=0_u64;
            for y in 0..48 {for x in 0..64 {
                let expected=control.get_pixel(if mx {63-x} else {x},if my {47-y} else {y});let pixel=actual.get_pixel(x,y);
                for channel in 0..3 {let e=pixel[channel].abs_diff(expected[channel]);worst=worst.max(e);sum+=u64::from(e);wrong_sum+=u64::from(control.get_pixel(x,y)[channel].abs_diff(expected[channel]));}
            }}
            assert!(worst<=2,"{id} actual WGPU channel error {worst}");assert!(wrong_sum>48*64*3*30,"wrong-axis control must be distinguishable");
            observations.push(serde_json::json!({"id":id,"maxChannelError":worst,"mae":sum as f64/(48.0*64.0*3.0),"wrongAxisMae":wrong_sum as f64/(48.0*64.0*3.0),"png":output}));
        }
        let receipt=root.join("NATIVE_MIRROR_PIXELS.json");if receipt.exists(){bail!("owned receipt already exists");}
        std::fs::write(receipt,serde_json::to_vec_pretty(&serde_json::json!({"status":"PASS","sourceSha256":fixture["sourceSha256"],"actualExecutor":"production engine_render_command with WGPU","comparisons":observations,"artStatus":"ART_PENDING_CLAUDE"}))?)?;
        Ok(())
    }
}
