#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct PlanarPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlanarTrackStatus {
    Manual,
    Tracked,
    Held,
    Lost,
}

impl PlanarTrackStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Manual => "manual",
            Self::Tracked => "tracked",
            Self::Held => "held",
            Self::Lost => "lost",
        }
    }
}

#[derive(Clone, Debug)]
pub struct PlanarObservation {
    pub frame: usize,
    pub quad: [PlanarPoint; 4],
    pub confidence: f64,
    pub status: PlanarTrackStatus,
    pub inliers: usize,
    pub reprojection_error_px: f64,
    pub appearance_correlation: f64,
    pub matches: usize,
    pub global_search: bool,
    pub region_supported: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct PlanarTrackConfig {
    pub confidence_threshold: f64,
    pub max_hold_frames: usize,
    pub search_radius: f64,
}

#[derive(Clone)]
struct ReferenceFeature {
    source: PlanarPoint,
    descriptor: Vec<f64>,
    response: f64,
}

#[derive(Clone)]
struct CandidateFeature {
    point: PlanarPoint,
    descriptors: Vec<Vec<f64>>,
}

#[derive(Clone, Copy)]
struct FeatureMatch {
    source: PlanarPoint,
    destination: PlanarPoint,
    similarity: f64,
}

#[derive(Clone)]
struct HomographyCandidate {
    homography: [f64; 8],
    inliers: Vec<usize>,
    mean_error_px: f64,
    mean_similarity: f64,
    appearance_correlation: f64,
    confidence: f64,
    region_supported: bool,
}

#[derive(Clone, Copy)]
struct RegionAppearanceModel {
    threshold: f64,
    bright_foreground: bool,
    initial_center_x: f64,
    initial_center_y: f64,
    initial_trace: f64,
    initial_angle: f64,
    initial_count: usize,
}

#[derive(Clone, Copy)]
struct RegionMoments {
    center_x: f64,
    center_y: f64,
    trace: f64,
    angle: f64,
    count: usize,
}

struct PlanarTracker {
    width: usize,
    height: usize,
    initial_quad: [PlanarPoint; 4],
    references: Vec<ReferenceFeature>,
    region_model: Option<RegionAppearanceModel>,
    template_points: Vec<(PlanarPoint, f64)>,
    region_template_points: Vec<(PlanarPoint, f64)>,
    homography: [f64; 8],
    failures: usize,
    config: PlanarTrackConfig,
}

const PATCH_RADIUS: i32 = 3;
const MIN_REFERENCES: usize = 8;
const MAX_REFERENCES: usize = 64;
const MAX_GLOBAL_CANDIDATES: usize = 360;

fn region_moments(
    frame: &[u8],
    width: usize,
    bounds: (i32, i32, i32, i32),
    threshold: f64,
    bright_foreground: bool,
) -> Option<RegionMoments> {
    let (min_x, min_y, max_x, max_y) = bounds;
    let mut points = Vec::new();
    for y in min_y.max(0)..=max_y.min(frame.len().saturating_div(width).saturating_sub(1) as i32) {
        for x in min_x.max(0)..=max_x.min(width.saturating_sub(1) as i32) {
            let value = pixel(frame, width, x, y);
            if (bright_foreground && value >= threshold)
                || (!bright_foreground && value <= threshold)
            {
                points.push((x as f64, y as f64));
            }
        }
    }
    if points.len() < 24 {
        return None;
    }
    let center_x = points.iter().map(|point| point.0).sum::<f64>() / points.len() as f64;
    let center_y = points.iter().map(|point| point.1).sum::<f64>() / points.len() as f64;
    let mut xx = 0.0;
    let mut yy = 0.0;
    let mut xy = 0.0;
    for (x, y) in &points {
        let dx = x - center_x;
        let dy = y - center_y;
        xx += dx * dx;
        yy += dy * dy;
        xy += dx * dy;
    }
    xx /= points.len() as f64;
    yy /= points.len() as f64;
    xy /= points.len() as f64;
    Some(RegionMoments {
        center_x,
        center_y,
        trace: xx + yy,
        angle: 0.5 * (2.0 * xy).atan2(xx - yy),
        count: points.len(),
    })
}

fn normalize_half_turn(mut angle: f64) -> f64 {
    while angle > std::f64::consts::FRAC_PI_2 {
        angle -= std::f64::consts::PI;
    }
    while angle < -std::f64::consts::FRAC_PI_2 {
        angle += std::f64::consts::PI;
    }
    angle
}

fn pixel(frame: &[u8], width: usize, x: i32, y: i32) -> f64 {
    frame[y as usize * width + x as usize] as f64
}

fn pixel_mean_3x3(frame: &[u8], width: usize, height: usize, x: i32, y: i32) -> Option<f64> {
    if x < 1 || y < 1 || x >= width as i32 - 1 || y >= height as i32 - 1 {
        return None;
    }
    let mut sum = 0.0;
    for offset_y in -1..=1 {
        for offset_x in -1..=1 {
            sum += pixel(frame, width, x + offset_x, y + offset_y);
        }
    }
    Some(sum / 9.0)
}

fn patch_descriptor(frame: &[u8], width: usize, height: usize, x: i32, y: i32) -> Option<Vec<f64>> {
    patch_descriptor_transformed(frame, width, height, x, y, 1.0, 0.0)
}

fn patch_descriptor_transformed(
    frame: &[u8],
    width: usize,
    height: usize,
    x: i32,
    y: i32,
    scale: f64,
    rotation_radians: f64,
) -> Option<Vec<f64>> {
    let required_radius = (PATCH_RADIUS as f64 * scale * 1.45).ceil() as i32;
    if x < required_radius
        || y < required_radius
        || x >= width as i32 - required_radius
        || y >= height as i32 - required_radius
    {
        return None;
    }
    let side = PATCH_RADIUS * 2 + 1;
    let mut values = Vec::with_capacity((side * side) as usize);
    let cosine = rotation_radians.cos();
    let sine = rotation_radians.sin();
    for offset_y in -PATCH_RADIUS..=PATCH_RADIUS {
        for offset_x in -PATCH_RADIUS..=PATCH_RADIUS {
            let local_x = offset_x as f64 * scale;
            let local_y = offset_y as f64 * scale;
            let sample_x = x + (local_x * cosine - local_y * sine).round() as i32;
            let sample_y = y + (local_x * sine + local_y * cosine).round() as i32;
            values.push(pixel(frame, width, sample_x, sample_y));
        }
    }
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    let norm = values
        .iter()
        .map(|value| (value - mean).powi(2))
        .sum::<f64>()
        .sqrt();
    if norm < 18.0 {
        return None;
    }
    for value in &mut values {
        *value = (*value - mean) / norm;
    }
    Some(values)
}

fn descriptor_similarity(left: &[f64], right: &[f64]) -> f64 {
    left.iter()
        .zip(right)
        .map(|(left, right)| left * right)
        .sum::<f64>()
        .clamp(-1.0, 1.0)
}

fn patch_similarity_offsets(
    frame: &[u8],
    width: usize,
    height: usize,
    x: i32,
    y: i32,
    offsets: &[(i32, i32)],
    required_radius: i32,
    reference: &[f64],
) -> Option<f64> {
    if x < required_radius
        || y < required_radius
        || x >= width as i32 - required_radius
        || y >= height as i32 - required_radius
    {
        return None;
    }
    let mut values = [0.0_f64; 49];
    let mut sum = 0.0;
    let mut sum_squared = 0.0;
    for (index, (offset_x, offset_y)) in offsets.iter().enumerate() {
        let value = pixel(frame, width, x + offset_x, y + offset_y);
        values[index] = value;
        sum += value;
        sum_squared += value * value;
    }
    let count = reference.len() as f64;
    let mean = sum / count;
    let norm = (sum_squared - count * mean * mean).max(0.0).sqrt();
    if norm < 18.0 {
        return None;
    }
    let numerator = reference
        .iter()
        .zip(values)
        .map(|(reference, value)| reference * (value - mean))
        .sum::<f64>();
    Some((numerator / norm).clamp(-1.0, 1.0))
}

fn corner_response(frame: &[u8], width: usize, height: usize, x: i32, y: i32) -> f64 {
    if x < 3 || y < 3 || x >= width as i32 - 3 || y >= height as i32 - 3 {
        return 0.0;
    }
    let mut xx = 0.0;
    let mut yy = 0.0;
    let mut xy = 0.0;
    for offset_y in -2..=2 {
        for offset_x in -2..=2 {
            let sample_x = x + offset_x;
            let sample_y = y + offset_y;
            let gx = pixel(frame, width, sample_x + 1, sample_y)
                - pixel(frame, width, sample_x - 1, sample_y);
            let gy = pixel(frame, width, sample_x, sample_y + 1)
                - pixel(frame, width, sample_x, sample_y - 1);
            xx += gx * gx;
            yy += gy * gy;
            xy += gx * gy;
        }
    }
    let trace = xx + yy;
    let determinant = xx * yy - xy * xy;
    ((trace * trace - 4.0 * determinant)
        .max(0.0)
        .sqrt()
        .mul_add(-1.0, trace)
        * 0.5)
        .max(0.0)
}

fn detect_references(
    frame: &[u8],
    width: usize,
    height: usize,
    quad: [PlanarPoint; 4],
) -> Vec<ReferenceFeature> {
    let min_x = quad
        .iter()
        .map(|point| point.x)
        .fold(f64::INFINITY, f64::min);
    let max_x = quad
        .iter()
        .map(|point| point.x)
        .fold(f64::NEG_INFINITY, f64::max);
    let min_y = quad
        .iter()
        .map(|point| point.y)
        .fold(f64::INFINITY, f64::min);
    let max_y = quad
        .iter()
        .map(|point| point.y)
        .fold(f64::NEG_INFINITY, f64::max);
    let mut candidates = Vec::new();
    let start_x = (min_x * width as f64).ceil() as i32 + PATCH_RADIUS;
    let end_x = (max_x * width as f64).floor() as i32 - PATCH_RADIUS;
    let start_y = (min_y * height as f64).ceil() as i32 + PATCH_RADIUS;
    let end_y = (max_y * height as f64).floor() as i32 - PATCH_RADIUS;
    for y in (start_y..=end_y).step_by(3) {
        for x in (start_x..=end_x).step_by(3) {
            let response = corner_response(frame, width, height, x, y);
            if response < 850.0 {
                continue;
            }
            if let Some(descriptor) = patch_descriptor(frame, width, height, x, y) {
                candidates.push(ReferenceFeature {
                    source: PlanarPoint {
                        x: x as f64 / width as f64,
                        y: y as f64 / height as f64,
                    },
                    descriptor,
                    response,
                });
            }
        }
    }
    candidates.sort_by(|left, right| right.response.total_cmp(&left.response));
    let mut selected: Vec<ReferenceFeature> = Vec::new();
    for candidate in candidates {
        let separated = selected.iter().all(|current| {
            let dx = (current.source.x - candidate.source.x) * width as f64;
            let dy = (current.source.y - candidate.source.y) * height as f64;
            dx * dx + dy * dy >= 36.0
        });
        if separated {
            selected.push(candidate);
            if selected.len() >= MAX_REFERENCES {
                break;
            }
        }
    }
    selected
}

fn detect_global_candidates(frame: &[u8], width: usize, height: usize) -> Vec<CandidateFeature> {
    let mut scored = Vec::new();
    for y in (PATCH_RADIUS..height as i32 - PATCH_RADIUS).step_by(3) {
        for x in (PATCH_RADIUS..width as i32 - PATCH_RADIUS).step_by(3) {
            let response = corner_response(frame, width, height, x, y);
            if response >= 1_100.0 {
                scored.push((response, x, y));
            }
        }
    }
    scored.sort_by(|left, right| right.0.total_cmp(&left.0));
    let mut selected: Vec<CandidateFeature> = Vec::new();
    for (_, x, y) in scored {
        let point = PlanarPoint {
            x: x as f64 / width as f64,
            y: y as f64 / height as f64,
        };
        let separated = selected.iter().all(|current| {
            let dx = (current.point.x - point.x) * width as f64;
            let dy = (current.point.y - point.y) * height as f64;
            dx * dx + dy * dy >= 16.0
        });
        if !separated {
            continue;
        }
        // Reacquisition uses a cheap scale bank. Rotation is handled by the
        // continuous local/region paths, so every global-search frame does not pay
        // for a 20-descriptor orientation grid.
        let descriptors: Vec<Vec<f64>> = [0.8, 1.0, 1.2, 1.4]
            .into_iter()
            .filter_map(|scale| {
                patch_descriptor_transformed(frame, width, height, x, y, scale, 0.0)
            })
            .collect();
        if !descriptors.is_empty() {
            selected.push(CandidateFeature { point, descriptors });
            if selected.len() >= MAX_GLOBAL_CANDIDATES {
                break;
            }
        }
    }
    selected
}

fn project(homography: [f64; 8], point: PlanarPoint) -> Option<PlanarPoint> {
    let denominator = homography[6] * point.x + homography[7] * point.y + 1.0;
    if !denominator.is_finite() || denominator.abs() < 1e-8 {
        return None;
    }
    let projected = PlanarPoint {
        x: (homography[0] * point.x + homography[1] * point.y + homography[2]) / denominator,
        y: (homography[3] * point.x + homography[4] * point.y + homography[5]) / denominator,
    };
    (projected.x.is_finite() && projected.y.is_finite()).then_some(projected)
}

fn homography_rows(feature: FeatureMatch) -> [([f64; 8], f64); 2] {
    let source = feature.source;
    let destination = feature.destination;
    [
        (
            [
                source.x,
                source.y,
                1.0,
                0.0,
                0.0,
                0.0,
                -destination.x * source.x,
                -destination.x * source.y,
            ],
            destination.x,
        ),
        (
            [
                0.0,
                0.0,
                0.0,
                source.x,
                source.y,
                1.0,
                -destination.y * source.x,
                -destination.y * source.y,
            ],
            destination.y,
        ),
    ]
}

fn solve_linear(mut matrix: [[f64; 9]; 8]) -> Option<[f64; 8]> {
    for column in 0..8 {
        let mut pivot = column;
        for row in column + 1..8 {
            if matrix[row][column].abs() > matrix[pivot][column].abs() {
                pivot = row;
            }
        }
        if matrix[pivot][column].abs() < 1e-10 {
            return None;
        }
        matrix.swap(column, pivot);
        let divisor = matrix[column][column];
        for value in column..=8 {
            matrix[column][value] /= divisor;
        }
        for row in 0..8 {
            if row == column {
                continue;
            }
            let factor = matrix[row][column];
            for value in column..=8 {
                matrix[row][value] -= factor * matrix[column][value];
            }
        }
    }
    Some(std::array::from_fn(|index| matrix[index][8]))
}

fn solve_exact(matches: &[FeatureMatch; 4]) -> Option<[f64; 8]> {
    let mut matrix = [[0.0; 9]; 8];
    for (index, feature) in matches.iter().enumerate() {
        for (offset, (row, value)) in homography_rows(*feature).into_iter().enumerate() {
            matrix[index * 2 + offset][..8].copy_from_slice(&row);
            matrix[index * 2 + offset][8] = value;
        }
    }
    solve_linear(matrix)
}

fn solve_least_squares(matches: &[FeatureMatch]) -> Option<[f64; 8]> {
    let mut normal = [[0.0; 9]; 8];
    for feature in matches {
        for (row, value) in homography_rows(*feature) {
            for left in 0..8 {
                normal[left][8] += row[left] * value;
                for right in 0..8 {
                    normal[left][right] += row[left] * row[right];
                }
            }
        }
    }
    for (index, row) in normal.iter_mut().enumerate() {
        row[index] += 1e-9;
    }
    solve_linear(normal)
}

fn reprojection_error_px(
    homography: [f64; 8],
    feature: FeatureMatch,
    width: usize,
    height: usize,
) -> f64 {
    let Some(projected) = project(homography, feature.source) else {
        return f64::INFINITY;
    };
    let dx = (projected.x - feature.destination.x) * width as f64;
    let dy = (projected.y - feature.destination.y) * height as f64;
    (dx * dx + dy * dy).sqrt()
}

fn xorshift(state: &mut u64) -> usize {
    *state ^= *state << 13;
    *state ^= *state >> 7;
    *state ^= *state << 17;
    *state as usize
}

fn ransac(matches: &[FeatureMatch], width: usize, height: usize) -> Option<HomographyCandidate> {
    if matches.len() < 4 {
        return None;
    }
    let mut best_inliers = Vec::new();
    let mut best_error = f64::INFINITY;
    let mut best_homography = None;
    let mut state = 0x8f3c_27d4_a516_90e1_u64 ^ matches.len() as u64;
    let iterations = if matches.len() <= 8 { 96 } else { 320 };
    for iteration in 0..iterations {
        let mut indices = [0_usize; 4];
        if iteration == 0 {
            indices = [0, 1, 2, 3];
        } else {
            for slot in 0..4 {
                let mut attempts = 0;
                loop {
                    let candidate = xorshift(&mut state) % matches.len();
                    if !indices[..slot].contains(&candidate) {
                        indices[slot] = candidate;
                        break;
                    }
                    attempts += 1;
                    if attempts > 32 {
                        break;
                    }
                }
            }
        }
        let sample = indices.map(|index| matches[index]);
        let Some(homography) = solve_exact(&sample) else {
            continue;
        };
        let inliers: Vec<usize> = matches
            .iter()
            .enumerate()
            .filter_map(|(index, feature)| {
                (reprojection_error_px(homography, *feature, width, height) <= 3.25)
                    .then_some(index)
            })
            .collect();
        let mean_error = inliers
            .iter()
            .map(|index| reprojection_error_px(homography, matches[*index], width, height))
            .sum::<f64>()
            / inliers.len().max(1) as f64;
        if inliers.len() > best_inliers.len()
            || (inliers.len() == best_inliers.len() && mean_error < best_error)
        {
            best_inliers = inliers;
            best_error = mean_error;
            best_homography = Some(homography);
        }
    }
    let _ = best_homography?;
    if best_inliers.len() < MIN_REFERENCES.min(matches.len()) {
        return None;
    }
    let inlier_matches: Vec<FeatureMatch> =
        best_inliers.iter().map(|index| matches[*index]).collect();
    let homography = solve_least_squares(&inlier_matches)?;
    let final_inliers: Vec<usize> = matches
        .iter()
        .enumerate()
        .filter_map(|(index, feature)| {
            (reprojection_error_px(homography, *feature, width, height) <= 3.0).then_some(index)
        })
        .collect();
    if final_inliers.len() < MIN_REFERENCES.min(matches.len()) {
        return None;
    }
    let mean_error_px = final_inliers
        .iter()
        .map(|index| reprojection_error_px(homography, matches[*index], width, height))
        .sum::<f64>()
        / final_inliers.len() as f64;
    let mean_similarity = final_inliers
        .iter()
        .map(|index| matches[*index].similarity)
        .sum::<f64>()
        / final_inliers.len() as f64;
    Some(HomographyCandidate {
        homography,
        inliers: final_inliers,
        mean_error_px,
        mean_similarity,
        appearance_correlation: 0.0,
        confidence: 0.0,
        region_supported: false,
    })
}

fn quad_area(quad: [PlanarPoint; 4]) -> f64 {
    (0..4)
        .map(|index| {
            let next = (index + 1) % 4;
            quad[index].x * quad[next].y - quad[next].x * quad[index].y
        })
        .sum::<f64>()
        * 0.5
}

fn edge_length_px(left: PlanarPoint, right: PlanarPoint, width: usize, height: usize) -> f64 {
    let dx = (right.x - left.x) * width as f64;
    let dy = (right.y - left.y) * height as f64;
    (dx * dx + dy * dy).sqrt()
}

fn temporally_continuous_quad(
    previous: [PlanarPoint; 4],
    candidate: [PlanarPoint; 4],
    width: usize,
    height: usize,
    failures: usize,
) -> bool {
    let movements: [f64; 4] = std::array::from_fn(|index| {
        edge_length_px(previous[index], candidate[index], width, height)
    });
    let mean_movement = movements.iter().sum::<f64>() / 4.0;
    let movement_ceiling = 18.0 + failures.min(3) as f64 * 8.0;
    if mean_movement > movement_ceiling
        || movements
            .iter()
            .any(|movement| *movement > movement_ceiling * 1.8)
    {
        return false;
    }
    let area_ratio = quad_area(candidate).abs() / quad_area(previous).abs().max(1e-8);
    if !(0.72..=1.38).contains(&area_ratio) {
        return false;
    }
    (0..4).all(|index| {
        let next = (index + 1) % 4;
        let previous_edge =
            edge_length_px(previous[index], previous[next], width, height).max(1e-6);
        let candidate_edge = edge_length_px(candidate[index], candidate[next], width, height);
        (0.68..=1.48).contains(&(candidate_edge / previous_edge))
    })
}

fn valid_projected_quad(quad: [PlanarPoint; 4], initial_area: f64) -> bool {
    if quad.iter().any(|point| {
        !point.x.is_finite()
            || !point.y.is_finite()
            || point.x < -0.08
            || point.x > 1.08
            || point.y < -0.08
            || point.y > 1.08
    }) {
        return false;
    }
    let cross: [f64; 4] = std::array::from_fn(|index| {
        let next = quad[(index + 1) % 4];
        let after = quad[(index + 2) % 4];
        (next.x - quad[index].x) * (after.y - next.y)
            - (next.y - quad[index].y) * (after.x - next.x)
    });
    if !(cross.iter().all(|value| *value > 1e-6) || cross.iter().all(|value| *value < -1e-6)) {
        return false;
    }
    let area = quad_area(quad).abs();
    area >= initial_area * 0.18 && area <= initial_area * 5.5
}

fn inlier_coverage(
    matches: &[FeatureMatch],
    inliers: &[usize],
    initial_quad: [PlanarPoint; 4],
) -> bool {
    let min_x = inliers
        .iter()
        .map(|index| matches[*index].source.x)
        .fold(f64::INFINITY, f64::min);
    let max_x = inliers
        .iter()
        .map(|index| matches[*index].source.x)
        .fold(f64::NEG_INFINITY, f64::max);
    let min_y = inliers
        .iter()
        .map(|index| matches[*index].source.y)
        .fold(f64::INFINITY, f64::min);
    let max_y = inliers
        .iter()
        .map(|index| matches[*index].source.y)
        .fold(f64::NEG_INFINITY, f64::max);
    let initial_min_x = initial_quad
        .iter()
        .map(|point| point.x)
        .fold(f64::INFINITY, f64::min);
    let initial_max_x = initial_quad
        .iter()
        .map(|point| point.x)
        .fold(f64::NEG_INFINITY, f64::max);
    let initial_min_y = initial_quad
        .iter()
        .map(|point| point.y)
        .fold(f64::INFINITY, f64::min);
    let initial_max_y = initial_quad
        .iter()
        .map(|point| point.y)
        .fold(f64::NEG_INFINITY, f64::max);
    max_x - min_x >= (initial_max_x - initial_min_x) * 0.42
        && max_y - min_y >= (initial_max_y - initial_min_y) * 0.42
}

impl PlanarTracker {
    fn new(
        initial_frame: &[u8],
        width: usize,
        height: usize,
        initial_quad: [PlanarPoint; 4],
        config: PlanarTrackConfig,
    ) -> Result<Self, String> {
        let references = detect_references(initial_frame, width, height, initial_quad);
        if references.len() < MIN_REFERENCES {
            return Err(format!(
                "planar tracker needs at least {MIN_REFERENCES} textured features; found {}",
                references.len()
            ));
        }
        let min_x = initial_quad
            .iter()
            .map(|point| point.x)
            .fold(f64::INFINITY, f64::min);
        let max_x = initial_quad
            .iter()
            .map(|point| point.x)
            .fold(f64::NEG_INFINITY, f64::max);
        let min_y = initial_quad
            .iter()
            .map(|point| point.y)
            .fold(f64::INFINITY, f64::min);
        let max_y = initial_quad
            .iter()
            .map(|point| point.y)
            .fold(f64::NEG_INFINITY, f64::max);
        let bounds = (
            (min_x * width as f64).ceil() as i32,
            (min_y * height as f64).ceil() as i32,
            (max_x * width as f64).floor() as i32,
            (max_y * height as f64).floor() as i32,
        );
        let mut foreground_values = Vec::new();
        let mut background_values = Vec::new();
        for y in bounds.1 - 5..=bounds.3 + 5 {
            for x in bounds.0 - 5..=bounds.2 + 5 {
                if x < 0 || y < 0 || x >= width as i32 || y >= height as i32 {
                    continue;
                }
                let inside = x >= bounds.0 && x <= bounds.2 && y >= bounds.1 && y <= bounds.3;
                if inside {
                    foreground_values.push(pixel(initial_frame, width, x, y));
                } else {
                    background_values.push(pixel(initial_frame, width, x, y));
                }
            }
        }
        let foreground_mean =
            foreground_values.iter().sum::<f64>() / foreground_values.len().max(1) as f64;
        let background_mean =
            background_values.iter().sum::<f64>() / background_values.len().max(1) as f64;
        let bright_foreground = foreground_mean >= background_mean;
        let threshold = (foreground_mean + background_mean) * 0.5;
        let region_model = if (foreground_mean - background_mean).abs() >= 24.0 {
            region_moments(initial_frame, width, bounds, threshold, bright_foreground).and_then(
                |moments| {
                    let box_area = ((bounds.2 - bounds.0 + 1).max(1)
                        * (bounds.3 - bounds.1 + 1).max(1))
                        as usize;
                    // A moment-based similarity proposal is valid only for a nearly
                    // solid, contrast-separated subject. Structured planar surfaces
                    // (grids, holes, screens) must remain on the full homography path.
                    (moments.count >= box_area * 4 / 5 && moments.trace >= 4.0).then_some(
                        RegionAppearanceModel {
                            threshold,
                            bright_foreground,
                            initial_center_x: moments.center_x,
                            initial_center_y: moments.center_y,
                            initial_trace: moments.trace,
                            initial_angle: moments.angle,
                            initial_count: moments.count,
                        },
                    )
                },
            )
        } else {
            None
        };
        let mut template_points = Vec::new();
        let mut region_template_points = Vec::new();
        for row in 0..8 {
            for column in 0..12 {
                let source = PlanarPoint {
                    x: min_x + (max_x - min_x) * (column as f64 + 0.5) / 12.0,
                    y: min_y + (max_y - min_y) * (row as f64 + 0.5) / 8.0,
                };
                let x = (source.x * width as f64)
                    .round()
                    .clamp(0.0, width.saturating_sub(1) as f64) as i32;
                let y = (source.y * height as f64)
                    .round()
                    .clamp(0.0, height.saturating_sub(1) as f64) as i32;
                template_points.push((source, pixel(initial_frame, width, x, y)));
                region_template_points.push((
                    source,
                    pixel_mean_3x3(initial_frame, width, height, x, y)
                        .unwrap_or_else(|| pixel(initial_frame, width, x, y)),
                ));
            }
        }
        Ok(Self {
            width,
            height,
            initial_quad,
            references,
            region_model,
            template_points,
            region_template_points,
            homography: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0],
            failures: 0,
            config,
        })
    }

