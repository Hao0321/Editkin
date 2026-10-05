//! Bounded native Motion paint. Shares Editkin's actual premultiplied scene-linear frame.
//! Closed paths only; no text shaping, CSS, font fallback or renderer receipt authority.
use super::composite::{FloatFrame, LinearRgba, srgb_to_linear, linear_to_srgb};
use serde::{Deserialize, Serialize};

pub const MAX_PIXELS: u64 = 8_294_400;
pub const MAX_LAYERS: usize = 64;
pub const MAX_COMMANDS: usize = 65_536;
pub const MAX_SEGMENTS: usize = 65_536;
pub const MAX_SCAN_EDGE_TESTS: u64 = 250_000_000;
/// Extra reusable alpha masks are bounded separately from FloatFrame/GPU caches.
pub const MAX_EFFECT_MASK_BYTES: u64 = 67_108_864;
pub const MAX_EFFECT_TAPS: u64 = 250_000_000;
pub const MAX_SHADOW_BLUR: f32 = 32.0;
const AA_ROWS: usize = 4;
const TOLERANCE: f32 = 0.20;
fn default_max_scale() -> f32 { 1.0 }

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Point { pub x: f32, pub y: f32 }
impl Point { fn lerp(self, other: Self) -> Self { Self { x: (self.x+other.x)*0.5, y: (self.y+other.y)*0.5 } } }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum PathCommand {
    M { x: f32, y: f32 }, L { x: f32, y: f32 },
    Q { x1: f32, y1: f32, x: f32, y: f32 },
    C { x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32 }, Z,
}
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FillRule { #[default] NonZero, EvenOdd }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VectorPath { pub commands: Vec<PathCommand>, #[serde(default)] pub fill_rule: FillRule }

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GradientStop { pub at: f32, pub color: [f32; 4] }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Paint {
    Solid { color: [f32; 4] },
    Linear { start: Point, end: Point, stops: Vec<GradientStop> },
    Radial { center: Point, radius: f32, stops: Vec<GradientStop> },
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PaintStroke { pub width: f32, pub color: [f32; 4] }
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PaintShadow {
    pub offset_x: f32, pub offset_y: f32,
    /// Path-local Gaussian standard deviation; support is ceil(3*sigma).
    pub blur: f32, pub color: [f32; 4],
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PaintLayer {
    pub id: String, pub path: VectorPath, pub paint: Paint,
    #[serde(default)] pub clips: Vec<VectorPath>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub stroke: Option<PaintStroke>,
    #[serde(default, skip_serializing_if = "Option::is_none")] pub shadow: Option<PaintShadow>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PaintScene {
    pub width: u32, pub height: u32, pub background: [f32; 4], pub layers: Vec<PaintLayer>,
    /// Preparation tolerance is divided by this declared maximum; no silent under-tessellation on zoom.
    #[serde(default = "default_max_scale")] pub max_scale: f32,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LayerPose { pub x: f32, pub y: f32, pub scale: f32, pub opacity: f32 }
impl Default for LayerPose { fn default() -> Self { Self { x: 0.0, y: 0.0, scale: 1.0, opacity: 1.0 } } }

#[derive(Clone, Copy, Debug)]
struct Edge { a: Point, b: Point }
#[derive(Clone, Copy, Debug, Default)]
struct Bounds { x0: f32, y0: f32, x1: f32, y1: f32 }
#[derive(Clone, Debug)]
struct PreparedPath { edges: Vec<Edge>, bounds: Bounds, rule: FillRule }
#[derive(Clone, Debug)]
enum PreparedPaint {
    Solid(LinearRgba),
    Linear { start: Point, delta: Point, inverse_length2: f32, stops: Vec<(f32, LinearRgba)> },
    Radial { center: Point, inverse_radius: f32, stops: Vec<(f32, LinearRgba)> },
}
#[derive(Clone, Debug)]
struct PreparedStrokePaint { path: PreparedPath, color: LinearRgba }
#[derive(Clone, Copy, Debug)]
struct PreparedShadow { offset_x: f32, offset_y: f32, blur: f32, color: LinearRgba }
#[derive(Clone, Debug)]
struct PreparedLayer {
    id: String, path: PreparedPath, paint: PreparedPaint, clips: Vec<PreparedPath>,
    stroke: Option<PreparedStrokePaint>, shadow: Option<PreparedShadow>,
}
#[derive(Clone, Debug)]
pub struct PreparedPaintScene {
    pub width: u32, pub height: u32, max_scale: f32, background: LinearRgba, layers: Vec<PreparedLayer>,
}

fn point(x: f32, y: f32) -> Result<Point, String> {
    if !x.is_finite() || !y.is_finite() || x.abs() > 1_000_000.0 || y.abs() > 1_000_000.0 {
        return Err("path or gradient coordinate is non-finite or exceeds limit".into());
    }
    Ok(Point { x, y })
}
fn color(value: [f32; 4]) -> Result<LinearRgba, String> {
    if value.iter().any(|v| !v.is_finite() || !(0.0..=1.0).contains(v)) {
        return Err("paint color must be finite normalized straight sRGB RGBA".into());
    }
    Ok(LinearRgba::new(srgb_to_linear(value[0])?, srgb_to_linear(value[1])?, srgb_to_linear(value[2])?, value[3])?.premultiplied())
}
fn stops(values: &[GradientStop]) -> Result<Vec<(f32, LinearRgba)>, String> {
    if !(2..=16).contains(&values.len()) || values[0].at != 0.0 || values[values.len()-1].at != 1.0 {
        return Err("gradient requires 2..16 stops including 0 and 1".into());
    }
    let mut previous = -1.0;
    values.iter().map(|stop| {
        if !stop.at.is_finite() || !(0.0..=1.0).contains(&stop.at) || stop.at <= previous {
            return Err("gradient stop positions must be strictly increasing".into());
        }
        previous = stop.at;
        Ok((stop.at, color(stop.color)?))
    }).collect()
}
impl PreparedPaint {
    fn prepare(paint: &Paint) -> Result<Self, String> { Ok(match paint {
        Paint::Solid { color: rgba } => Self::Solid(color(*rgba)?),
        Paint::Linear { start, end, stops: values } => {
            point(start.x, start.y)?; point(end.x, end.y)?;
            let delta = Point { x: end.x-start.x, y: end.y-start.y };
            let length2 = delta.x*delta.x + delta.y*delta.y;
            if !length2.is_finite() || length2 < 1e-8 { return Err("linear gradient has zero length".into()); }
            Self::Linear { start: *start, delta, inverse_length2: 1.0/length2, stops: stops(values)? }
        },
        Paint::Radial { center, radius, stops: values } => {
            point(center.x, center.y)?;
            if !radius.is_finite() || !(0.001..=1_000_000.0).contains(radius) { return Err("radial gradient radius invalid".into()); }
            Self::Radial { center: *center, inverse_radius: 1.0/radius, stops: stops(values)? }
        },
    }) }
    fn sample(&self, x: f32, y: f32) -> LinearRgba {
        let (t, values) = match self {
            Self::Solid(rgba) => return *rgba,
            Self::Linear { start, delta, inverse_length2, stops } => (((x-start.x)*delta.x+(y-start.y)*delta.y)*inverse_length2, stops),
            Self::Radial { center, inverse_radius, stops } => (((x-center.x).powi(2)+(y-center.y).powi(2)).sqrt()*inverse_radius, stops),
        };
        let t = t.clamp(0.0, 1.0);
        let upper = values.partition_point(|(at, _)| *at < t).clamp(1, values.len()-1);
        let (a, left) = values[upper-1]; let (b, right) = values[upper];
        let u = (t-a)/(b-a);
        LinearRgba { r: left.r+(right.r-left.r)*u, g: left.g+(right.g-left.g)*u,
            b: left.b+(right.b-left.b)*u, a: left.a+(right.a-left.a)*u }
    }
}

fn segment(edges: &mut Vec<Edge>, a: Point, b: Point) -> Result<(), String> {
    if edges.len() >= MAX_SEGMENTS { return Err("flattened path segment budget exceeded".into()); }
    // Horizontal edges do not contribute to the half-open scanline winding.
    if a.y != b.y { edges.push(Edge { a, b }); }
    Ok(())
}
fn distance_to_segment(p: Point, a: Point, b: Point) -> f32 {
    let dx = b.x-a.x; let dy = b.y-a.y; let length2 = dx*dx+dy*dy;
    if length2 < 1e-12 { return ((p.x-a.x).powi(2)+(p.y-a.y).powi(2)).sqrt(); }
    let t = (((p.x-a.x)*dx+(p.y-a.y)*dy)/length2).clamp(0.0, 1.0);
    ((p.x-(a.x+t*dx)).powi(2)+(p.y-(a.y+t*dy)).powi(2)).sqrt()
}
fn quadratic(edges: &mut Vec<Edge>, a: Point, c: Point, b: Point, depth: usize, tolerance: f32) -> Result<(), String> {
    if distance_to_segment(c, a, b) <= tolerance { return segment(edges, a, b); }
    if depth == 16 { return Err("quadratic exceeds bounded flattening depth".into()); }
    let ac = a.lerp(c); let cb = c.lerp(b); let mid = ac.lerp(cb);
    quadratic(edges, a, ac, mid, depth+1, tolerance)?; quadratic(edges, mid, cb, b, depth+1, tolerance)
}
fn cubic(edges: &mut Vec<Edge>, a: Point, c1: Point, c2: Point, b: Point, depth: usize, tolerance: f32) -> Result<(), String> {
    if distance_to_segment(c1,a,b).max(distance_to_segment(c2,a,b)) <= tolerance { return segment(edges,a,b); }
    if depth == 16 { return Err("cubic exceeds bounded flattening depth".into()); }
    let a1=a.lerp(c1); let c12=c1.lerp(c2); let c2b=c2.lerp(b); let left=a1.lerp(c12); let right=c12.lerp(c2b); let mid=left.lerp(right);
    cubic(edges,a,a1,left,mid,depth+1, tolerance)?; cubic(edges,mid,right,c2b,b,depth+1, tolerance)
}
fn prepare_path(path: &VectorPath, tolerance: f32) -> Result<PreparedPath, String> {
    if path.commands.is_empty() || path.commands.len() > MAX_COMMANDS { return Err("path command budget invalid".into()); }
    let mut edges=Vec::new(); let mut current=None; let mut start=None; let mut steps=0;
    for command in &path.commands { match *command {
        PathCommand::M {x,y} => {
            if start.is_some() { return Err("path starts a new contour before closing".into()); }
            let p=point(x,y)?; current=Some(p); start=Some(p); steps=0;
        },
        PathCommand::L {x,y} => { let a=current.ok_or("path line without move")?; let p=point(x,y)?; segment(&mut edges,a,p)?; current=Some(p); steps+=1; },
        PathCommand::Q {x1,y1,x,y} => { let a=current.ok_or("path curve without move")?; let p=point(x,y)?; quadratic(&mut edges,a,point(x1,y1)?,p,0,tolerance)?; current=Some(p); steps+=1; },
        PathCommand::C {x1,y1,x2,y2,x,y} => { let a=current.ok_or("path curve without move")?; let p=point(x,y)?; cubic(&mut edges,a,point(x1,y1)?,point(x2,y2)?,p,0,tolerance)?; current=Some(p); steps+=1; },
        PathCommand::Z => { let a=current.ok_or("path close without contour")?; let b=start.ok_or("path close without move")?;
            if steps<2 { return Err("degenerate path contour".into()); } segment(&mut edges,a,b)?; current=None; start=None; },
    } }
    if start.is_some() || edges.len()<2 { return Err("path must contain closed visible contours".into()); }
    let mut bounds=Bounds {x0:f32::INFINITY,y0:f32::INFINITY,x1:f32::NEG_INFINITY,y1:f32::NEG_INFINITY};
    for edge in &edges { for p in [edge.a,edge.b] { bounds.x0=bounds.x0.min(p.x);bounds.x1=bounds.x1.max(p.x);bounds.y0=bounds.y0.min(p.y);bounds.y1=bounds.y1.max(p.y); } }
    if bounds.x1<=bounds.x0 || bounds.y1<=bounds.y0 { return Err("path has zero area bounds".into()); }
    Ok(PreparedPath {edges,bounds,rule:path.fill_rule})
}

#[derive(Default)]
pub struct PaintScratch {
    crossings: Vec<(f32,i32)>, intervals: Vec<(f32,f32)>, clip_intervals: Vec<(f32,f32)>,
    intersection: Vec<(f32,f32)>, row: Vec<f32>,
    fill_row: Vec<f32>, stroke_row: Vec<f32>, intersection_row: Vec<f32>, clip_row: Vec<f32>,
    mask: Vec<f32>, mask_temp: Vec<f32>, kernel: Vec<f32>, effect_taps: u64,
}
impl PaintScratch {
    pub fn effect_mask_allocated_bytes(&self) -> u64 { ((self.mask.capacity()+self.mask_temp.capacity())*std::mem::size_of::<f32>()) as u64 }
    pub fn effect_taps_last_render(&self) -> u64 { self.effect_taps }
    fn reserve_masks(&mut self,pixels:usize)->Result<(),String> {
        if pixels as u64*8>MAX_EFFECT_MASK_BYTES {return Err("shadow mask allocation exceeds budget".into());}
        for mask in [&mut self.mask,&mut self.mask_temp] {
            if pixels>mask.capacity() {mask.try_reserve_exact(pixels.saturating_sub(mask.len())).map_err(|_|"shadow mask allocation failed")?;}
            mask.resize(pixels,0.0);
        }
        if self.effect_mask_allocated_bytes()>MAX_EFFECT_MASK_BYTES {return Err("shadow mask capacity exceeds budget".into());}
        Ok(())
    }
    fn blur_mask(&mut self,rect:MaskRect,sigma:f32) {
        let radius=(3.0*sigma).ceil() as usize;
        if radius==0 || rect.pixels()==0 {return;}
        self.kernel.clear();
        let weight=|i:usize|{let x=i as f64-radius as f64;(-0.5*(x/sigma as f64).powi(2)).exp()};
        let sum:f64=(0..=2*radius).map(weight).sum();self.kernel.extend((0..=2*radius).map(|i|(weight(i)/sum) as f32));
        for y in 0..rect.height {for x in 0..rect.width {
            let from=x.saturating_sub(radius);let to=x.saturating_add(radius+1).min(rect.width);let mut value=0.0;
            for sample in from..to {value+=self.mask[y*rect.width+sample]*self.kernel[sample+radius-x];}
            self.effect_taps+=(to-from) as u64;self.mask_temp[y*rect.width+x]=value;
        }}
        for y in 0..rect.height {for x in 0..rect.width {
            let from=y.saturating_sub(radius);let to=y.saturating_add(radius+1).min(rect.height);let mut value=0.0;
            for sample in from..to {value+=self.mask_temp[sample*rect.width+x]*self.kernel[sample+radius-y];}
            self.effect_taps+=(to-from) as u64;self.mask[y*rect.width+x]=value.clamp(0.0,1.0);
        }}
    }
    fn mask_sample(&self,rect:MaskRect,x:f32,y:f32)->f32 {
        let x=x-rect.x0 as f32;let y=y-rect.y0 as f32;let x0=x.floor() as i32;let y0=y.floor() as i32;
        let dx=x-x0 as f32;let dy=y-y0 as f32;
        let at=|px:i32,py:i32| if px<0 || py<0 || px>=rect.width as i32 || py>=rect.height as i32 {0.0} else {self.mask[py as usize*rect.width+px as usize]};
        let top=at(x0,y0)*(1.0-dx)+at(x0+1,y0)*dx;let bottom=at(x0,y0+1)*(1.0-dx)+at(x0+1,y0+1)*dx;
        (top*(1.0-dy)+bottom*dy).clamp(0.0,1.0)
    }
    fn raster_row(&mut self, path: &PreparedPath, clips: &[PreparedPath], pose: LayerPose, x0: i32, y: i32, width: usize) {
        self.raster_joint_row(path,clips,None,pose,x0,y,width);
    }
    fn raster_joint_row(&mut self, path: &PreparedPath, clips: &[PreparedPath], overlap:Option<&PreparedPath>, pose: LayerPose, x0: i32, y: i32, width: usize) {
        self.row.resize(width,0.0); self.row.fill(0.0);
        for sample in 0..AA_ROWS {
            let local_y=(y as f32+(sample as f32+0.5)/AA_ROWS as f32-pose.y)/pose.scale;
            path_intervals(path,local_y,&mut self.crossings,&mut self.intervals);
            for clip in clips.iter().chain(overlap) {
                path_intervals(clip,local_y,&mut self.crossings,&mut self.clip_intervals);
                intersect_intervals(&self.intervals,&self.clip_intervals,&mut self.intersection);
                std::mem::swap(&mut self.intervals,&mut self.intersection);
            }
            for &(lo,hi) in &self.intervals {
                let lo=(lo*pose.scale+pose.x).max(x0 as f32); let hi=(hi*pose.scale+pose.x).min(x0 as f32+width as f32);
                if hi<=lo {continue;}
                for x in lo.floor() as i32..hi.ceil() as i32 {
                    self.row[(x-x0) as usize]+=(hi.min(x as f32+1.0)-lo.max(x as f32)).max(0.0)/AA_ROWS as f32;
                }
            }
        }
        for value in &mut self.row { *value=value.clamp(0.0,1.0); }
    }
    fn layer_rows(&mut self, layer: &PreparedLayer, pose: LayerPose, x0: i32, y: i32, width: usize) {
        self.raster_row(&layer.path,&layer.clips,pose,x0,y,width); std::mem::swap(&mut self.row,&mut self.fill_row);
        if let Some(stroke)=&layer.stroke {
            self.raster_row(&stroke.path,&layer.clips,pose,x0,y,width); std::mem::swap(&mut self.row,&mut self.stroke_row);
            self.raster_joint_row(&layer.path,&layer.clips,Some(&stroke.path),pose,x0,y,width);std::mem::swap(&mut self.row,&mut self.intersection_row);
        } else {
            self.stroke_row.resize(width,0.0);self.stroke_row.fill(0.0);
            self.intersection_row.resize(width,0.0);self.intersection_row.fill(0.0);
        }
        if let Some((first,rest))=layer.clips.split_first() {
            self.raster_row(first,rest,pose,x0,y,width); std::mem::swap(&mut self.row,&mut self.clip_row);
        } else { self.clip_row.resize(width,1.0); self.clip_row.fill(1.0); }
    }
    fn group_pixel(&self,layer:&PreparedLayer,fill:LinearRgba,x:usize)->LinearRgba {
        if let Some(stroke)=&layer.stroke {
            let fill_weight=(self.fill_row[x]-stroke.color.a*self.intersection_row[x]).max(0.0);
            let s=covered(stroke.color,self.stroke_row[x]);let f=covered(fill,fill_weight);
            LinearRgba{r:s.r+f.r,g:s.g+f.g,b:s.b+f.b,a:s.a+f.a}
        } else {covered(fill,self.fill_row[x])}
    }
}
#[derive(Clone, Copy, Debug, Default)]
struct MaskRect { x0: i32, y0: i32, width: usize, height: usize }
impl MaskRect {
    fn from_bounds(b: Bounds) -> Self {
        if b.x1<=b.x0 || b.y1<=b.y0 {return Self::default();}
        let x0=b.x0.floor() as i32; let y0=b.y0.floor() as i32;
        Self {x0,y0,width:(b.x1.ceil() as i32-x0) as usize,height:(b.y1.ceil() as i32-y0) as usize}
    }
    fn pixels(self) -> u64 { self.width as u64*self.height as u64 }
}
impl Bounds {
    fn union(self,other:Self)->Self {Self{x0:self.x0.min(other.x0),y0:self.y0.min(other.y0),x1:self.x1.max(other.x1),y1:self.y1.max(other.y1)}}
    fn intersect(self,other:Self)->Self {Self{x0:self.x0.max(other.x0),y0:self.y0.max(other.y0),x1:self.x1.min(other.x1),y1:self.y1.min(other.y1)}}
    fn expand(self,r:f32)->Self {Self{x0:self.x0-r,y0:self.y0-r,x1:self.x1+r,y1:self.y1+r}}
    fn translated(self,x:f32,y:f32)->Self {Self{x0:self.x0+x,y0:self.y0+y,x1:self.x1+x,y1:self.y1+y}}
    fn posed(self,pose:LayerPose)->Self {Self{x0:self.x0*pose.scale+pose.x,y0:self.y0*pose.scale+pose.y,x1:self.x1*pose.scale+pose.x,y1:self.y1*pose.scale+pose.y}}
}
fn over(destination:LinearRgba,source:LinearRgba)->LinearRgba {
    let remain=1.0-source.a;
    LinearRgba{r:source.r+destination.r*remain,g:source.g+destination.g*remain,b:source.b+destination.b*remain,a:source.a+destination.a*remain}
}
fn covered(source:LinearRgba,coverage:f32)->LinearRgba {
    LinearRgba{r:source.r*coverage,g:source.g*coverage,b:source.b*coverage,a:source.a*coverage}
}
fn path_intervals(path:&PreparedPath,y:f32,crossings:&mut Vec<(f32,i32)>,out:&mut Vec<(f32,f32)>) {
    crossings.clear(); out.clear();
    for edge in &path.edges {
        let lo=edge.a.y.min(edge.b.y);let hi=edge.a.y.max(edge.b.y);
        if y>=lo && y<hi { crossings.push((edge.a.x+(y-edge.a.y)*(edge.b.x-edge.a.x)/(edge.b.y-edge.a.y),if edge.b.y>edge.a.y {1}else{-1})); }
    }
    crossings.sort_unstable_by(|a,b|a.0.total_cmp(&b.0));
    let mut winding:i32=0;let mut previous=0.0;let mut i=0;
    while i<crossings.len() {
        let x=crossings[i].0;let inside=match path.rule {FillRule::NonZero=>winding!=0,FillRule::EvenOdd=>winding.rem_euclid(2)!=0};
        if inside && x>previous { out.push((previous,x)); }
        while i<crossings.len() && crossings[i].0==x {winding+=crossings[i].1;i+=1;}
        previous=x;
    }
}
fn intersect_intervals(a:&[(f32,f32)],b:&[(f32,f32)],out:&mut Vec<(f32,f32)>) {
    out.clear();let(mut i,mut j)=(0,0);
    while i<a.len() && j<b.len() { let lo=a[i].0.max(b[j].0);let hi=a[i].1.min(b[j].1);if hi>lo {out.push((lo,hi));}
        if a[i].1<b[j].1 {i+=1;}else{j+=1;} }
}
impl PreparedPaintScene {
    /// Paint on a reusable transparent intermediate, preserving the media
    /// beneath it. Pose opacity and clip coverage are applied exactly once.
    pub fn render_over(&self, target:&mut FloatFrame, overlay:&mut FloatFrame,
        poses:&[LayerPose], scratch:&mut PaintScratch)->Result<(),String> {
        if self.background.a != 0.0 { return Err("overlay scene background must be transparent".into()); }
        target.validate()?;
        if target.width!=self.width || target.height!=self.height { return Err("overlay target dimensions differ".into()); }
        // All fallible geometry/pose work happens before touching the media.
        self.render_into(overlay, poses, scratch)?;
        overlay.validate()?;
        for (destination,source) in target.pixels.iter_mut().zip(&overlay.pixels) {
            *destination=super::composite::composite_pixel(*destination,*source,super::model::BlendMode::Normal,1.0,1.0)?;
        }
        Ok(())
    }
    pub fn prepare(scene:&PaintScene)->Result<Self,String> {
        if scene.width==0 || scene.height==0 || scene.width as u64*scene.height as u64>MAX_PIXELS
            || scene.width>8192 || scene.height>8192 || scene.layers.len()>MAX_LAYERS
            || !scene.max_scale.is_finite() || !(1.0..=32.0).contains(&scene.max_scale) {return Err("scene dimension, scale or layer budget invalid".into());}
        let background=color(scene.background)?;let mut layers=Vec::with_capacity(scene.layers.len());
        let mut ids=std::collections::HashSet::new();let mut commands=0;let mut segments=0;
        for layer in &scene.layers {
            if layer.id.is_empty() || layer.id.len()>128 || !ids.insert(layer.id.clone()) || layer.clips.len()>8 {return Err("layer ID or clip count invalid".into());}
            commands+=layer.path.commands.len()+layer.clips.iter().map(|p|p.commands.len()).sum::<usize>();
            if commands>MAX_COMMANDS {return Err("scene path command budget exceeded".into());}
            let tolerance=TOLERANCE/scene.max_scale;
            let path=prepare_path(&layer.path,tolerance)?;let clips=layer.clips.iter().map(|p|prepare_path(p,tolerance)).collect::<Result<Vec<_>,_>>()?;
            let stroke=if let Some(style)=layer.stroke {
                if !style.width.is_finite() || !(0.25..=256.0).contains(&style.width) {return Err("paint stroke width invalid".into());}
                let compiled=super::vector_stroke::PreparedStroke::prepare(&layer.path.commands,scene.max_scale)?;
                let geometry=compiled.expand(&super::vector_stroke::StrokeStyle{width:style.width,..Default::default()})?;
                let stroke_path=geometry.path.ok_or("paint stroke has no visible outline")?;
                commands+=stroke_path.commands.len();
                if commands>MAX_COMMANDS {return Err("scene expanded stroke command budget exceeded".into());}
                Some(PreparedStrokePaint{path:prepare_path(&stroke_path,tolerance)?,color:color(style.color)?})
            } else {None};
            let shadow=if let Some(style)=layer.shadow {
                if !style.offset_x.is_finite() || !style.offset_y.is_finite() || style.offset_x.abs()>256.0 || style.offset_y.abs()>256.0
                    || !style.blur.is_finite() || !(0.0..=MAX_SHADOW_BLUR).contains(&style.blur) {return Err("paint shadow offset or Gaussian sigma invalid".into());}
                Some(PreparedShadow{offset_x:style.offset_x,offset_y:style.offset_y,blur:style.blur,color:color(style.color)?})
            } else {None};
            segments+=path.edges.len()+clips.iter().map(|p|p.edges.len()).sum::<usize>()+stroke.as_ref().map_or(0,|s|s.path.edges.len());
            if segments>MAX_SEGMENTS {return Err("scene flattened segment budget exceeded".into());}
            layers.push(PreparedLayer{id:layer.id.clone(),path,paint:PreparedPaint::prepare(&layer.paint)?,clips,stroke,shadow});
        }
        let prepared=Self{width:scene.width,height:scene.height,max_scale:scene.max_scale,background,layers};
        prepared.admit_poses(&vec![LayerPose::default();prepared.layers.len()])?;
        Ok(prepared)
    }
    pub fn layer_count(&self)->usize {self.layers.len()}
    pub fn layer_ids(&self)->impl Iterator<Item=&str> {self.layers.iter().map(|l|l.id.as_str())}
    pub fn edge_count(&self)->usize {self.layers.iter().map(|l|l.path.edges.len()+l.clips.iter().map(|p|p.edges.len()).sum::<usize>()+l.stroke.as_ref().map_or(0,|s|s.path.edges.len())).sum()}
    fn viewport(&self)->Bounds {Bounds{x0:0.0,y0:0.0,x1:self.width as f32,y1:self.height as f32}}
    fn unclamped_shape_bounds(&self,layer:&PreparedLayer,pose:LayerPose)->Bounds {
        let mut b=layer.path.bounds;
        if let Some(stroke)=&layer.stroke {b=b.union(stroke.path.bounds);}
        for clip in &layer.clips {b=b.intersect(clip.bounds);}
        b.posed(pose)
    }
    fn effect_bounds(&self,layer:&PreparedLayer,pose:LayerPose)->Bounds {
        let shape=self.unclamped_shape_bounds(layer,pose);let mut b=shape;
        if shape.x1<=shape.x0 || shape.y1<=shape.y0 {return shape.intersect(self.viewport());}
        if let Some(shadow)=layer.shadow {
            if shadow.color.a>0.0 {b=b.union(shape.expand((3.0*shadow.blur*pose.scale).ceil()+1.0).translated(shadow.offset_x*pose.scale,shadow.offset_y*pose.scale));}
        }
        for clip in &layer.clips {b=b.intersect(clip.bounds.posed(pose));}
        b.intersect(self.viewport())
    }
    fn shadow_mask_rect(&self,layer:&PreparedLayer,pose:LayerPose)->MaskRect {
        let Some(shadow)=layer.shadow else{return MaskRect::default();};
        if shadow.color.a==0.0 {return MaskRect::default();}
        let b=self.unclamped_shape_bounds(layer,pose);
        if b.x1<=b.x0 || b.y1<=b.y0 {return MaskRect::default();}
        let radius=(3.0*shadow.blur*pose.scale).ceil();
        let offset_x=shadow.offset_x*pose.scale;let offset_y=shadow.offset_y*pose.scale;
        // Keep the halo needed by visible inverse-mapped samples, including offscreen casters.
        let sample_halo=self.viewport().translated(-offset_x,-offset_y).expand(radius+1.0);
        MaskRect::from_bounds(b.expand(radius+1.0).intersect(sample_halo))
    }
    fn render_effect_layer(&self,layer:&PreparedLayer,pose:LayerPose,frame:&mut FloatFrame,scratch:&mut PaintScratch) {
        let rect=self.shadow_mask_rect(layer,pose);
        if rect.pixels()>0 {
            scratch.mask.resize(rect.pixels() as usize,0.0);scratch.mask.fill(0.0);
            scratch.mask_temp.resize(rect.pixels() as usize,0.0);
            for y in 0..rect.height {
                let world_y=rect.y0+y as i32;scratch.layer_rows(layer,pose,rect.x0,world_y,rect.width);
                for x in 0..rect.width {
                    let fill=layer.paint.sample((rect.x0 as f32+x as f32+0.5-pose.x)/pose.scale,(world_y as f32+0.5-pose.y)/pose.scale);
                    scratch.mask[y*rect.width+x]=scratch.group_pixel(layer,fill,x).a.clamp(0.0,1.0);
                }
            }
            scratch.blur_mask(rect,layer.shadow.unwrap().blur*pose.scale);
        }
        let render=MaskRect::from_bounds(self.effect_bounds(layer,pose));
        for y in 0..render.height {
            let world_y=render.y0+y as i32;scratch.layer_rows(layer,pose,render.x0,world_y,render.width);
            for x in 0..render.width {
                let world_x=render.x0+x as i32;
                let fill=layer.paint.sample((world_x as f32+0.5-pose.x)/pose.scale,(world_y as f32+0.5-pose.y)/pose.scale);
                let mut source=scratch.group_pixel(layer,fill,x);
                if let Some(shadow)=layer.shadow {
                    if rect.pixels()>0 {
                        let mask=scratch.mask_sample(rect,world_x as f32-shadow.offset_x*pose.scale,world_y as f32-shadow.offset_y*pose.scale);
                        let background=covered(shadow.color,mask*(scratch.clip_row[x]-source.a).max(0.0));
                        source=LinearRgba{r:source.r+background.r,g:source.g+background.g,b:source.b+background.b,a:source.a+background.a};
                    }
                }
                // Geometry/clip coverage is correlated, so it is never multiplied twice.
                // Only group opacity is applied after the joint fill/stroke/shadow integration.
                source=covered(source,pose.opacity);
                let destination=&mut frame.pixels[world_y as usize*self.width as usize+world_x as usize];
                *destination=over(*destination,source);
            }
        }
    }
    fn bounds(&self,layer:&PreparedLayer,pose:LayerPose)->Bounds {
        let mut b=layer.path.bounds;
        for clip in &layer.clips {b.x0=b.x0.max(clip.bounds.x0);b.y0=b.y0.max(clip.bounds.y0);b.x1=b.x1.min(clip.bounds.x1);b.y1=b.y1.min(clip.bounds.y1);}
        Bounds{x0:(b.x0*pose.scale+pose.x).clamp(0.0,self.width as f32),x1:(b.x1*pose.scale+pose.x).clamp(0.0,self.width as f32),
            y0:(b.y0*pose.scale+pose.y).clamp(0.0,self.height as f32),y1:(b.y1*pose.scale+pose.y).clamp(0.0,self.height as f32)}
    }
    pub(super) fn admit_poses(&self,poses:&[LayerPose])->Result<(),String> {
        if poses.len()!=self.layers.len(){return Err("pose count differs from scene layers".into());}
        let mut tests=0u64;let mut effect_taps=0u64;
        for(layer,pose)in self.layers.iter().zip(poses) {
            point(pose.x,pose.y)?;
            if !pose.scale.is_finite() || !(0.01..=self.max_scale).contains(&pose.scale) || !pose.opacity.is_finite() || !(0.0..=1.0).contains(&pose.opacity){return Err("layer scale exceeds prepared maximum or opacity invalid".into());}
            let effects=layer.stroke.is_some() || layer.shadow.is_some();
            let b=if effects {self.effect_bounds(layer,*pose)} else {self.bounds(layer,*pose)};
            let rows=(b.y1.ceil()-b.y0.floor()).max(0.0)as u64;
            let clip_edges=layer.clips.iter().map(|p|p.edges.len()).sum::<usize>();
            let stroke_edges=layer.stroke.as_ref().map_or(0,|s|s.path.edges.len());
            let edge_count=if effects {
                // fill+clips, clip-only shadow bound, and stroke+clips + joint fill/stroke+clips.
                layer.path.edges.len()+2*clip_edges+if layer.stroke.is_some(){layer.path.edges.len()+2*stroke_edges+2*clip_edges}else{0}
            } else {layer.path.edges.len()+clip_edges};
            tests=tests.saturating_add(rows*AA_ROWS as u64*edge_count as u64);
            if let Some(shadow)=layer.shadow {
                let rect=self.shadow_mask_rect(layer,*pose);
                if rect.pixels().saturating_mul(8)>MAX_EFFECT_MASK_BYTES {return Err("shadow reusable mask byte budget exceeded".into());}
                let radius=(3.0*shadow.blur*pose.scale).ceil() as u64;
                if radius>0 {effect_taps=effect_taps.saturating_add(rect.pixels().saturating_mul(2).saturating_mul(2*radius+1));}
                tests=tests.saturating_add(rect.height as u64*AA_ROWS as u64*edge_count as u64);
                if effect_taps>MAX_EFFECT_TAPS {return Err("shadow Gaussian frame work budget exceeded".into());}
            }
            if tests>MAX_SCAN_EDGE_TESTS{return Err("frame scanline edge work budget exceeded".into());}
        }
        Ok(())
    }
    /// Validates all poses before touching pixels. Scratch and output allocation are reusable.
    pub fn render_into(&self,frame:&mut FloatFrame,poses:&[LayerPose],scratch:&mut PaintScratch)->Result<(),String> {
        if frame.width!=self.width || frame.height!=self.height || frame.pixels.len()!=self.width as usize*self.height as usize {return Err("target frame differs from prepared scene".into());}
        self.admit_poses(poses)?;
        let mask_pixels=self.layers.iter().zip(poses).map(|(layer,pose)|self.shadow_mask_rect(layer,*pose).pixels() as usize).max().unwrap_or(0);
        scratch.reserve_masks(mask_pixels)?;scratch.effect_taps=0;
        frame.pixels.fill(self.background);scratch.row.resize(self.width as usize,0.0);
        for(layer,pose)in self.layers.iter().zip(poses) {
            if pose.opacity==0.0 {continue;}
            if layer.stroke.is_some() || layer.shadow.is_some() {self.render_effect_layer(layer,*pose,frame,scratch);continue;}
            scratch.row.resize(self.width as usize,0.0);
            let bounds=self.bounds(layer,*pose);let x0=bounds.x0.floor()as usize;let x1=bounds.x1.ceil()as usize;
            let y0=bounds.y0.floor()as usize;let y1=bounds.y1.ceil()as usize;
            if x1<=x0 || y1<=y0 {continue;}
            for y in y0..y1 {
                scratch.row[x0..x1].fill(0.0);
                for sample in 0..AA_ROWS {
                    let local_y=(y as f32+(sample as f32+0.5)/AA_ROWS as f32-pose.y)/pose.scale;
                    path_intervals(&layer.path,local_y,&mut scratch.crossings,&mut scratch.intervals);
                    for clip in &layer.clips {
                        path_intervals(clip,local_y,&mut scratch.crossings,&mut scratch.clip_intervals);
                        intersect_intervals(&scratch.intervals,&scratch.clip_intervals,&mut scratch.intersection);
                        std::mem::swap(&mut scratch.intervals,&mut scratch.intersection);
                    }
                    for &(lo,hi)in &scratch.intervals {
                        let lo=(lo*pose.scale+pose.x).max(x0 as f32);let hi=(hi*pose.scale+pose.x).min(x1 as f32);
                        if hi<=lo {continue;}
                        for x in lo.floor()as usize..hi.ceil()as usize {
                            scratch.row[x]+=(hi.min(x as f32+1.0)-lo.max(x as f32)).max(0.0)/AA_ROWS as f32;
                        }
                    }
                }
                for x in x0..x1 {
                    let coverage=scratch.row[x].clamp(0.0,1.0)*pose.opacity;if coverage==0.0 {continue;}
                    let s=layer.paint.sample((x as f32+0.5-pose.x)/pose.scale,(y as f32+0.5-pose.y)/pose.scale);
                    let destination=&mut frame.pixels[y*self.width as usize+x];let remaining=1.0-s.a*coverage;
                    *destination=LinearRgba{r:s.r*coverage+destination.r*remaining,g:s.g*coverage+destination.g*remaining,
                        b:s.b*coverage+destination.b*remaining,a:s.a*coverage+destination.a*remaining};
                }
            }
        }
        Ok(())
    }
}

/// Reusable SDR encoder with a 64KiB one-dimensional table. Maximum difference from
/// Editkin's exact transfer/rounding is one 8-bit RGB value, independently tested.
/// Quantizes only after unpremultiplication; alpha is encoded by the exact old rule.
pub struct Rgba8Encoder { srgb: Vec<u8> }
impl Rgba8Encoder {
    pub fn new()->Result<Self,String> {
        let mut srgb=Vec::with_capacity(65_536);
        for i in 0..=65_535 {srgb.push((linear_to_srgb(i as f32/65_535.0)?.clamp(0.0,1.0)*255.0).round()as u8);}
        Ok(Self{srgb})
    }
    // Positive quantization via exact widened +0.5 then truncation avoids a per-channel
    // CRT roundf call on the Windows baseline CPU. Widen AFTER f32 multiplication:
    // this preserves the old f32 scaled value and half-up alpha rule at near-half ties.
    pub fn channel(&self,linear:f32)->u8 {self.srgb[((linear.clamp(0.0,1.0)*65_535.0)as f64+0.5)as usize]}
    pub fn alpha(value:f32)->u8 {((value*255.0)as f64+0.5)as u32 as u8}
    pub fn encode_into(&self,frame:&FloatFrame,bytes:&mut Vec<u8>)->Result<(),String> {
        if frame.width==0 || frame.height==0 || frame.width as u64*frame.height as u64>MAX_PIXELS {return Err("RGBA8 frame budget invalid".into());}
        frame.validate()?;bytes.resize(frame.pixels.len()*4,0);
        for(p,out)in frame.pixels.iter().zip(bytes.chunks_exact_mut(4)){let c=p.unpremultiplied();out[0]=self.channel(c.r);out[1]=self.channel(c.g);out[2]=self.channel(c.b);out[3]=Self::alpha(p.a);}
        Ok(())
    }
}

#[cfg(test)]
mod product_overlay_tests {
    use super::*;
    fn scene()->PaintScene {
        PaintScene { width:4,height:4,max_scale:1.0,background:[0.0;4],layers:vec![PaintLayer {
            id:"foreground".into(), path:VectorPath{fill_rule:FillRule::NonZero,commands:vec![
                PathCommand::M{x:0.0,y:0.0},PathCommand::L{x:2.0,y:0.0},PathCommand::L{x:2.0,y:2.0},PathCommand::L{x:0.0,y:2.0},PathCommand::Z]},
            paint:Paint::Solid{color:[1.0,0.0,0.0,0.5]},clips:vec![],stroke:None,shadow:None }] }
    }
    #[test]
    fn overlay_preserves_media_and_applies_pose_alpha_once() {
        let prepared=PreparedPaintScene::prepare(&scene()).unwrap();
        let mut target=FloatFrame::transparent(4,4).unwrap();target.pixels.fill(LinearRgba::new(0.0,0.0,1.0,1.0).unwrap());
        let mut overlay=FloatFrame::transparent(4,4).unwrap();
        prepared.render_over(&mut target,&mut overlay,&[LayerPose{opacity:0.5,..LayerPose::default()}],&mut PaintScratch::default()).unwrap();
        assert_eq!(target.pixels[0],LinearRgba::new(0.25,0.0,0.75,1.0).unwrap());
        assert_eq!(target.pixels[15],LinearRgba::new(0.0,0.0,1.0,1.0).unwrap());
    }
    #[test]
    fn overlay_errors_do_not_change_media() {
        let mut target=FloatFrame::transparent(4,4).unwrap();target.pixels.fill(LinearRgba::new(0.0,0.0,1.0,1.0).unwrap());
        let before=target.clone();let mut overlay=FloatFrame::transparent(4,4).unwrap();
        let prepared=PreparedPaintScene::prepare(&scene()).unwrap();
        assert!(prepared.render_over(&mut target,&mut overlay,&[LayerPose{scale:2.0,..LayerPose::default()}],&mut PaintScratch::default()).is_err());
        assert_eq!(target,before);
        let mut opaque=scene();opaque.background=[1.0,1.0,1.0,1.0];
        assert!(PreparedPaintScene::prepare(&opaque).unwrap().render_over(&mut target,&mut overlay,&[LayerPose::default()],&mut PaintScratch::default()).is_err());
        assert_eq!(target,before);
    }
}

#[cfg(test)]
mod natural_effect_tests {
    use super::*;
    fn rectangle(x0:f32,y0:f32,x1:f32,y1:f32)->VectorPath {
        VectorPath{fill_rule:FillRule::NonZero,commands:vec![PathCommand::M{x:x0,y:y0},PathCommand::L{x:x1,y:y0},PathCommand::L{x:x1,y:y1},PathCommand::L{x:x0,y:y1},PathCommand::Z]}
    }
    fn panel()->PaintLayer {
        PaintLayer{id:"native-panel".into(),path:rectangle(20.0,18.0,50.0,40.0),paint:Paint::Solid{color:[0.16,0.42,0.86,1.0]},
            clips:vec![],stroke:Some(PaintStroke{width:2.0,color:[0.8,0.9,1.0,0.65]}),
            shadow:Some(PaintShadow{offset_x:5.0,offset_y:6.0,blur:3.0,color:[0.02,0.05,0.12,0.35]})}
    }
    fn scene(layer:PaintLayer)->PaintScene {PaintScene{width:80,height:64,max_scale:2.0,background:[0.0;4],layers:vec![layer]}}
    fn pixel(frame:&FloatFrame,x:usize,y:usize)->LinearRgba {frame.pixels[y*frame.width as usize+x]}
    fn write_png_if_requested(frame:&FloatFrame,name:&str) {
        let Ok(root)=std::env::var("EDITKIN_NATIVE_EFFECT_TEST_OUTPUT") else{return;};
        std::fs::create_dir_all(&root).unwrap();let path=std::path::Path::new(&root).join(name);
        let mut bytes=Vec::new();Rgba8Encoder::new().unwrap().encode_into(frame,&mut bytes).unwrap();
        let file=std::fs::File::create(path).unwrap();let mut encoder=png::Encoder::new(file,frame.width,frame.height);
        encoder.set_color(png::ColorType::Rgba);encoder.set_depth(png::BitDepth::Eight);encoder.write_header().unwrap().write_image_data(&bytes).unwrap();
    }
    #[test]
    fn native_panel_has_round_stroke_gaussian_transition_and_group_opacity() {
        let prepared=PreparedPaintScene::prepare(&scene(panel())).unwrap();let mut scratch=PaintScratch::default();let mut frame=FloatFrame::transparent(80,64).unwrap();
        prepared.render_into(&mut frame,&[LayerPose::default()],&mut scratch).unwrap();frame.validate().unwrap();
        assert_eq!(pixel(&frame,30,28).a,1.0);assert!(pixel(&frame,19,28).a>0.5,"round union stroke covers the path exterior");
        let near=pixel(&frame,35,47).a;let middle=pixel(&frame,35,50).a;let far=pixel(&frame,35,54).a;
        assert!(near>middle && middle>far && far>0.0 && near<0.35,"Gaussian shadow must decay continuously: {near}/{middle}/{far}");
        assert!(scratch.effect_taps_last_render()>0);assert!(scratch.effect_mask_allocated_bytes()<=MAX_EFFECT_MASK_BYTES);
        write_png_if_requested(&frame,"native-panel-stroke-shadow.png");let full=frame.clone();
        prepared.render_into(&mut frame,&[LayerPose{opacity:0.5,..LayerPose::default()}],&mut scratch).unwrap();
        for (actual,expected) in frame.pixels.iter().zip(&full.pixels) {assert_eq!(*actual,covered(*expected,0.5));}
        write_png_if_requested(&frame,"native-panel-stroke-shadow-half-opacity.png");
        prepared.render_into(&mut frame,&[LayerPose{x:7.25,y:-1.5,scale:1.25,opacity:0.7}],&mut scratch).unwrap();frame.validate().unwrap();
        prepared.render_into(&mut frame,&[LayerPose::default()],&mut scratch).unwrap();assert_eq!(frame,full,"reverse seek/repeated sample must be byte deterministic");
    }
    #[test]
    fn gaussian_is_normalized_separable_with_exact_three_sigma_support() {
        let rect=MaskRect{x0:0,y0:0,width:11,height:11};let mut scratch=PaintScratch::default();scratch.reserve_masks(121).unwrap();scratch.mask[5*11+5]=1.0;
        scratch.blur_mask(rect,1.0);
        let sum:f64=(-3_i32..=3).map(|x|(-0.5*(x*x) as f64).exp()).sum();
        assert!((scratch.mask[5*11+5] as f64-1.0/(sum*sum)).abs()<1e-7);
        assert!((scratch.mask[5*11+6]/scratch.mask[5*11+5]-(-0.5_f32).exp()).abs()<1e-6);
        assert_eq!(scratch.mask[5*11+9],0.0);assert!((scratch.mask.iter().sum::<f32>()-1.0).abs()<1e-6);
    }
    #[test]
    fn fractional_identical_clip_keeps_joint_fill_stroke_coverage() {
        let mut layer=panel();layer.path=rectangle(20.5,18.5,50.5,40.5);layer.clips=vec![layer.path.clone()];
        layer.stroke=None;layer.shadow=None;layer.paint=Paint::Solid{color:[0.0,0.0,1.0,0.5]};
        let mut baseline=FloatFrame::transparent(80,64).unwrap();let mut actual=baseline.clone();let mut scratch=PaintScratch::default();
        PreparedPaintScene::prepare(&scene(layer.clone())).unwrap().render_into(&mut baseline,&[LayerPose::default()],&mut scratch).unwrap();
        layer.shadow=Some(PaintShadow{offset_x:0.0,offset_y:0.0,blur:1.0,color:[0.0;4]});
        PreparedPaintScene::prepare(&scene(layer.clone())).unwrap().render_into(&mut actual,&[LayerPose::default()],&mut scratch).unwrap();
        assert_eq!(actual,baseline,"an inactive shadow must not square the existing geometric clip coverage");assert_eq!(pixel(&actual,20,24).a,0.25);
        layer.stroke=Some(PaintStroke{width:2.0,color:[1.0,0.0,0.0,0.5]});
        PreparedPaintScene::prepare(&scene(layer)).unwrap().render_into(&mut actual,&[LayerPose::default()],&mut scratch).unwrap();
        assert_eq!(pixel(&actual,20,24),LinearRgba{r:0.25,g:0.0,b:0.125,a:0.375},"half-coverage clip and overlapping half-alpha inks must share the same intersection");
        actual.validate().unwrap();write_png_if_requested(&actual,"native-fractional-clip-transparent-stroke.png");
    }
    #[test]
    fn clips_holes_and_later_layers_preserve_native_compositing() {
        let mut layer=panel();layer.clips=vec![rectangle(0.0,0.0,70.0,32.0)];
        let prepared=PreparedPaintScene::prepare(&scene(layer)).unwrap();let mut frame=FloatFrame::transparent(80,64).unwrap();let mut scratch=PaintScratch::default();
        prepared.render_into(&mut frame,&[LayerPose::default()],&mut scratch).unwrap();
        assert!(frame.pixels[32*80..].iter().all(|p|*p==LinearRgba::default()));write_png_if_requested(&frame,"native-panel-clipped-shadow.png");
        let mut hole=panel();hole.shadow=Some(PaintShadow{blur:0.0,offset_x:0.0,offset_y:0.0,..hole.shadow.unwrap()});hole.stroke=None;
        hole.path.fill_rule=FillRule::EvenOdd;hole.path.commands.extend(rectangle(27.0,23.0,43.0,35.0).commands);
        PreparedPaintScene::prepare(&scene(hole)).unwrap().render_into(&mut frame,&[LayerPose::default()],&mut scratch).unwrap();
        assert_eq!(pixel(&frame,35,28),LinearRgba::default(),"counter must stay transparent");
        let mut layers=scene(panel());let mut later=panel();later.id="later-layer".into();later.path=rectangle(0.0,0.0,80.0,64.0);later.paint=Paint::Solid{color:[1.0,0.0,0.0,1.0]};later.stroke=None;later.shadow=None;layers.layers.push(later);
        PreparedPaintScene::prepare(&layers).unwrap().render_into(&mut frame,&[LayerPose::default(),LayerPose::default()],&mut scratch).unwrap();
        assert!(frame.pixels.iter().all(|p|*p==LinearRgba{r:1.0,g:0.0,b:0.0,a:1.0}),"later legacy fill covers the entire effect group");
    }
    #[test]
    fn offscreen_caster_fractional_offset_and_zero_sigma_remain_visible() {
        let mut layer=panel();layer.path=rectangle(-10.0,10.0,-2.0,20.0);layer.stroke=None;layer.shadow=Some(PaintShadow{offset_x:8.5,offset_y:0.0,blur:0.0,color:[1.0,0.0,0.0,0.5]});
        let prepared=PreparedPaintScene::prepare(&scene(layer)).unwrap();let mut frame=FloatFrame::transparent(80,64).unwrap();let mut scratch=PaintScratch::default();
        prepared.render_into(&mut frame,&[LayerPose::default()],&mut scratch).unwrap();
        assert_eq!(pixel(&frame,0,15),LinearRgba{r:0.5,g:0.0,b:0.0,a:0.5});assert_eq!(pixel(&frame,6,15).a,0.25);assert_eq!(pixel(&frame,7,15).a,0.0);
        assert_eq!(scratch.effect_taps_last_render(),0);write_png_if_requested(&frame,"native-offscreen-fractional-shadow.png");
    }
    #[test]
    fn invalid_effects_and_high_zoom_work_fail_before_target_mutation() {
        let mut layer=panel();layer.shadow.as_mut().unwrap().blur=32.01;assert!(PreparedPaintScene::prepare(&scene(layer)).is_err());
        let mut layer=panel();layer.shadow.as_mut().unwrap().offset_x=257.0;assert!(PreparedPaintScene::prepare(&scene(layer)).is_err());
        let mut layer=panel();layer.stroke.as_mut().unwrap().width=f32::NAN;assert!(PreparedPaintScene::prepare(&scene(layer)).is_err());
        let mut s=scene(panel());s.width=256;s.height=256;s.max_scale=32.0;s.layers[0].shadow.as_mut().unwrap().blur=32.0;
        let prepared=PreparedPaintScene::prepare(&s).unwrap();let mut frame=FloatFrame::transparent(256,256).unwrap();frame.pixels.fill(LinearRgba{r:0.0,g:0.0,b:1.0,a:1.0});let before=frame.clone();
        let error=prepared.render_into(&mut frame,&[LayerPose{scale:32.0,..LayerPose::default()}],&mut PaintScratch::default()).unwrap_err();assert!(error.contains("budget"));assert_eq!(frame,before);
        let unknown=r#"{"id":"x","path":{"commands":[]},"paint":{"kind":"solid","color":[0,0,0,1]},"shadow":{"offset_x":0,"offset_y":0,"blur":1,"color":[0,0,0,1],"css":true}}"#;
        assert!(serde_json::from_str::<PaintLayer>(unknown).is_err());
    }
}
