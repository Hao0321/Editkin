//! Original bounded stroke geometry compiler. Output uses the existing native paint consumer.
//! Width, dash and trim are path-local; rendering zoom is bounded at preparation time.
use super::motion_paint::{FillRule, PathCommand, Point, VectorPath};
use serde::{Deserialize, Serialize};

const MAX_INPUT_COMMANDS: usize = 4096;
const MAX_POINTS: usize = 8192;
const MAX_COMPONENTS: usize = 2048;
const MAX_OUTPUT_COMMANDS: usize = 65_536;
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum StrokeCap { Butt, Round, Square }
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum StrokeJoin { Bevel, Round, Miter }
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct StrokeStyle {
    pub width: f32, pub cap: StrokeCap, pub join: StrokeJoin, pub miter_limit: f32,
    pub trim_start: f64, pub trim_end: f64,
    pub dash: Vec<f64>, pub dash_offset: f64,
}
impl Default for StrokeStyle { fn default() -> Self { Self {
    width: 4.0, cap: StrokeCap::Round, join: StrokeJoin::Round, miter_limit: 4.0,
    trim_start: 0.0, trim_end: 1.0, dash: Vec::new(), dash_offset: 0.0,
} } }
#[derive(Clone, Copy, Debug)]
struct P { x: f64, y: f64 }
impl P {
    fn from(x:f32,y:f32)->Result<Self,String> {
        if !x.is_finite() || !y.is_finite() || x.abs()>1_000_000.0 || y.abs()>1_000_000.0 {return Err("stroke coordinate invalid".into());}
        Ok(Self{x:x as f64,y:y as f64})
    }
    fn add(self,b:Self)->Self {Self{x:self.x+b.x,y:self.y+b.y}}
    fn sub(self,b:Self)->Self {Self{x:self.x-b.x,y:self.y-b.y}}
    fn mul(self,s:f64)->Self {Self{x:self.x*s,y:self.y*s}}
    fn length(self)->f64 {self.x.hypot(self.y)}
    fn lerp(self,b:Self,t:f64)->Self {self.add(b.sub(self).mul(t))}
    fn cross(self,b:Self)->f64 {self.x*b.y-self.y*b.x}
    fn normal(self)->Self {Self{x:-self.y,y:self.x}}
}
#[derive(Clone, Debug)]
struct Contour { points:Vec<P>, distances:Vec<f64>, start:f64, length:f64, closed:bool }
#[derive(Clone, Debug)]
pub struct PreparedStroke { contours:Vec<Contour>, length:f64, tolerance:f64, max_scale:f32, points:usize }
#[derive(Clone, Debug)]
pub struct StrokeGeometry { pub path:Option<VectorPath>, pub path_length:f64, pub visible_centerline_length:f64, pub components:usize }
fn distance(p:P,a:P,b:P)->f64 {let d=b.sub(a);let l=d.x*d.x+d.y*d.y; if l<1e-20 {return p.sub(a).length();}
    let t=((p.x-a.x)*d.x+(p.y-a.y)*d.y)/l; p.sub(a.lerp(b,t.clamp(0.0,1.0))).length() }