    fn local_matches(&self, frame: &[u8]) -> Vec<FeatureMatch> {
        let base_radius = ((self.initial_quad[1].x - self.initial_quad[0].x).abs()
            * self.width as f64
            * self.config.search_radius
            * 0.18)
            .round() as i32;
        let radius = (base_radius + (self.failures.min(3) as i32 * 5)).clamp(7, 30);
        let current_quad = self
            .initial_quad
            .map(|point| project(self.homography, point).unwrap_or(point));
        let initial_angle = ((self.initial_quad[1].y - self.initial_quad[0].y)
            * self.height as f64)
            .atan2((self.initial_quad[1].x - self.initial_quad[0].x) * self.width as f64);
        let current_angle = ((current_quad[1].y - current_quad[0].y) * self.height as f64)
            .atan2((current_quad[1].x - current_quad[0].x) * self.width as f64);
        let rotation = current_angle - initial_angle;
        let scale = (quad_area(current_quad).abs() / quad_area(self.initial_quad).abs().max(1e-8))
            .sqrt()
            .clamp(0.55, 2.2);
        let cosine = rotation.cos();
        let sine = rotation.sin();
        let sample_offsets: Vec<(i32, i32)> = (-PATCH_RADIUS..=PATCH_RADIUS)
            .flat_map(|offset_y| {
                (-PATCH_RADIUS..=PATCH_RADIUS).map(move |offset_x| {
                    let local_x = offset_x as f64 * scale;
                    let local_y = offset_y as f64 * scale;
                    (
                        (local_x * cosine - local_y * sine).round() as i32,
                        (local_x * sine + local_y * cosine).round() as i32,
                    )
                })
            })
            .collect();
        let required_radius = sample_offsets
            .iter()
            .map(|(x, y)| x.abs().max(y.abs()))
            .max()
            .unwrap_or(PATCH_RADIUS);
        // Repeated textures can have several descriptor peaks with almost identical
        // appearance.  The previous homography is a genuine temporal prior, so use
        // it only to rank otherwise similar local candidates.  The raw similarity is
        // still retained for confidence and promotion; this does not weaken any
        // geometric or lost-state gate.
        let ranked_similarity = |similarity: f64, x: i32, y: i32, center_x: i32, center_y: i32| {
            let dx = (x - center_x) as f64;
            let dy = (y - center_y) as f64;
            similarity - (dx * dx + dy * dy).sqrt() * 0.009
        };
        let transformed_similarity = |reference: &ReferenceFeature, x: i32, y: i32| {
            patch_similarity_offsets(
                frame,
                self.width,
                self.height,
                x,
                y,
                &sample_offsets,
                required_radius,
                &reference.descriptor,
            )
            .unwrap_or(-1.0)
        };
        let mut matches = Vec::new();
        for reference in &self.references {
            let Some(predicted) = project(self.homography, reference.source) else {
                continue;
            };
            let center_x = (predicted.x * self.width as f64).round() as i32;
            let center_y = (predicted.y * self.height as f64).round() as i32;
            let mut best = (-1.0, -1.0, center_x, center_y);
            let mut second = -1.0;
            for y in (center_y - radius..=center_y + radius).step_by(2) {
                for x in (center_x - radius..=center_x + radius).step_by(2) {
                    let similarity = transformed_similarity(reference, x, y);
                    if similarity < -0.99 {
                        continue;
                    }
                    let rank = ranked_similarity(similarity, x, y, center_x, center_y);
                    if rank > best.0 {
                        second = best.0;
                        best = (rank, similarity, x, y);
                    } else if rank > second {
                        second = rank;
                    }
                }
            }
            let coarse = best;
            for y in coarse.3 - 2..=coarse.3 + 2 {
                for x in coarse.2 - 2..=coarse.2 + 2 {
                    let similarity = transformed_similarity(reference, x, y);
                    if similarity < -0.99 {
                        continue;
                    }
                    let rank = ranked_similarity(similarity, x, y, center_x, center_y);
                    if rank > best.0 {
                        second = best.0;
                        best = (rank, similarity, x, y);
                    } else if rank > second && (x != best.2 || y != best.3) {
                        second = rank;
                    }
                }
            }
            if best.1 >= 0.56 && best.0 - second >= 0.008 {
                matches.push(FeatureMatch {
                    source: reference.source,
                    destination: PlanarPoint {
                        x: best.2 as f64 / self.width as f64,
                        y: best.3 as f64 / self.height as f64,
                    },
                    similarity: best.1,
                });
            }
        }
        deduplicate_matches(matches, self.width, self.height)
    }

