//! Independent constant-size floating/v2 evaluator. Flat material, never depth or proof.
use serde::{Deserialize, Deserializer, Serialize};
use super::model::{NodeFrameRange, RationalTimebase};
pub const FLOATING_FRAME_SCHEMA: &str = "editkin.native-floating-video-frame/v1";
pub const MAX_FLOATING_DURATION_FRAMES: u64 = 36_000;
pub const MAX_FLOATING_NODES: usize = 8;
const JS_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(d: D) -> Result<Option<T>, D::Error> { T::deserialize(d).map(Some) }
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FloatingFrameStyle { Matte, Prism, Graphite }
impl FloatingFrameStyle { pub fn style_code(self) -> u32 { match self { Self::Matte => 0, Self::Prism => 1, Self::Graphite => 2 } } }
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FloatingFrameAspect { Source, Canvas, Portrait }
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FloatingFrameOrbit { pub amplitude_degrees: f64, pub period_seconds: f64 }
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FloatingFrameMotion { pub entrance_frames: u32, pub exit_frames: u32, pub travel_y: f64 }
impl Default for FloatingFrameMotion { fn default() -> Self { Self { entrance_frames: 6, exit_frames: 6, travel_y: 0.012 } } }
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FloatingFrameV2 {
    pub schema: String, pub style: FloatingFrameStyle, pub aspect: FloatingFrameAspect, pub media_fit: String,
    pub size: f64, pub yaw_degrees: f64, pub pitch_degrees: f64,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub center_x: Option<f64>,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub center_y: Option<f64>,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub orbit: Option<FloatingFrameOrbit>,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub motion: Option<FloatingFrameMotion>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FloatingFrameSource {
    pub width: u32, pub height: u32,
    #[serde(default, deserialize_with = "present", skip_serializing_if = "Option::is_none")]
    pub display_aspect_ratio: Option<f64>,
}
fn strict_timeline<'de, D: Deserializer<'de>>(d: D) -> Result<NodeFrameRange, D::Error> {
    #[derive(Deserialize)] #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Strict { timeline_start_frame: u64, source_start_frame: u64, duration_frames: u64 }
    let s = Strict::deserialize(d)?;
    Ok(NodeFrameRange { timeline_start_frame: s.timeline_start_frame, source_start_frame: s.source_start_frame, duration_frames: s.duration_frames })
}
fn strict_timebase<'de, D: Deserializer<'de>>(d: D) -> Result<RationalTimebase, D::Error> {
    #[derive(Deserialize)] #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Strict { numerator: u32, denominator: u32 }
    let s = Strict::deserialize(d)?; Ok(RationalTimebase { numerator: s.numerator, denominator: s.denominator })
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FloatingVideoFrameSpec {
    pub schema: String, pub frame: FloatingFrameV2, pub source: FloatingFrameSource,
    #[serde(deserialize_with = "strict_timeline")]
    pub timeline: NodeFrameRange,
    pub canvas_width: u32, pub canvas_height: u32,
    #[serde(deserialize_with = "strict_timebase")]
    pub timebase: RationalTimebase,
}
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FloatingVideoFrameSample {
    pub outer_rect: [f32; 4], pub content_rect: [f32; 4],
    /// Full-canvas normalized corners TL/TR/BL/BR.
    pub quad: [[f64; 2]; 4], pub opacity: f32, pub radius: f32, pub feather: f32, pub border: f32,
    pub shadow: [f32; 4],
    /// Authored sRGB decoration. Compositor performs its EOTF exactly once.
    pub panel_color: [f32; 3],
}
#[derive(Clone, Copy)]
struct Geometry { outer: [f64; 4], content: [f64; 4], fit: [f64; 4], border: f64, radius: f64, feather: f64, shadow: [f64; 4] }
fn error(message: &str) -> String { format!("floating video frame: {message}") }
fn bounded(value: f64, min: f64, max: f64) -> bool { value.is_finite() && value >= min && value <= max }
fn even(value: f64) -> f64 { 2.0_f64.max((value / 2.0 + 0.5).floor() * 2.0) }
fn contain(width: f64, height: f64, aspect: f64) -> Result<[f64; 2], String> {
    let w = width.min(height * aspect); let h = height.min(width / aspect);
    if !w.is_finite() || !h.is_finite() || w < 2.0 || h < 2.0 { return Err(error("source cannot form a complete 2px plane")); }
    Ok([(w / 2.0).floor() * 2.0, (h / 2.0).floor() * 2.0])
}
fn smoothstep(value: f64) -> f64 { let p = value.clamp(0.0, 1.0); p * p * (3.0 - 2.0 * p) }
impl FloatingVideoFrameSpec {
    pub fn validate(&self) -> Result<(), String> {
        let f = &self.frame; let motion = f.motion.unwrap_or_default();
        if self.schema != FLOATING_FRAME_SCHEMA || f.schema != "editkin.floating-video-frame/v2" || f.media_fit != "contain" { return Err(error("unsupported explicit schema or media fit")); }
        if !(64..=8192).contains(&self.canvas_width) || !(64..=8192).contains(&self.canvas_height)
            || u64::from(self.canvas_width) * u64::from(self.canvas_height) > 8_294_400
            || !(2..=16384).contains(&self.source.width) || !(2..=16384).contains(&self.source.height) { return Err(error("invalid bounded coded source or canvas dimensions")); }
        if !bounded(f.size,0.3,0.82) || !bounded(f.yaw_degrees,-35.0,35.0) || !bounded(f.pitch_degrees,-25.0,25.0)
            || !bounded(f.center_x.unwrap_or(0.5),0.2,0.8) || !bounded(f.center_y.unwrap_or(0.5),0.2,0.8)
            || motion.entrance_frames > 24 || motion.exit_frames > 24 || !bounded(motion.travel_y,0.0,0.03) { return Err(error("invalid bounded perspective or motion")); }
        if let Some(orbit) = f.orbit { if !bounded(orbit.amplitude_degrees,0.0,30.0) || !bounded(orbit.period_seconds,2.0,8.0) { return Err(error("invalid bounded orbit")); } }
        let r = &self.timeline;
        if r.duration_frames == 0 || r.duration_frames > MAX_FLOATING_DURATION_FRAMES
            || r.timeline_start_frame > JS_SAFE_INTEGER || r.source_start_frame > JS_SAFE_INTEGER
            || r.timeline_start_frame.checked_add(r.duration_frames).is_none_or(|n|n > JS_SAFE_INTEGER)
            || r.source_start_frame.checked_add(r.duration_frames).is_none_or(|n|n > JS_SAFE_INTEGER)
            || u64::from(motion.entrance_frames)+u64::from(motion.exit_frames) > r.duration_frames-1 { return Err(error("invalid integer source timeline or overlapping phases")); }
        if self.timebase.numerator == 0 || self.timebase.denominator == 0 || self.timebase.denominator > 1_000_000 { return Err(error("invalid rational clock")); }
        let fps = f64::from(self.timebase.denominator)/f64::from(self.timebase.numerator);
        if !fps.is_finite() || fps <= 0.0 || fps > 240.0 { return Err(error("invalid project fps")); }
        self.validate_projection_envelope(self.geometry(self.source_aspect()?)?)?; Ok(())
    }
    fn source_aspect(&self) -> Result<f64, String> {
        let aspect = self.source.display_aspect_ratio.unwrap_or(f64::from(self.source.width)/f64::from(self.source.height));
        if !aspect.is_finite() || aspect <= 0.0 { return Err(error("invalid upright display aspect ratio")); } Ok(aspect)
    }
    fn geometry(&self, aspect: f64) -> Result<Geometry, String> {
        let width=f64::from(self.canvas_width); let height=f64::from(self.canvas_height); let f=&self.frame;
        let border=if f.style==FloatingFrameStyle::Matte {2.0} else {even(width.min(height)*0.014)};
        let pa=match f.aspect { FloatingFrameAspect::Source=>aspect,FloatingFrameAspect::Canvas=>width/height,FloatingFrameAspect::Portrait=>9.0/16.0 };
        let [iw,ih]=contain(width*f.size,height*f.size,pa)?; let ow=iw+2.0*border;let oh=ih+2.0*border;
        if ow+2.0*border>=width || oh+2.0*border>=height {return Err(error("plane exceeds canvas"));}
        let left=((width-ow)/2.0+0.5).floor();let top=((height-oh)/2.0+0.5).floor();
        let radius=if f.style==FloatingFrameStyle::Matte {8.0_f64.max((width.min(height)*0.028+0.5).floor())} else {5.0_f64.max((border*1.6+0.5).floor())};
        let feather=2.0_f64.max((width.min(height)*0.016+0.5).floor());let buffer=(4.0_f64*1.2).ceil();
        let corner=radius-(radius-0.5-buffer).max(0.0)/std::f64::consts::SQRT_2;
        let inset=((feather+buffer).max(corner)-border).ceil().max(0.0);
        let fw=iw-2.0*inset;let fh=ih-2.0*inset;contain(fw,fh,aspect)?;
        let cw=fw.min(fh*aspect);let ch=fh.min(fw/aspect);let fit=[left+border+inset,top+border+inset,fw,fh];
        let content=[fit[0]+(fw-cw)/2.0,fit[1]+(fh-ch)/2.0,cw,ch];let unit=width.min(height)/1080.0;
        let margin=4.0_f64.max((80.0*unit).ceil());
        if f.style==FloatingFrameStyle::Matte && (left<margin || top<margin) {return Err(error("canvas cannot preserve the full soft shadow"));}
        Ok(Geometry{outer:[left,top,ow,oh],content,fit,border,radius,feather,shadow:[4.0*unit,16.0*unit,28.0*unit,0.13]})
    }
    fn validate_projection_envelope(&self,g:Geometry)->Result<(),String>{
        let f=&self.frame;let amplitude=f.orbit.map_or(0.0,|o|o.amplitude_degrees);
        let min=(f.yaw_degrees-amplitude).to_radians();let max=(f.yaw_degrees+amplitude).to_radians();
        let (sp,cp)=f.pitch_degrees.to_radians().sin_cos();let motion=f.motion.unwrap_or_default();
        let min_travel=if motion.exit_frames==0 {0.0}else{-motion.travel_y};let max_travel=if motion.entrance_frames==0 {0.0}else{motion.travel_y};
        let [l,t,w,h]=g.fit;
        for [px,py] in [[l,t],[l+w,t],[l,t+h],[l+w,t+h]]{
            let x=2.0*px/f64::from(self.canvas_width)-1.0;let y=2.0*py/f64::from(self.canvas_height)-1.0;let a=3.4-y*sp;let b=x*cp;
            let ss=-b/a;let stationary=if ss.is_finite()&&ss.abs()<=1.0 {ss.asin()}else{min};
            for yaw in [min,max,stationary.clamp(min,max)]{
                let d=a+b*yaw.sin();if !d.is_finite()||d<=0.0{return Err(error("noninvertible source projection"));}
                let px=f.center_x.unwrap_or(0.5)+3.4*x*yaw.cos()/(2.0*d);
                let py=f.center_y.unwrap_or(0.5)+3.4*(y*cp+x*yaw.sin()*sp)/(2.0*d);
                if !bounded(px,0.0,1.0)||!py.is_finite()||py+min_travel<0.0||py+max_travel>1.0{return Err(error("complete source projection exceeds canvas"));}
            }
        }Ok(())
    }
    pub fn sample(&self,local_frame:i64)->Result<FloatingVideoFrameSample,String>{
        self.validate()?;if local_frame.unsigned_abs()>JS_SAFE_INTEGER{return Err(error("local frame exceeds exact integer clock"));}
        let g=self.geometry(self.source_aspect()?)?;let f=&self.frame;let motion=f.motion.unwrap_or_default();let local=local_frame as f64;
        let entrance=if motion.entrance_frames==0 {1.0}else{smoothstep(local/f64::from(motion.entrance_frames))};
        let exit=if motion.exit_frames==0 {1.0}else{smoothstep((self.timeline.duration_frames as f64-1.0-local)/f64::from(motion.exit_frames))};
        let opacity=if local_frame<0||local_frame as u64>=self.timeline.duration_frames {0.0}else{entrance*exit};let travel=motion.travel_y*(exit-entrance);
        let time=local*f64::from(self.timebase.numerator)/f64::from(self.timebase.denominator);
        let orbit=f.orbit.map_or(0.0,|o|o.amplitude_degrees*(2.0*std::f64::consts::PI*time/o.period_seconds).sin());
        let (sy,cy)=(f.yaw_degrees+orbit).to_radians().sin_cos();let (sp,cp)=f.pitch_degrees.to_radians().sin_cos();
        let quad=[[-1.0,-1.0],[1.0,-1.0],[-1.0,1.0],[1.0,1.0]].map(|[x,y]|{
            let xr=x*cy;let zr=-x*sy;let yr=y*cp-zr*sp;let depth=y*sp+zr*cp;let p=3.4/(3.4-depth);
            [f.center_x.unwrap_or(0.5)+xr*p/2.0,f.center_y.unwrap_or(0.5)+yr*p/2.0+travel]
        });
        if quad.iter().flatten().any(|v|!v.is_finite()){return Err(error("nonfinite sampled homography"));}
        let rgb=match f.style {FloatingFrameStyle::Matte=>[0x12,0x15,0x16],FloatingFrameStyle::Prism=>[0x10,0x1d,0x32],FloatingFrameStyle::Graphite=>[0x16,0x18,0x1d]};
        Ok(FloatingVideoFrameSample{outer_rect:g.outer.map(|v|v as f32),content_rect:g.content.map(|v|v as f32),quad,opacity:opacity as f32,
            radius:g.radius as f32,feather:g.feather as f32,border:g.border as f32,shadow:g.shadow.map(|v|v as f32),panel_color:rgb.map(|v|v as f32/255.0)})
    }
}
#[cfg(test)]
mod tests{
    use super::*;
    fn spec()->FloatingVideoFrameSpec{serde_json::from_value(serde_json::json!({"schema":FLOATING_FRAME_SCHEMA,
        "frame":{"schema":"editkin.floating-video-frame/v2","style":"matte","aspect":"source","mediaFit":"contain","size":0.58,"yawDegrees":0,"pitchDegrees":0},
        "source":{"width":1920,"height":1080,"displayAspectRatio":1.7777777777777777},"timeline":{"timelineStartFrame":30,"sourceStartFrame":7,"durationFrames":150},
        "canvasWidth":1920,"canvasHeight":1080,"timebase":{"numerator":1,"denominator":30}})).unwrap()}
    #[test]fn complete_corners_and_integer_phases(){let s=spec();let held=s.sample(30).unwrap();
        assert_eq!(s.sample(0).unwrap().opacity,0.0);assert_eq!(s.sample(149).unwrap().opacity,0.0);assert_eq!(held.opacity,1.0);
        assert_eq!(held.quad,[[0.0,0.0],[1.0,0.0],[0.0,1.0],[1.0,1.0]]);
        assert!(held.content_rect[0]>held.outer_rect[0]);assert!(held.content_rect[1]>held.outer_rect[1]);
        assert!((f64::from(held.content_rect[2])/f64::from(held.content_rect[3])-16.0/9.0).abs()<0.000001);
        assert_eq!(s.sample(-1).unwrap().opacity,0.0);assert_eq!(s.sample(150).unwrap().opacity,0.0);}
    #[test]fn coded_dimensions_preserve_upright_dar_and_rational_orbit(){let mut s=spec();s.source.display_aspect_ratio=Some(9.0/16.0);
        s.timebase=RationalTimebase{numerator:1001,denominator:30000};s.frame.style=FloatingFrameStyle::Prism;
        s.frame.orbit=Some(FloatingFrameOrbit{amplitude_degrees:24.0,period_seconds:3.6});let a=s.sample(6).unwrap();let b=s.sample(27).unwrap();
        assert_ne!(a.quad,b.quad);assert!((f64::from(a.content_rect[2])/f64::from(a.content_rect[3])-9.0/16.0).abs()<0.000001);}
    #[test]fn unknown_nested_keys_null_and_legacy_are_rejected(){let wire=serde_json::to_value(spec()).unwrap();
        for path in ["frame","source","timeline","timebase",""]{let mut bad=wire.clone();if path.is_empty(){bad["forged"]=true.into();}else{bad[path]["forged"]=true.into();}
            assert!(serde_json::from_value::<FloatingVideoFrameSpec>(bad).is_err());}
        let mut bad=wire;bad["frame"]["centerX"]=serde_json::Value::Null;assert!(serde_json::from_value::<FloatingVideoFrameSpec>(bad).is_err());
        let mut s=spec();s.frame.schema="editkin.floating-video-frame/v1".into();assert!(s.validate().is_err());}
    #[test]fn unsafe_envelope_phase_overlap_and_false_dar_are_rejected(){let mut s=spec();s.frame.size=0.82;s.frame.center_x=Some(0.8);s.frame.yaw_degrees=35.0;
        s.frame.orbit=Some(FloatingFrameOrbit{amplitude_degrees:30.0,period_seconds:2.0});assert!(s.validate().is_err());
        let mut s=spec();s.timeline.duration_frames=12;assert!(s.validate().is_err());let mut s=spec();s.source.display_aspect_ratio=Some(f64::NAN);assert!(s.validate().is_err());
        let mut s=spec();s.frame.motion=Some(FloatingFrameMotion{entrance_frames:0,exit_frames:0,travel_y:0.0});s.timeline.duration_frames=1;assert_eq!(s.sample(0).unwrap().opacity,1.0);}
}
