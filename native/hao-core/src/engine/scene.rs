use std::collections::{HashMap, HashSet};

use super::composite::{FloatFrame, LinearRgba, composite_pixel};
use super::model::BlendMode;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Vec3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

impl Vec3 {
    pub fn new(value: [f32; 3]) -> Self {
        Self {
            x: value[0],
            y: value[1],
            z: value[2],
        }
    }
    pub fn add(self, right: Self) -> Self {
        Self {
            x: self.x + right.x,
            y: self.y + right.y,
            z: self.z + right.z,
        }
    }
    pub fn sub(self, right: Self) -> Self {
        Self {
            x: self.x - right.x,
            y: self.y - right.y,
            z: self.z - right.z,
        }
    }
    pub fn mul(self, value: f32) -> Self {
        Self {
            x: self.x * value,
            y: self.y * value,
            z: self.z * value,
        }
    }
    pub fn dot(self, right: Self) -> f32 {
        self.x * right.x + self.y * right.y + self.z * right.z
    }
    pub fn cross(self, right: Self) -> Self {
        Self {
            x: self.y * right.z - self.z * right.y,
            y: self.z * right.x - self.x * right.z,
            z: self.x * right.y - self.y * right.x,
        }
    }
    pub fn normalized(self) -> Result<Self, String> {
        let length = self.dot(self).sqrt();
        if !length.is_finite() || length <= 0.000001 {
            return Err("cannot normalize zero vector".into());
        }
        Ok(self.mul(1.0 / length))
    }
}

#[derive(Clone, Copy, Debug)]
pub struct CameraProjection {
    pub position: Vec3,
    pub target: Vec3,
    pub up: Vec3,
    pub vertical_fov: f32,
    pub aspect: f32,
    pub near: f32,
    pub far: f32,
}