    fn global_matches(&self, frame: &[u8]) -> Vec<FeatureMatch> {
        let candidates = detect_global_candidates(frame, self.width, self.height);
        let mut matches = Vec::new();
        for reference in &self.references {
            let mut best = (-1.0, 0_usize);
            let mut second = -1.0;
            for (index, candidate) in candidates.iter().enumerate() {
                let similarity = candidate
                    .descriptors
                    .iter()
                    .map(|descriptor| descriptor_similarity(&reference.descriptor, descriptor))
                    .fold(-1.0_f64, f64::max);
                if similarity > best.0 {
                    second = best.0;
                    best = (similarity, index);
                } else if similarity > second {
                    second = similarity;
                }
            }
            if best.0 >= 0.64 && best.0 - second >= 0.025 {
                matches.push(FeatureMatch {
                    source: reference.source,
                    destination: candidates[best.1].point,
                    similarity: best.0,
                });
            }
        }
        deduplicate_matches(matches, self.width, self.height)
    }

    fn appearance_correlation(&self, frame: &[u8], homography: [f64; 8]) -> f64 {
        let mut current = Vec::with_capacity(self.template_points.len());
        let mut reference = Vec::with_capacity(self.template_points.len());
        for (source, value) in &self.template_points {
            let Some(destination) = project(homography, *source) else {
                return -1.0;
            };
            let x = (destination.x * self.width as f64).round() as i32;
            let y = (destination.y * self.height as f64).round() as i32;
            if x < 0 || y < 0 || x >= self.width as i32 || y >= self.height as i32 {
                return -1.0;
            }
            reference.push(*value);
            current.push(pixel(frame, self.width, x, y));
        }
        let reference_mean = reference.iter().sum::<f64>() / reference.len() as f64;
        let current_mean = current.iter().sum::<f64>() / current.len() as f64;
        let mut numerator = 0.0;
        let mut left = 0.0;
        let mut right = 0.0;
        for (reference, current) in reference.iter().zip(current.iter()) {
            let reference = reference - reference_mean;
            let current = current - current_mean;
            numerator += reference * current;
            left += reference * reference;
            right += current * current;
        }
        numerator / (left * right).sqrt().max(1e-8)
    }