fn push(points:&mut Vec<P>,p:P)->Result<(),String>{
    if points.last().is_some_and(|last|last.sub(p).length()<1e-10) {return Ok(());}
    if points.len()>=MAX_POINTS {return Err("stroke flattened point budget exceeded".into());} points.push(p); Ok(())
}
fn quad(points:&mut Vec<P>,a:P,c:P,b:P,tol:f64,depth:u32)->Result<(),String>{
    if distance(c,a,b)<=tol && a.sub(c).length()+c.sub(b).length()-a.sub(b).length()<=tol {return push(points,b);}
    if depth>=18 {return Err("stroke curve exceeds flattening depth".into());}
    let ac=a.lerp(c,0.5);let cb=c.lerp(b,0.5);let m=ac.lerp(cb,0.5);
    quad(points,a,ac,m,tol,depth+1)?;quad(points,m,cb,b,tol,depth+1)
}
fn cubic(points:&mut Vec<P>,a:P,c1:P,c2:P,b:P,tol:f64,depth:u32)->Result<(),String>{
    let excess=a.sub(c1).length()+c1.sub(c2).length()+c2.sub(b).length()-a.sub(b).length();
    if distance(c1,a,b).max(distance(c2,a,b))<=tol && excess<=tol {return push(points,b);}
    if depth>=18 {return Err("stroke curve exceeds flattening depth".into());}
    let a1=a.lerp(c1,0.5);let c12=c1.lerp(c2,0.5);let c2b=c2.lerp(b,0.5);
    let l=a1.lerp(c12,0.5);let r=c12.lerp(c2b,0.5);let m=l.lerp(r,0.5);
    cubic(points,a,a1,l,m,tol,depth+1)?;cubic(points,m,r,c2b,b,tol,depth+1)
}
fn finish(points:&mut Vec<P>,closed:bool,contours:&mut Vec<Contour>,total:&mut f64,count:&mut usize)->Result<(),String>{
    if points.len()<2 {return Err("stroke contour has no length".into());}
    if closed {let first=points[0];push(points,first)?;}
    let mut distances=vec![0.0];let mut length=0.0;
    for pair in points.windows(2) {length+=pair[1].sub(pair[0]).length();distances.push(length);}
    if !length.is_finite() || length<1e-6 || *total+length>10_000_000.0 {return Err("stroke length budget invalid".into());}
    *count+=points.len();if *count>MAX_POINTS || contours.len()>=256 {return Err("stroke contour/point budget exceeded".into());}
    contours.push(Contour{points:std::mem::take(points),distances,start:*total,length,closed});*total+=length;Ok(())
}
impl PreparedStroke {
    pub fn prepare(commands:&[PathCommand],max_scale:f32)->Result<Self,String>{
        if commands.is_empty() || commands.len()>MAX_INPUT_COMMANDS || !max_scale.is_finite() || !(1.0..=32.0).contains(&max_scale) {return Err("stroke input/zoom budget invalid".into());}
        let tolerance=0.20/max_scale as f64;let mut contours=Vec::new();let mut points=Vec::new();let mut length=0.0;let mut count=0;
        for command in commands {match *command {
            PathCommand::M{x,y}=>{if !points.is_empty(){finish(&mut points,false,&mut contours,&mut length,&mut count)?;}push(&mut points,P::from(x,y)?)?;},
            PathCommand::L{x,y}=>{if points.is_empty(){return Err("stroke line without move".into());}push(&mut points,P::from(x,y)?)?;},
            PathCommand::Q{x1,y1,x,y}=>{let a=*points.last().ok_or("stroke curve without move")?;quad(&mut points,a,P::from(x1,y1)?,P::from(x,y)?,tolerance,0)?;},
            PathCommand::C{x1,y1,x2,y2,x,y}=>{let a=*points.last().ok_or("stroke curve without move")?;cubic(&mut points,a,P::from(x1,y1)?,P::from(x2,y2)?,P::from(x,y)?,tolerance,0)?;},
            PathCommand::Z=>{if points.is_empty(){return Err("stroke close without move".into());}finish(&mut points,true,&mut contours,&mut length,&mut count)?;}
        }}
        if !points.is_empty(){finish(&mut points,false,&mut contours,&mut length,&mut count)?;}
        Ok(Self{contours,length,tolerance,max_scale,points:count})
    }
    pub fn path_length(&self)->f64 {self.length}
    pub fn flattened_points(&self)->usize {self.points}
    pub fn max_scale(&self)->f32 {self.max_scale}
    pub fn expand(&self,style:&StrokeStyle)->Result<StrokeGeometry,String>{
        validate_style(style)?;let mut dash=style.dash.clone();if dash.len()%2==1 {let second=dash.clone();dash.extend(second);}
        let period:f64=dash.iter().sum();let lo=style.trim_start*self.length;let hi=style.trim_end*self.length;
        let mut out=Outline{commands:Vec::new(),tolerance:self.tolerance};let mut components=0;let mut visible=0.0;
        if hi<=lo {return Ok(StrokeGeometry{path:None,path_length:self.length,visible_centerline_length:0.0,components:0});}
        for c in &self.contours {
            let a=lo.max(c.start);let b=hi.min(c.start+c.length);if b<=a {continue;}
            let mut ranges=Vec::new();
            if dash.is_empty(){ranges.push((a-c.start,b-c.start));}
            else {
                let mut x=a;let mut phase=(a+style.dash_offset).rem_euclid(period);let mut i=0;
                while i+1<dash.len() && phase>=dash[i] {phase-=dash[i];i+=1;}
                let mut remaining=dash[i]-phase;
                while x<b-1e-9 {
                    let end=(x+remaining).min(b);if end<=x {return Err("dash step is not representable".into());}
                    if i%2==0 {ranges.push((x-c.start,end-c.start));if ranges.len()+components>MAX_COMPONENTS{return Err("stroke component budget exceeded".into());}}
                    x=end;i=(i+1)%dash.len();remaining=dash[i];
                }
            }
            // A continuous on interval crossing a closed seam has a join, not two caps.
            let merge=c.closed && a==c.start && b==c.start+c.length && ranges.len()>1
                && ranges[0].0==0.0 && (ranges.last().unwrap().1-c.length).abs()<1e-8;
            if merge {
                let last=ranges.pop().unwrap();let first=ranges.remove(0);
                let mut p=extract(c,last.0,last.1);let mut q=extract(c,first.0,first.1);q.remove(0);p.extend(q);
                out.stroke(&p,false,style)?;visible+=last.1-last.0+first.1-first.0;components+=1;
            }
            for (from,to) in ranges {
                components+=1;if components>MAX_COMPONENTS{return Err("stroke component budget exceeded".into());}
                let p=extract(c,from,to);let closed=c.closed && from==0.0 && (to-c.length).abs()<1e-8;
                out.stroke(&p,closed,style)?;visible+=to-from;
            }
        }
        Ok(StrokeGeometry{path:if out.commands.is_empty(){None}else{Some(VectorPath{commands:out.commands,fill_rule:FillRule::NonZero})},path_length:self.length,visible_centerline_length:visible,components})
    }
}
fn validate_style(s:&StrokeStyle)->Result<(),String>{
    if !s.width.is_finite() || !(0.25..=256.0).contains(&s.width) || !s.miter_limit.is_finite() || !(1.0..=16.0).contains(&s.miter_limit)
        || !s.trim_start.is_finite() || !s.trim_end.is_finite() || !(0.0..=1.0).contains(&s.trim_start) || !(s.trim_start..=1.0).contains(&s.trim_end)
        || s.dash.len()>16 || s.dash.iter().any(|v|!v.is_finite() || !(0.5..=1_000_000.0).contains(v))
        || !s.dash_offset.is_finite() || s.dash_offset.abs()>1_000_000.0 {return Err("stroke style invalid or over budget".into());}Ok(())
}
fn at(c:&Contour,d:f64)->P{
    if d<=0.0 {return c.points[0];}if d>=c.length{return *c.points.last().unwrap();}
    let i=c.distances.partition_point(|v|*v<d).clamp(1,c.points.len()-1);
    c.points[i-1].lerp(c.points[i],(d-c.distances[i-1])/(c.distances[i]-c.distances[i-1]))
}
fn extract(c:&Contour,from:f64,to:f64)->Vec<P>{
    let mut p=vec![at(c,from)];let start=c.distances.partition_point(|d|*d<=from);let end=c.distances.partition_point(|d|*d<to);
    p.extend_from_slice(&c.points[start..end]);let last=at(c,to);if p.last().unwrap().sub(last).length()>1e-10{p.push(last);}p
}
struct Outline{commands:Vec<PathCommand>,tolerance:f64}
impl Outline {
    fn polygon(&mut self,points:&[P])->Result<(),String>{
        let area: f64=points.iter().zip(points.iter().cycle().skip(1)).take(points.len()).map(|(a,b)|a.cross(*b)).sum();
        if area.abs()<1e-10 {return Ok(());}
        if self.commands.len()+points.len()+1>MAX_OUTPUT_COMMANDS {return Err("stroke output command budget exceeded".into());}
        let order:Vec<P>=if area>0.0{points.to_vec()}else{points.iter().rev().copied().collect()};
        for (i,p) in order.iter().enumerate(){let q=Point{x:p.x as f32,y:p.y as f32};
            if !q.x.is_finite() || !q.y.is_finite() || q.x.abs()>1_000_000.0 || q.y.abs()>1_000_000.0{return Err("expanded stroke coordinate exceeds native limit".into());}
            self.commands.push(if i==0{PathCommand::M{x:q.x,y:q.y}}else{PathCommand::L{x:q.x,y:q.y}});
        }self.commands.push(PathCommand::Z);Ok(())
    }
    fn disk(&mut self,p:P,r:f64)->Result<(),String>{
        let angle=(1.0-(self.tolerance/r).min(0.5)).acos();let n=(std::f64::consts::PI/angle).ceil().max(12.0) as usize;
        if n>1024{return Err("stroke round tessellation budget exceeded".into());}
        let points:Vec<P>=(0..n).map(|i|{let a=i as f64*std::f64::consts::TAU/n as f64;p.add(P{x:a.cos()*r,y:a.sin()*r})}).collect();self.polygon(&points)
    }
    fn join(&mut self,p:P,u:P,v:P,r:f64,s:&StrokeStyle)->Result<(),String>{
        if s.join==StrokeJoin::Round {return self.disk(p,r);}
        let cross=u.cross(v);if cross.abs()<1e-10 {return Ok(());}
        let sign=if cross>0.0{-1.0}else{1.0};let a=p.add(u.normal().mul(r*sign));let b=p.add(v.normal().mul(r*sign));
        if s.join==StrokeJoin::Miter {
            let t=b.sub(a).cross(v)/cross;let m=a.add(u.mul(t));
            if m.sub(p).length()<=r*s.miter_limit as f64 {return self.polygon(&[p,a,m,b]);}
        }self.polygon(&[p,a,b])
    }
    fn stroke(&mut self,points:&[P],closed:bool,s:&StrokeStyle)->Result<(),String>{
        if points.len()<2{return Ok(());}let r=s.width as f64*0.5;
        let directions:Vec<P>=points.windows(2).map(|v|v[1].sub(v[0]).mul(1.0/v[1].sub(v[0]).length())).collect();
        for (i,pair) in points.windows(2).enumerate(){let n=directions[i].normal().mul(r);self.polygon(&[pair[0].add(n),pair[1].add(n),pair[1].sub(n),pair[0].sub(n)])?;}
        for i in 1..points.len()-1 {self.join(points[i],directions[i-1],directions[i],r,s)?;}
        if closed {self.join(points[0],*directions.last().unwrap(),directions[0],r,s)?;}
        else {match s.cap {
            StrokeCap::Butt=>{},
            StrokeCap::Round=>{self.disk(points[0],r)?;self.disk(*points.last().unwrap(),r)?;},
            StrokeCap::Square=>{for(p,u)in [(points[0],directions[0].mul(-1.0)),(*points.last().unwrap(),*directions.last().unwrap())]{let n=u.normal().mul(r);self.polygon(&[p.add(n),p.add(u.mul(r)).add(n),p.add(u.mul(r)).sub(n),p.sub(n)])?;}}
        }}Ok(())
    }
}