impl CameraProjection {
    pub fn project(&self, point: Vec3) -> Result<Option<[f32; 3]>, String> {
        if !self.vertical_fov.is_finite()
            || !self.aspect.is_finite()
            || !self.near.is_finite()
            || !self.far.is_finite()
            || self.aspect <= 0.0
            || self.near <= 0.0
            || self.far <= self.near
        {
            return Err("invalid camera projection".into());
        }
        let forward = self.target.sub(self.position).normalized()?;
        let right = forward.cross(self.up).normalized()?;
        let up = right.cross(forward).normalized()?;
        let local = point.sub(self.position);
        let depth = local.dot(forward);
        if depth < self.near || depth > self.far {
            return Ok(None);
        }
        let tangent = (self.vertical_fov * 0.5).tan();
        let ndc_x = local.dot(right) / (depth * tangent * self.aspect);
        let ndc_y = local.dot(up) / (depth * tangent);
        Ok(Some([
            ndc_x,
            ndc_y,
            (depth - self.near) / (self.far - self.near),
        ]))
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Particle {
    pub position: Vec3,
    pub velocity: Vec3,
    pub age: f32,
    pub lifetime: f32,
}

fn random01(state: &mut u64) -> f32 {
    *state = state
        .wrapping_mul(6364136223846793005)
        .wrapping_add(1442695040888963407);
    ((*state >> 40) as u32) as f32 / (1_u32 << 24) as f32
}

pub fn simulate_particles(
    seed: u64,
    rate: f32,
    lifetime: f32,
    initial_velocity: Vec3,
    gravity: Vec3,
    time: f32,
    max_particles: usize,
) -> Result<Vec<Particle>, String> {
    if !rate.is_finite()
        || !lifetime.is_finite()
        || !time.is_finite()
        || rate < 0.0
        || lifetime <= 0.0
        || time < 0.0
        || max_particles == 0
    {
        return Err("invalid particle simulation".into());
    }
    let count = ((rate * time).floor() as usize).min(max_particles);
    let mut state = seed;
    let mut particles = Vec::with_capacity(count);
    for index in 0..count {
        let birth = index as f32 / rate.max(0.0001);
        let age = time - birth;
        if age < 0.0 || age > lifetime {
            continue;
        }
        let jitter = Vec3 {
            x: random01(&mut state) - 0.5,
            y: random01(&mut state) - 0.5,
            z: random01(&mut state) - 0.5,
        };
        let velocity = initial_velocity.add(jitter);
        let position = velocity.mul(age).add(gravity.mul(0.5 * age * age));
        particles.push(Particle {
            position,
            velocity: velocity.add(gravity.mul(age)),
            age,
            lifetime,
        });
    }
    Ok(particles)
}

pub fn shutter_sample_times(
    frame_time: f64,
    frame_duration: f64,
    shutter_angle: f64,
    samples: usize,
) -> Result<Vec<f64>, String> {
    if !frame_time.is_finite()
        || !frame_duration.is_finite()
        || !shutter_angle.is_finite()
        || frame_duration <= 0.0
        || !(0.0..=720.0).contains(&shutter_angle)
        || !(1..=64).contains(&samples)
    {
        return Err("invalid shutter sampling".into());
    }
    let interval = frame_duration * shutter_angle / 360.0;
    let start = frame_time - interval * 0.5;
    Ok((0..samples)
        .map(|index| start + interval * (index as f64 + 0.5) / samples as f64)
        .collect())
}

#[derive(Clone, Debug)]
pub struct SceneLayer {
    pub id: String,
    pub parent: Option<String>,
    pub position: Vec3,
    pub rotation: Vec3,
    pub scale: Vec3,
    pub size: [f32; 2],
    pub color: LinearRgba,
    pub blend_mode: BlendMode,
    pub opacity: f32,
}

#[derive(Clone, Copy, Debug)]
pub struct DirectionalLight {
    pub direction: Vec3,
    pub color: [f32; 3],
    pub intensity: f32,
}

/// Camera-space projection shared by the deterministic CPU oracle and the native GPU
/// compositor. `screen_corners` follow the source corner order (top-left, top-right,
/// bottom-right, bottom-left) in output pixels. `depth_plane` evaluates D3D/WGPU depth from
/// normalized top-left screen coordinates: `z = a * u + b * v + c`. A plane crossing the
/// near/far clip boundary or producing degenerate screen geometry fails closed.
#[derive(Clone, Debug, PartialEq)]
pub struct ScenePlaneProjection {
    pub id: String,
    pub screen_corners: [[f32; 2]; 4],
    pub average_depth: f32,
    pub depth_plane: [f32; 3],
    pub shade: [f32; 3],
}

#[derive(Clone, Copy, Debug)]
struct Mat4([[f32; 4]; 4]);

impl Mat4 {
    fn identity() -> Self {
        Self([
            [1.0, 0.0, 0.0, 0.0],
            [0.0, 1.0, 0.0, 0.0],
            [0.0, 0.0, 1.0, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ])
    }
    fn mul(self, right: Self) -> Self {
        let mut result = [[0.0; 4]; 4];
        for row in 0..4 {
            for column in 0..4 {
                result[row][column] = (0..4)
                    .map(|index| self.0[row][index] * right.0[index][column])
                    .sum();
            }
        }
        Self(result)
    }
    fn point(self, point: Vec3) -> Vec3 {
        Vec3 {
            x: self.0[0][0] * point.x
                + self.0[0][1] * point.y
                + self.0[0][2] * point.z
                + self.0[0][3],
            y: self.0[1][0] * point.x
                + self.0[1][1] * point.y
                + self.0[1][2] * point.z
                + self.0[1][3],
            z: self.0[2][0] * point.x
                + self.0[2][1] * point.y
                + self.0[2][2] * point.z
                + self.0[2][3],
        }
    }
    fn vector(self, vector: Vec3) -> Vec3 {
        self.point(vector)
            .sub(self.point(Vec3::new([0.0, 0.0, 0.0])))
    }
}

fn layer_matrix(layer: &SceneLayer) -> Result<Mat4, String> {
    if [
        layer.position.x,
        layer.position.y,
        layer.position.z,
        layer.rotation.x,
        layer.rotation.y,
        layer.rotation.z,
        layer.scale.x,
        layer.scale.y,
        layer.scale.z,
        layer.size[0],
        layer.size[1],
        layer.opacity,
    ]
    .iter()
    .any(|v| !v.is_finite())
        || layer.scale.x.abs() <= 1.0e-6
        || layer.scale.y.abs() <= 1.0e-6
        || layer.scale.z.abs() <= 1.0e-6
        || layer.size[0] <= 0.0
        || layer.size[1] <= 0.0
        || !(0.0..=1.0).contains(&layer.opacity)
    {
        return Err(format!("invalid transform for scene layer {}", layer.id));
    }
    let (sx, cx) = layer.rotation.x.sin_cos();
    let (sy, cy) = layer.rotation.y.sin_cos();
    let (sz, cz) = layer.rotation.z.sin_cos();
    let scale = Mat4([
        [layer.scale.x, 0.0, 0.0, 0.0],
        [0.0, layer.scale.y, 0.0, 0.0],
        [0.0, 0.0, layer.scale.z, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ]);
    let rx = Mat4([
        [1.0, 0.0, 0.0, 0.0],
        [0.0, cx, -sx, 0.0],
        [0.0, sx, cx, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ]);
    let ry = Mat4([
        [cy, 0.0, sy, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [-sy, 0.0, cy, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ]);
    let rz = Mat4([
        [cz, -sz, 0.0, 0.0],
        [sz, cz, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ]);
    let translation = Mat4([
        [1.0, 0.0, 0.0, layer.position.x],
        [0.0, 1.0, 0.0, layer.position.y],
        [0.0, 0.0, 1.0, layer.position.z],
        [0.0, 0.0, 0.0, 1.0],
    ]);
    Ok(translation.mul(rz).mul(ry).mul(rx).mul(scale))
}

fn world_matrix<'a>(
    id: &'a str,
    layers: &HashMap<&'a str, &'a SceneLayer>,
    visiting: &mut HashSet<&'a str>,
    cache: &mut HashMap<&'a str, Mat4>,
) -> Result<Mat4, String> {
    if let Some(matrix) = cache.get(id) {
        return Ok(*matrix);
    }
    if !visiting.insert(id) {
        return Err(format!("scene parent cycle at {id}"));
    }
    let layer = layers
        .get(id)
        .ok_or_else(|| format!("unknown scene layer {id}"))?;
    let local = layer_matrix(layer)?;
    let world = match layer.parent.as_deref() {
        Some(parent) => world_matrix(parent, layers, visiting, cache)?.mul(local),
        None => Mat4::identity().mul(local),
    };
    visiting.remove(id);
    cache.insert(id, world);
    Ok(world)
}

fn edge(a: [f32; 2], b: [f32; 2], p: [f32; 2]) -> f32 {
    (p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])
}

fn d3d_depth_from_linear_camera_depth(
    linear_depth: f32,
    near: f32,
    far: f32,
) -> Result<f32, String> {
    let camera_depth = near + linear_depth * (far - near);
    let depth = far / (far - near) - (far * near) / ((far - near) * camera_depth);
    if !depth.is_finite() || !(0.0..=1.0).contains(&depth) {
        return Err("projected plane produced invalid depth32 value".into());
    }
    Ok(depth)
}

fn solve_normalized_depth_plane(
    screen: [[f32; 2]; 4],
    depth: [f32; 4],
    width: u32,
    height: u32,
) -> Result<[f32; 3], String> {
    let points = std::array::from_fn::<_, 4, _>(|index| {
        [
            screen[index][0] as f64 / width as f64,
            screen[index][1] as f64 / height as f64,
            depth[index] as f64,
        ]
    });
    let [u0, v0, z0] = points[0];
    let [u1, v1, z1] = points[1];
    let [u2, v2, z2] = points[2];
    let determinant = u0 * (v1 - v2) + u1 * (v2 - v0) + u2 * (v0 - v1);
    if determinant.abs() < 1.0e-10 {
        return Err("projected plane is screen-space degenerate".into());
    }
    let a = (z0 * (v1 - v2) + z1 * (v2 - v0) + z2 * (v0 - v1)) / determinant;
    let b = (z0 * (u2 - u1) + z1 * (u0 - u2) + z2 * (u1 - u0)) / determinant;
    let c = (z0 * (u1 * v2 - u2 * v1) + z1 * (u2 * v0 - u0 * v2) + z2 * (u0 * v1 - u1 * v0))
        / determinant;
    if [a, b, c].iter().any(|value| !value.is_finite())
        || points
            .iter()
            .any(|[u, v, z]| (a * u + b * v + c - z).abs() > 2.0e-5)
    {
        return Err("projected plane does not produce one stable screen-space depth plane".into());
    }
    Ok([a as f32, b as f32, c as f32])
}

/// Projects a closed 2.5D plane scene without rasterizing it. This is the geometry oracle
/// used by the wgpu executor: parent matrices, camera math and Lambert lighting remain in
/// one native implementation while pixel sampling/compositing stays on the GPU.
pub fn project_2_5d_scene_planes(
    width: u32,
    height: u32,
    camera: CameraProjection,
    layers: &[SceneLayer],
    ambient: f32,
    lights: &[DirectionalLight],
) -> Result<Vec<ScenePlaneProjection>, String> {
    if width == 0 || height == 0 || !ambient.is_finite() || ambient < 0.0 || layers.is_empty() {
        return Err("invalid 2.5D scene".into());
    }
    let by_id: HashMap<&str, &SceneLayer> = layers
        .iter()
        .map(|layer| (layer.id.as_str(), layer))
        .collect();
    if by_id.len() != layers.len() {
        return Err("duplicate scene layer id".into());
    }
    for light in lights {
        if light.direction.normalized().is_err()
            || !light.intensity.is_finite()
            || light.intensity < 0.0
            || light
                .color
                .iter()
                .any(|value| !value.is_finite() || *value < 0.0)
        {
            return Err("invalid scene light".into());
        }
    }
    let mut matrices = HashMap::new();
    for layer in layers {
        world_matrix(
            layer.id.as_str(),
            &by_id,
            &mut HashSet::new(),
            &mut matrices,
        )?;
    }
    layers
        .iter()
        .map(|layer| {
            let matrix = matrices[layer.id.as_str()];
            let corners = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(|xy| {
                matrix.point(Vec3::new([
                    xy[0] * layer.size[0],
                    xy[1] * layer.size[1],
                    0.0,
                ]))
            });
            let projected = corners
                .map(|point| camera.project(point))
                .into_iter()
                .collect::<Result<Vec<_>, _>>()?;
            if projected.iter().any(Option::is_none) {
                return Err(format!(
                    "scene layer {} clips the camera near/far plane",
                    layer.id
                ));
            }
            let projected: Vec<[f32; 3]> = projected.into_iter().flatten().collect();
            let screen_corners = std::array::from_fn(|index| {
                let point = projected[index];
                [
                    ((point[0] + 1.0) * 0.5) * width as f32,
                    ((1.0 - point[1]) * 0.5) * height as f32,
                ]
            });
            let depth_values = [
                d3d_depth_from_linear_camera_depth(projected[0][2], camera.near, camera.far)?,
                d3d_depth_from_linear_camera_depth(projected[1][2], camera.near, camera.far)?,
                d3d_depth_from_linear_camera_depth(projected[2][2], camera.near, camera.far)?,
                d3d_depth_from_linear_camera_depth(projected[3][2], camera.near, camera.far)?,
            ];
            let depth_plane =
                solve_normalized_depth_plane(screen_corners, depth_values, width, height)?;
            let normal = matrix.vector(Vec3::new([0.0, 0.0, -1.0])).normalized()?;
            let mut shade = [ambient; 3];
            for light in lights {
                let lambert =
                    normal.dot(light.direction.normalized()?.mul(-1.0)).max(0.0) * light.intensity;
                for channel in 0..3 {
                    shade[channel] += lambert * light.color[channel];
                }
            }
            if shade.iter().any(|value| !value.is_finite()) {
                return Err(format!(
                    "scene layer {} produced invalid lighting",
                    layer.id
                ));
            }
            Ok(ScenePlaneProjection {
                id: layer.id.clone(),
                screen_corners,
                average_depth: projected.iter().map(|point| point[2]).sum::<f32>() / 4.0,
                depth_plane,
                shade,
            })
        })
        .collect()
}

/// Native deterministic 2.5D raster reference: parent transforms, camera projection,
/// z-buffering, directional/ambient light and the same premultiplied blend contract.
pub fn render_2_5d_scene(
    width: u32,
    height: u32,
    camera: CameraProjection,
    layers: &[SceneLayer],
    ambient: f32,
    lights: &[DirectionalLight],
) -> Result<(FloatFrame, Vec<f32>), String> {
    if width == 0 || height == 0 || !ambient.is_finite() || ambient < 0.0 || layers.is_empty() {
        return Err("invalid 2.5D scene".into());
    }
    let projections = project_2_5d_scene_planes(width, height, camera, layers, ambient, lights)?
        .into_iter()
        .map(|projection| (projection.id.clone(), projection))
        .collect::<HashMap<_, _>>();
    let mut output = FloatFrame::transparent(width, height)?;
    let mut depth = vec![f32::INFINITY; width as usize * height as usize];
    for layer in layers {
        let projection = projections
            .get(&layer.id)
            .ok_or_else(|| format!("missing projected scene plane {}", layer.id))?;
        let screen = projection.screen_corners;
        let min_x = screen
            .iter()
            .map(|p| p[0])
            .fold(f32::INFINITY, f32::min)
            .floor()
            .max(0.0) as u32;
        let max_x = screen
            .iter()
            .map(|p| p[0])
            .fold(f32::NEG_INFINITY, f32::max)
            .ceil()
            .min(width as f32) as u32;
        let min_y = screen
            .iter()
            .map(|p| p[1])
            .fold(f32::INFINITY, f32::min)
            .floor()
            .max(0.0) as u32;
        let max_y = screen
            .iter()
            .map(|p| p[1])
            .fold(f32::NEG_INFINITY, f32::max)
            .ceil()
            .min(height as f32) as u32;
        let source = LinearRgba {
            r: layer.color.r * projection.shade[0],
            g: layer.color.g * projection.shade[1],
            b: layer.color.b * projection.shade[2],
            a: layer.color.a,
        }
        .clamped()
        .premultiplied();
        for y in min_y..max_y {
            for x in min_x..max_x {
                let p = [x as f32 + 0.5, y as f32 + 0.5];
                let triangle = |a: usize, b: usize, c: usize| {
                    let e0 = edge(screen[a], screen[b], p);
                    let e1 = edge(screen[b], screen[c], p);
                    let e2 = edge(screen[c], screen[a], p);
                    (e0 >= 0.0 && e1 >= 0.0 && e2 >= 0.0) || (e0 <= 0.0 && e1 <= 0.0 && e2 <= 0.0)
                };
                if !(triangle(0, 1, 2) || triangle(0, 2, 3)) {
                    continue;
                }
                let z = (projection.depth_plane[0] * p[0] / width as f32
                    + projection.depth_plane[1] * p[1] / height as f32
                    + projection.depth_plane[2])
                    .clamp(0.0, 1.0);
                let index = y as usize * width as usize + x as usize;
                if z <= depth[index] {
                    output.pixels[index] = composite_pixel(
                        output.pixels[index],
                        source,
                        layer.blend_mode,
                        layer.opacity,
                        1.0,
                    )?;
                    depth[index] = z;
                }
            }
        }
    }
    output.validate()?;
    Ok((output, depth))
}

pub fn draw_particles(
    frame: &mut FloatFrame,
    camera: CameraProjection,
    particles: &[Particle],
    color: LinearRgba,
    radius: u32,
) -> Result<usize, String> {
    frame.validate()?;
    if radius == 0 || radius > 128 {
        return Err("invalid particle radius".into());
    }
    let source = color.clamped().premultiplied();
    let mut visible = 0;
    for particle in particles {
        let Some(point) = camera.project(particle.position)? else {
            continue;
        };
        let cx = ((point[0] + 1.0) * 0.5 * frame.width as f32).round() as i32;
        let cy = ((1.0 - point[1]) * 0.5 * frame.height as f32).round() as i32;
        for oy in -(radius as i32)..=radius as i32 {
            for ox in -(radius as i32)..=radius as i32 {
                if ox * ox + oy * oy > (radius * radius) as i32 {
                    continue;
                }
                let x = cx + ox;
                let y = cy + oy;
                if x < 0 || y < 0 || x >= frame.width as i32 || y >= frame.height as i32 {
                    continue;
                }
                let index = y as usize * frame.width as usize + x as usize;
                frame.pixels[index] =
                    composite_pixel(frame.pixels[index], source, BlendMode::Normal, 1.0, 1.0)?;
            }
        }
        visible += 1;
    }
    frame.validate()?;
    Ok(visible)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn crossing_camera() -> CameraProjection {
        CameraProjection {
            position: Vec3::new([0.0, 0.0, 4.0]),
            target: Vec3::new([0.0, 0.0, 0.0]),
            up: Vec3::new([0.0, 1.0, 0.0]),
            vertical_fov: 1.0,
            aspect: 2.0,
            near: 0.1,
            far: 20.0,
        }
    }

    fn crossing_layer(id: &str, rotation_y: f32, color: LinearRgba) -> SceneLayer {
        SceneLayer {
            id: id.into(),
            parent: None,
            position: Vec3::new([0.0, 0.0, 0.0]),
            rotation: Vec3::new([0.0, rotation_y, 0.0]),
            scale: Vec3::new([1.0, 1.0, 1.0]),
            size: [3.2, 2.0],
            color,
            blend_mode: BlendMode::Normal,
            opacity: 1.0,
        }
    }

    #[test]
    fn crossing_opaque_planes_are_per_pixel_depth_tested_and_order_independent() {
        let red = crossing_layer(
            "red",
            35.0_f32.to_radians(),
            LinearRgba::new(1.0, 0.0, 0.0, 1.0).unwrap(),
        );
        let blue = crossing_layer(
            "blue",
            -35.0_f32.to_radians(),
            LinearRgba::new(0.0, 0.0, 1.0, 1.0).unwrap(),
        );
        let (forward, forward_depth) = render_2_5d_scene(
            160,
            80,
            crossing_camera(),
            &[red.clone(), blue.clone()],
            1.0,
            &[],
        )
        .unwrap();
        let (reversed, reversed_depth) =
            render_2_5d_scene(160, 80, crossing_camera(), &[blue, red], 1.0, &[]).unwrap();

        assert_eq!(forward.pixels, reversed.pixels);
        assert_eq!(forward_depth, reversed_depth);
        let left = forward.pixels[40 * 160 + 55];
        let right = forward.pixels[40 * 160 + 104];
        assert!(left.r > 0.9 && left.b < 0.1, "left ownership was {left:?}");
        assert!(
            right.b > 0.9 && right.r < 0.1,
            "right ownership was {right:?}"
        );

        let projected = project_2_5d_scene_planes(
            160,
            80,
            crossing_camera(),
            &[
                crossing_layer(
                    "red",
                    35.0_f32.to_radians(),
                    LinearRgba::new(1.0, 0.0, 0.0, 1.0).unwrap(),
                ),
                crossing_layer(
                    "blue",
                    -35.0_f32.to_radians(),
                    LinearRgba::new(0.0, 0.0, 1.0, 1.0).unwrap(),
                ),
            ],
            1.0,
            &[],
        )
        .unwrap();
        let depth_at = |plane: &ScenePlaneProjection, u: f32, v: f32| {
            plane.depth_plane[0] * u + plane.depth_plane[1] * v + plane.depth_plane[2]
        };
        assert!(depth_at(&projected[0], 0.35, 0.5) < depth_at(&projected[1], 0.35, 0.5));
        assert!(depth_at(&projected[0], 0.65, 0.5) > depth_at(&projected[1], 0.65, 0.5));
    }

    #[test]
    fn edge_on_plane_fails_closed_as_screen_space_degenerate() {
        let edge_on = crossing_layer(
            "edge-on",
            90.0_f32.to_radians(),
            LinearRgba::new(1.0, 1.0, 1.0, 1.0).unwrap(),
        );
        let error = project_2_5d_scene_planes(160, 80, crossing_camera(), &[edge_on], 1.0, &[])
            .unwrap_err();
        assert!(
            error.contains("screen-space degenerate"),
            "unexpected error: {error}"
        );
    }
}