    fn region_appearance_correlation(&self, frame: &[u8], homography: [f64; 8]) -> f64 {
        let mut current = Vec::with_capacity(self.region_template_points.len());
        let mut reference = Vec::with_capacity(self.region_template_points.len());
        for (source, value) in &self.region_template_points {
            let Some(destination) = project(homography, *source) else {
                return -1.0;
            };
            let x = (destination.x * self.width as f64).round() as i32;
            let y = (destination.y * self.height as f64).round() as i32;
            let Some(value_now) = pixel_mean_3x3(frame, self.width, self.height, x, y) else {
                return -1.0;
            };
            reference.push(*value);
            current.push(value_now);
        }
        let reference_mean = reference.iter().sum::<f64>() / reference.len() as f64;
        let current_mean = current.iter().sum::<f64>() / current.len() as f64;
        let mut numerator = 0.0;
        let mut left = 0.0;
        let mut right = 0.0;
        for (reference, current) in reference.iter().zip(current.iter()) {
            let reference = reference - reference_mean;
            let current = current - current_mean;
            numerator += reference * current;
            left += reference * reference;
            right += current * current;
        }
        numerator / (left * right).sqrt().max(1e-8)
    }

    fn region_candidate(
        &self,
        frame: &[u8],
        matches: &[FeatureMatch],
    ) -> Option<HomographyCandidate> {
        let model = self.region_model?;
        let previous = self
            .initial_quad
            .map(|point| project(self.homography, point).unwrap_or(point));
        let padding = 24 + self.failures.min(4) as i32 * 8;
        let bounds = (
            (previous
                .iter()
                .map(|point| point.x)
                .fold(f64::INFINITY, f64::min)
                * self.width as f64)
                .floor() as i32
                - padding,
            (previous
                .iter()
                .map(|point| point.y)
                .fold(f64::INFINITY, f64::min)
                * self.height as f64)
                .floor() as i32
                - padding,
            (previous
                .iter()
                .map(|point| point.x)
                .fold(f64::NEG_INFINITY, f64::max)
                * self.width as f64)
                .ceil() as i32
                + padding,
            (previous
                .iter()
                .map(|point| point.y)
                .fold(f64::NEG_INFINITY, f64::max)
                * self.height as f64)
                .ceil() as i32
                + padding,
        );
        let moments = region_moments(
            frame,
            self.width,
            bounds,
            model.threshold,
            model.bright_foreground,
        )?;
        let count_ratio = moments.count as f64 / model.initial_count.max(1) as f64;
        if !(0.42..=2.4).contains(&count_ratio) {
            return None;
        }
        let scale = (moments.trace / model.initial_trace.max(1e-8)).sqrt();
        if !(0.55..=2.1).contains(&scale) {
            return None;
        }
        let rotation = normalize_half_turn(moments.angle - model.initial_angle);
        let cosine = rotation.cos();
        let sine = rotation.sin();
        let destination_quad: [PlanarPoint; 4] = std::array::from_fn(|index| {
            let source_x = self.initial_quad[index].x * self.width as f64 - model.initial_center_x;
            let source_y = self.initial_quad[index].y * self.height as f64 - model.initial_center_y;
            PlanarPoint {
                x: (moments.center_x + (source_x * cosine - source_y * sine) * scale)
                    / self.width as f64,
                y: (moments.center_y + (source_x * sine + source_y * cosine) * scale)
                    / self.height as f64,
            }
        });
        let corners: [FeatureMatch; 4] = std::array::from_fn(|index| FeatureMatch {
            source: self.initial_quad[index],
            destination: destination_quad[index],
            similarity: 1.0,
        });
        let homography = solve_exact(&corners)?;
        let inliers: Vec<usize> = matches
            .iter()
            .enumerate()
            .filter_map(|(index, feature)| {
                (reprojection_error_px(homography, *feature, self.width, self.height) <= 3.0)
                    .then_some(index)
            })
            .collect();
        let mean_error_px = if inliers.is_empty() {
            0.0
        } else {
            inliers
                .iter()
                .map(|index| {
                    reprojection_error_px(homography, matches[*index], self.width, self.height)
                })
                .sum::<f64>()
                / inliers.len() as f64
        };
        let appearance_correlation = self.region_appearance_correlation(frame, homography);
        let mean_similarity = if inliers.is_empty() {
            appearance_correlation
        } else {
            inliers
                .iter()
                .map(|index| matches[*index].similarity)
                .sum::<f64>()
                / inliers.len() as f64
        };
        Some(HomographyCandidate {
            homography,
            inliers,
            mean_error_px,
            mean_similarity,
            appearance_correlation,
            confidence: 0.0,
            region_supported: true,
        })
    }

    fn assess(
        &self,
        frame: &[u8],
        matches: Vec<FeatureMatch>,
        global: bool,
    ) -> Option<HomographyCandidate> {
        let feature_candidate = ransac(&matches, self.width, self.height);
        let region_candidate = (!global)
            .then(|| self.region_candidate(frame, &matches))
            .flatten();
        let candidate = match (feature_candidate, region_candidate) {
            (Some(feature), Some(region)) => {
                if region.appearance_correlation >= 0.50 {
                    region
                } else {
                    feature
                }
            }
            (Some(feature), None) => feature,
            (None, Some(region)) => region,
            (None, None) => return None,
        };
        let mut candidate = candidate;
        let quad = self
            .initial_quad
            .map(|point| project(candidate.homography, point))
            .into_iter()
            .collect::<Option<Vec<_>>>()?;
        let quad: [PlanarPoint; 4] = quad.try_into().ok()?;
        if !valid_projected_quad(quad, quad_area(self.initial_quad).abs())
            || (!candidate.region_supported
                && !inlier_coverage(&matches, &candidate.inliers, self.initial_quad))
        {
            return None;
        }
        if !global {
            let previous_quad = self
                .initial_quad
                .map(|point| project(self.homography, point))
                .into_iter()
                .collect::<Option<Vec<_>>>()?;
            let previous_quad: [PlanarPoint; 4] = previous_quad.try_into().ok()?;
            if !temporally_continuous_quad(
                previous_quad,
                quad,
                self.width,
                self.height,
                self.failures,
            ) {
                return None;
            }
        }
        let appearance = if candidate.region_supported {
            self.region_appearance_correlation(frame, candidate.homography)
        } else {
            self.appearance_correlation(frame, candidate.homography)
        };
        let inlier_ratio = candidate.inliers.len() as f64 / self.references.len().max(1) as f64;
        let error_score = (1.0 - candidate.mean_error_px / 5.0).clamp(0.0, 1.0);
        let similarity_score = ((candidate.mean_similarity + 1.0) * 0.5).clamp(0.0, 1.0);
        let appearance_score = ((appearance + 1.0) * 0.5).clamp(0.0, 1.0);
        candidate.appearance_correlation = appearance;
        candidate.confidence = if candidate.region_supported {
            (appearance_score * 0.78 + similarity_score * 0.12 + error_score * 0.10).clamp(0.0, 1.0)
        } else {
            (inlier_ratio * 0.38
                + similarity_score * 0.22
                + appearance_score * 0.28
                + error_score * 0.12)
                .clamp(0.0, 1.0)
        };
        let appearance_floor = if candidate.region_supported {
            0.50
        } else if global {
            0.42
        } else {
            0.28
        };
        let inlier_floor = if candidate.region_supported {
            0
        } else if global {
            9
        } else {
            8
        };
        (candidate.inliers.len() >= inlier_floor
            && appearance >= appearance_floor
            && candidate.confidence >= self.config.confidence_threshold)
            .then_some(candidate)
    }

    fn track(&mut self, frame_index: usize, frame: &[u8]) -> PlanarObservation {
        let local = self.local_matches(frame);
        let mut match_count = local.len();
        let mut global_search = false;
        let mut accepted = self.assess(frame, local, false);
        if accepted.is_none() && self.failures >= 2 {
            let global = self.global_matches(frame);
            match_count = global.len();
            global_search = true;
            accepted = self.assess(frame, global, true);
        }
        if let Some(candidate) = accepted {
            self.homography = candidate.homography;
            self.failures = 0;
            let quad = self
                .initial_quad
                .map(|point| project(self.homography, point).unwrap_or(point));
            PlanarObservation {
                frame: frame_index,
                quad,
                confidence: candidate.confidence,
                status: PlanarTrackStatus::Tracked,
                inliers: candidate.inliers.len(),
                reprojection_error_px: candidate.mean_error_px,
                appearance_correlation: candidate.appearance_correlation,
                matches: match_count,
                global_search,
                region_supported: candidate.region_supported,
            }
        } else {
            self.failures += 1;
            let status = if self.failures <= self.config.max_hold_frames {
                PlanarTrackStatus::Held
            } else {
                PlanarTrackStatus::Lost
            };
            let quad = self
                .initial_quad
                .map(|point| project(self.homography, point).unwrap_or(point));
            PlanarObservation {
                frame: frame_index,
                quad,
                confidence: 0.0,
                status,
                inliers: 0,
                reprojection_error_px: -1.0,
                appearance_correlation: -1.0,
                matches: match_count,
                global_search,
                region_supported: false,
            }
        }
    }
}

fn deduplicate_matches(
    mut matches: Vec<FeatureMatch>,
    width: usize,
    height: usize,
) -> Vec<FeatureMatch> {
    matches.sort_by(|left, right| right.similarity.total_cmp(&left.similarity));
    let mut selected: Vec<FeatureMatch> = Vec::new();
    for candidate in matches {
        let unique = selected.iter().all(|current| {
            let dx = (current.destination.x - candidate.destination.x) * width as f64;
            let dy = (current.destination.y - candidate.destination.y) * height as f64;
            dx * dx + dy * dy >= 4.0
        });
        if unique {
            selected.push(candidate);
        }
    }
    selected
}

pub fn track_planar_sequence(
    frames: &[u8],
    width: usize,
    height: usize,
    frame_count: usize,
    initial_frame_index: usize,
    initial_quad: [PlanarPoint; 4],
    config: PlanarTrackConfig,
) -> Result<Vec<PlanarObservation>, String> {
    let frame_bytes = width
        .checked_mul(height)
        .ok_or("planar frame size overflow")?;
    if frames.len()
        != frame_bytes
            .checked_mul(frame_count)
            .ok_or("planar sequence size overflow")?
        || initial_frame_index >= frame_count
    {
        return Err("invalid planar sequence".into());
    }
    let initial_frame =
        &frames[initial_frame_index * frame_bytes..(initial_frame_index + 1) * frame_bytes];
    let mut observations: Vec<Option<PlanarObservation>> = vec![None; frame_count];
    observations[initial_frame_index] = Some(PlanarObservation {
        frame: initial_frame_index,
        quad: initial_quad,
        confidence: 1.0,
        status: PlanarTrackStatus::Manual,
        inliers: 0,
        reprojection_error_px: 0.0,
        appearance_correlation: 1.0,
        matches: 0,
        global_search: false,
        region_supported: false,
    });
    let mut forward = PlanarTracker::new(initial_frame, width, height, initial_quad, config)?;
    for frame_index in initial_frame_index + 1..frame_count {
        let frame = &frames[frame_index * frame_bytes..(frame_index + 1) * frame_bytes];
        observations[frame_index] = Some(forward.track(frame_index, frame));
    }
    if initial_frame_index > 0 {
        let mut backward = PlanarTracker::new(initial_frame, width, height, initial_quad, config)?;
        for frame_index in (0..initial_frame_index).rev() {
            let frame = &frames[frame_index * frame_bytes..(frame_index + 1) * frame_bytes];
            observations[frame_index] = Some(backward.track(frame_index, frame));
        }
    }
    observations
        .into_iter()
        .enumerate()
        .map(|(index, observation)| {
            observation.ok_or_else(|| format!("missing planar observation {index}"))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ransac_recovers_projective_transform_with_outliers() {
        let expected = [1.04, 0.08, 0.03, -0.04, 0.97, 0.05, 0.19, -0.11];
        let mut matches = Vec::new();
        for y in 0..4 {
            for x in 0..5 {
                let source = PlanarPoint {
                    x: 0.1 + x as f64 * 0.14,
                    y: 0.12 + y as f64 * 0.18,
                };
                let destination = project(expected, source).unwrap();
                matches.push(FeatureMatch {
                    source,
                    destination,
                    similarity: 0.95,
                });
            }
        }
        matches.push(FeatureMatch {
            source: PlanarPoint { x: 0.2, y: 0.2 },
            destination: PlanarPoint { x: 0.8, y: 0.8 },
            similarity: 0.7,
        });
        matches.push(FeatureMatch {
            source: PlanarPoint { x: 0.7, y: 0.7 },
            destination: PlanarPoint { x: 0.1, y: 0.2 },
            similarity: 0.7,
        });
        let solved = ransac(&matches, 640, 360).expect("homography");
        assert!(solved.inliers.len() >= 20);
        assert!(solved.mean_error_px < 0.01);
        for point in [
            PlanarPoint { x: 0.13, y: 0.16 },
            PlanarPoint { x: 0.73, y: 0.68 },
        ] {
            let actual = project(solved.homography, point).unwrap();
            let target = project(expected, point).unwrap();
            assert!((actual.x - target.x).abs() < 1e-6);
            assert!((actual.y - target.y).abs() < 1e-6);
        }
    }

    #[test]
    fn projected_quad_rejects_crossed_and_collapsed_geometry() {
        let initial = [
            PlanarPoint { x: 0.2, y: 0.2 },
            PlanarPoint { x: 0.6, y: 0.2 },
            PlanarPoint { x: 0.6, y: 0.6 },
            PlanarPoint { x: 0.2, y: 0.6 },
        ];
        assert!(valid_projected_quad(initial, quad_area(initial).abs()));
        let crossed = [initial[0], initial[2], initial[1], initial[3]];
        assert!(!valid_projected_quad(crossed, quad_area(initial).abs()));
        assert!(!valid_projected_quad(
            [initial[0]; 4],
            quad_area(initial).abs()
        ));
    }
}
