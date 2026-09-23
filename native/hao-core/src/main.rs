use serde::{Deserialize, Serialize};
use std::{env, fs, io::Write, process};

use hao_core::engine;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Project {
    fps: f64,
    tracks: Vec<Track>,
    #[serde(default)]
    captions: Vec<Caption>,
}

#[derive(Deserialize)]
struct Track {
    id: String,
    kind: String,
    #[serde(default)]
    muted: bool,
    #[serde(default)]
    clips: Vec<Clip>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Clip {
    id: String,
    asset_id: String,
    timeline_start: f64,
    source_start: f64,
    duration: f64,
}

#[derive(Clone, Deserialize)]
struct Caption {
    id: String,
    text: String,
    start: f64,
    duration: f64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TimeRange {
    start: f64,
    end: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SmartCutOptions {
    padding: f64,
    min_silence: f64,
    min_keep: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SmartCutRequest {
    fps: f64,
    duration: f64,
    silences: Vec<TimeRange>,
    options: SmartCutOptions,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
struct NormalizedRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MotionTrackRequest {
    raw_path: String,
    width: usize,
    height: usize,
    frame_count: usize,
    analysis_fps: f64,
    initial_frame: usize,
    initial_rect: NormalizedRect,
    #[serde(default = "default_search_radius")]
    search_radius: f64,
    #[serde(default = "default_track_confidence")]
    confidence_threshold: f64,
    #[serde(default = "default_hold_frames")]
    max_hold_frames: usize,
    #[serde(default = "default_rotation_step")]
    max_rotation_step: f64,
}

fn default_search_radius() -> f64 {
    0.65
}
fn default_track_confidence() -> f64 {
    0.48
}
fn default_hold_frames() -> usize {
    5
}
fn default_rotation_step() -> f64 {
    8.0
}

#[derive(Clone, Copy, Deserialize, Serialize)]
struct NormalizedPoint {
    x: f64,
    y: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MotionTrackPoint {
    frame: usize,
    time: f64,
    rect: NormalizedRect,
    confidence: f64,
    status: &'static str,
    activity: f64,
    rotation_degrees: f64,
    scale: f64,
    quad: [NormalizedPoint; 4],
    #[serde(skip_serializing_if = "Option::is_none")]
    planar_diagnostics: Option<PlanarDiagnostics>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlanarDiagnostics {
    matches: usize,
    inliers: usize,
    reprojection_error_px: f64,
    appearance_correlation: f64,
    global_search: bool,
    region_supported: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MotionTrackPlan {
    engine: &'static str,
    analysis_fps: f64,
    width: usize,
    height: usize,
    points: Vec<MotionTrackPoint>,
    lost_ratio: f64,
}

#[derive(Clone, Copy, Debug)]
struct PixelRect {
    x: i32,
    y: i32,
    width: i32,
    height: i32,
    rotation_degrees: f64,
}

fn clamp_rect(rect: PixelRect, width: usize, height: usize) -> PixelRect {
    let max_width = width.max(2) as i32;
    let max_height = height.max(2) as i32;
    let rect_width = rect.width.clamp(4, max_width);
    let rect_height = rect.height.clamp(4, max_height);
    PixelRect {
        x: rect.x.clamp(0, max_width - rect_width),
        y: rect.y.clamp(0, max_height - rect_height),
        width: rect_width,
        height: rect_height,
        rotation_degrees: rect.rotation_degrees,
    }
}

fn pixel_rect(rect: NormalizedRect, width: usize, height: usize) -> PixelRect {
    clamp_rect(
        PixelRect {
            x: (rect.x * width as f64).round() as i32,
            y: (rect.y * height as f64).round() as i32,
            width: (rect.width * width as f64).round() as i32,
            height: (rect.height * height as f64).round() as i32,
            rotation_degrees: 0.0,
        },
        width,
        height,
    )
}

fn normalized_rect(rect: PixelRect, width: usize, height: usize) -> NormalizedRect {
    NormalizedRect {
        x: rect.x as f64 / width as f64,
        y: rect.y as f64 / height as f64,
        width: rect.width as f64 / width as f64,
        height: rect.height as f64 / height as f64,
    }
}

fn normalized_quad(rect: PixelRect, width: usize, height: usize) -> [NormalizedPoint; 4] {
    let center_x = rect.x as f64 + rect.width as f64 / 2.0;
    let center_y = rect.y as f64 + rect.height as f64 / 2.0;
    let radians = rect.rotation_degrees.to_radians();
    let cosine = radians.cos();
    let sine = radians.sin();
    [(-0.5, -0.5), (0.5, -0.5), (0.5, 0.5), (-0.5, 0.5)].map(|(unit_x, unit_y)| {
        let local_x = unit_x * rect.width as f64;
        let local_y = unit_y * rect.height as f64;
        NormalizedPoint {
            x: ((center_x + local_x * cosine - local_y * sine) / width as f64).clamp(0.0, 1.0),
            y: ((center_y + local_x * sine + local_y * cosine) / height as f64).clamp(0.0, 1.0),
        }
    })
}

fn sample_patch(
    frame: &[u8],
    frame_width: usize,
    rect: PixelRect,
    columns: usize,
    rows: usize,
) -> Vec<u8> {
    let mut samples = Vec::with_capacity(columns * rows);
    for row in 0..rows {
        for column in 0..columns {
            let unit_x = (column as f64 + 0.5) / columns as f64 - 0.5;
            let unit_y = (row as f64 + 0.5) / rows as f64 - 0.5;
            samples.push(sample_rotated(frame, frame_width, rect, unit_x, unit_y));
        }
    }
    samples
}

fn sample_rotated(
    frame: &[u8],
    frame_width: usize,
    rect: PixelRect,
    unit_x: f64,
    unit_y: f64,
) -> u8 {
    let frame_height = frame.len() / frame_width;
    let center_x = rect.x as f64 + rect.width as f64 / 2.0;
    let center_y = rect.y as f64 + rect.height as f64 / 2.0;
    let radians = rect.rotation_degrees.to_radians();
    let cosine = radians.cos();
    let sine = radians.sin();
    let local_x = unit_x * rect.width as f64;
    let local_y = unit_y * rect.height as f64;
    let x = (center_x + local_x * cosine - local_y * sine)
        .round()
        .clamp(0.0, frame_width.saturating_sub(1) as f64) as usize;
    let y = (center_y + local_x * sine + local_y * cosine)
        .round()
        .clamp(0.0, frame_height.saturating_sub(1) as f64) as usize;
    frame[y * frame_width + x]
}

fn boundary_contrast(frame: &[u8], frame_width: usize, rect: PixelRect) -> f64 {
    let inside = sample_patch(frame, frame_width, rect, 8, 6);
    let inside_mean = inside.iter().map(|value| *value as f64).sum::<f64>() / inside.len() as f64;
    let offsets = [-0.35, -0.1, 0.1, 0.35];
    let mut outside = Vec::with_capacity(16);
    for offset in offsets {
        outside.push(sample_rotated(frame, frame_width, rect, -0.62, offset));
        outside.push(sample_rotated(frame, frame_width, rect, 0.62, offset));
        outside.push(sample_rotated(frame, frame_width, rect, offset, -0.62));
        outside.push(sample_rotated(frame, frame_width, rect, offset, 0.62));
    }
    let outside_mean =
        outside.iter().map(|value| *value as f64).sum::<f64>() / outside.len() as f64;
    ((inside_mean - outside_mean).abs() / 255.0).clamp(0.0, 1.0)
}

fn estimate_orientation(
    frame: &[u8],
    frame_width: usize,
    rect: PixelRect,
    previous: f64,
) -> Option<f64> {
    let frame_height = frame.len() / frame_width;
    let center_x = rect.x as f64 + rect.width as f64 / 2.0;
    let center_y = rect.y as f64 + rect.height as f64 / 2.0;
    let background = [
        sample_rotated(frame, frame_width, rect, -0.72, -0.72),
        sample_rotated(frame, frame_width, rect, 0.72, -0.72),
        sample_rotated(frame, frame_width, rect, 0.72, 0.72),
        sample_rotated(frame, frame_width, rect, -0.72, 0.72),
    ]
    .iter()
    .map(|value| *value as f64)
    .sum::<f64>()
        / 4.0;
    let radius = ((rect.width.max(rect.height) as f64 * 0.82).ceil() as i32).max(6);
    let mut weight_sum = 0.0;
    let mut mean_x = 0.0;
    let mut mean_y = 0.0;
    for y in ((center_y as i32 - radius).max(0))
        ..=((center_y as i32 + radius).min(frame_height as i32 - 1))
    {
        for x in ((center_x as i32 - radius).max(0))
            ..=((center_x as i32 + radius).min(frame_width as i32 - 1))
        {
            let contrast = (frame[y as usize * frame_width + x as usize] as f64 - background).abs();
            let weight = (contrast - 18.0).max(0.0);
            weight_sum += weight;
            mean_x += x as f64 * weight;
            mean_y += y as f64 * weight;
        }
    }
    if weight_sum < 1.0 {
        return None;
    }
    mean_x /= weight_sum;
    mean_y /= weight_sum;
    let mut xx = 0.0;
    let mut yy = 0.0;
    let mut xy = 0.0;
    for y in ((center_y as i32 - radius).max(0))
        ..=((center_y as i32 + radius).min(frame_height as i32 - 1))
    {
        for x in ((center_x as i32 - radius).max(0))
            ..=((center_x as i32 + radius).min(frame_width as i32 - 1))
        {
            let contrast = (frame[y as usize * frame_width + x as usize] as f64 - background).abs();
            let weight = (contrast - 18.0).max(0.0);
            let dx = x as f64 - mean_x;
            let dy = y as f64 - mean_y;
            xx += weight * dx * dx;
            yy += weight * dy * dy;
            xy += weight * dx * dy;
        }
    }
    let anisotropy = ((xx - yy).powi(2) + 4.0 * xy * xy).sqrt() / (xx + yy).max(1.0);
    if anisotropy < 0.08 {
        return None;
    }
    let mut angle = (0.5 * (2.0 * xy).atan2(xx - yy)).to_degrees();
    while angle - previous > 90.0 {
        angle -= 180.0;
    }
    while angle - previous < -90.0 {
        angle += 180.0;
    }
    Some(angle)
}

fn patch_score(
    frame: &[u8],
    frame_width: usize,
    candidate: PixelRect,
    reference: &[u8],
    columns: usize,
    rows: usize,
) -> f64 {
    let current = sample_patch(frame, frame_width, candidate, columns, rows);
    let difference: usize = current
        .iter()
        .zip(reference)
        .map(|(left, right)| (*left as i32 - *right as i32).unsigned_abs() as usize)
        .sum();
    1.0 - difference as f64 / (reference.len().max(1) as f64 * 255.0)
}

fn best_candidate(
    frame: &[u8],
    width: usize,
    height: usize,
    previous: PixelRect,
    reference: &[u8],
    columns: usize,
    rows: usize,
    search_radius: f64,
    growth: usize,
    max_rotation_step: f64,
) -> (PixelRect, f64) {
    let radius_x = ((previous.width as f64 * search_radius).round() as i32 * growth as i32).max(6);
    let radius_y = ((previous.height as f64 * search_radius).round() as i32 * growth as i32).max(6);
    let coarse_step = (previous.width.min(previous.height) / 18).clamp(2, 8);
    let center_x = previous.x + previous.width / 2;
    let center_y = previous.y + previous.height / 2;
    let scales = [0.90_f64, 1.0, 1.10];
    let rotations = [-max_rotation_step, 0.0, max_rotation_step];
    let mut best = previous;
    let mut best_score = -1.0_f64;
    for scale in scales {
        for rotation_delta in rotations {
            let candidate_width = (previous.width as f64 * scale).round() as i32;
            let candidate_height = (previous.height as f64 * scale).round() as i32;
            let mut y = center_y - radius_y;
            while y <= center_y + radius_y {
                let mut x = center_x - radius_x;
                while x <= center_x + radius_x {
                    let candidate = clamp_rect(
                        PixelRect {
                            x: x - candidate_width / 2,
                            y: y - candidate_height / 2,
                            width: candidate_width,
                            height: candidate_height,
                            rotation_degrees: previous.rotation_degrees + rotation_delta,
                        },
                        width,
                        height,
                    );
                    let appearance = patch_score(frame, width, candidate, reference, columns, rows);
                    let contrast = boundary_contrast(frame, width, candidate);
                    let scale_penalty = scale.ln().abs() * 0.08;
                    let rotation_penalty = if max_rotation_step > 0.0 {
                        (rotation_delta / max_rotation_step).abs() * 0.008
                    } else {
                        0.0
                    };
                    let score =
                        appearance * 0.82 + contrast * 0.18 - scale_penalty - rotation_penalty;
                    if score > best_score {
                        best = candidate;
                        best_score = score;
                    }
                    x += coarse_step;
                }
                y += coarse_step;
            }
        }
    }
    let coarse = best;
    for y in (coarse.y - coarse_step)..=(coarse.y + coarse_step) {
        for x in (coarse.x - coarse_step)..=(coarse.x + coarse_step) {
            let candidate = clamp_rect(
                PixelRect {
                    x,
                    y,
                    width: coarse.width,
                    height: coarse.height,
                    rotation_degrees: coarse.rotation_degrees,
                },
                width,
                height,
            );
            let score = patch_score(frame, width, candidate, reference, columns, rows);
            if score > best_score {
                best = candidate;
                best_score = score;
            }
        }
    }
    if let Some(estimated) = estimate_orientation(frame, width, best, previous.rotation_degrees) {
        let delta =
            (estimated - previous.rotation_degrees).clamp(-max_rotation_step, max_rotation_step);
        best.rotation_degrees = previous.rotation_degrees + delta;
        best_score = patch_score(frame, width, best, reference, columns, rows);
    }
    (best, best_score.clamp(0.0, 1.0))
}

fn track_direction(
    request: &MotionTrackRequest,
    frames: &[u8],
    indices: impl Iterator<Item = usize>,
    initial: PixelRect,
    initial_reference: &[u8],
    columns: usize,
    rows: usize,
) -> Vec<MotionTrackPoint> {
    let frame_bytes = request.width * request.height;
    let mut previous = initial;
    let mut reference = initial_reference.to_vec();
    let mut held = 0_usize;
    let mut points = Vec::new();
    for frame_index in indices {
        let frame = &frames[frame_index * frame_bytes..(frame_index + 1) * frame_bytes];
        let (candidate, confidence) = best_candidate(
            frame,
            request.width,
            request.height,
            previous,
            &reference,
            columns,
            rows,
            request.search_radius,
            1 + held.min(2),
            request.max_rotation_step,
        );
        let accepted = confidence >= request.confidence_threshold;
        let (rect, status) = if accepted {
            previous = candidate;
            held = 0;
            if confidence >= 0.74 {
                let observed = sample_patch(frame, request.width, candidate, columns, rows);
                for (base, value) in reference.iter_mut().zip(observed) {
                    *base = ((*base as u16 * 7 + value as u16 * 3) / 10) as u8;
                }
            }
            (candidate, "tracked")
        } else if held < request.max_hold_frames {
            held += 1;
            (previous, "held")
        } else {
            held += 1;
            (previous, "lost")
        };
        points.push(MotionTrackPoint {
            frame: frame_index,
            time: frame_index as f64 / request.analysis_fps,
            rect: normalized_rect(rect, request.width, request.height),
            confidence,
            status,
            activity: 0.0,
            rotation_degrees: rect.rotation_degrees,
            scale: rect.width as f64 / initial.width.max(1) as f64,
            quad: normalized_quad(rect, request.width, request.height),
            planar_diagnostics: None,
        });
    }
    points
}

fn build_motion_track(request: MotionTrackRequest) -> Result<MotionTrackPlan, String> {
    if request.width < 16
        || request.height < 16
        || request.frame_count == 0
        || request.initial_frame >= request.frame_count
        || !request.analysis_fps.is_finite()
        || request.analysis_fps <= 0.0
        || request.analysis_fps > 120.0
        || !request.search_radius.is_finite()
        || request.search_radius < 0.1
        || request.search_radius > 3.0
        || !request.confidence_threshold.is_finite()
        || request.confidence_threshold <= 0.0
        || request.confidence_threshold >= 1.0
        || !request.max_rotation_step.is_finite()
        || request.max_rotation_step < 0.0
        || request.max_rotation_step > 30.0
    {
        return Err("invalid motion-track request".into());
    }
    let initial_values = [
        request.initial_rect.x,
        request.initial_rect.y,
        request.initial_rect.width,
        request.initial_rect.height,
    ];
    if initial_values.iter().any(|value| !value.is_finite())
        || request.initial_rect.x < 0.0
        || request.initial_rect.y < 0.0
        || request.initial_rect.width <= 0.0
        || request.initial_rect.height <= 0.0
        || request.initial_rect.x + request.initial_rect.width > 1.0
        || request.initial_rect.y + request.initial_rect.height > 1.0
    {
        return Err("invalid initial motion-track rectangle".into());
    }
    let frames = fs::read(&request.raw_path).map_err(|error| error.to_string())?;
    let expected = request
        .width
        .checked_mul(request.height)
        .and_then(|value| value.checked_mul(request.frame_count))
        .ok_or("motion-track frame size overflow")?;
    if frames.len() != expected {
        return Err(format!(
            "motion-track raw frame size mismatch: {} != {expected}",
            frames.len()
        ));
    }
    let initial = pixel_rect(request.initial_rect, request.width, request.height);
    let frame_bytes = request.width * request.height;
    let initial_frame =
        &frames[request.initial_frame * frame_bytes..(request.initial_frame + 1) * frame_bytes];
    let columns = (initial.width as usize).clamp(8, 18);
    let rows = (initial.height as usize).clamp(8, 18);
    let reference = sample_patch(initial_frame, request.width, initial, columns, rows);
    let initial_quad = normalized_quad(initial, request.width, request.height);
    let planar_quad = initial_quad.map(|point| engine::planar_track::PlanarPoint {
        x: point.x,
        y: point.y,
    });
    let planar = engine::planar_track::track_planar_sequence(
        &frames,
        request.width,
        request.height,
        request.frame_count,
        request.initial_frame,
        planar_quad,
        engine::planar_track::PlanarTrackConfig {
            confidence_threshold: request.confidence_threshold,
            max_hold_frames: request.max_hold_frames,
            search_radius: request.search_radius,
        },
    );
    let (mut points, tracker_engine) = match planar {
        Ok(observations) => {
            let initial_area = (initial.width * initial.height).max(1) as f64;
            let points = observations
                .into_iter()
                .map(|observation| {
                    let quad = observation.quad.map(|point| NormalizedPoint {
                        x: point.x.clamp(0.0, 1.0),
                        y: point.y.clamp(0.0, 1.0),
                    });
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
                    let polygon_area = (0..4)
                        .map(|index| {
                            let next = (index + 1) % 4;
                            quad[index].x * quad[next].y - quad[next].x * quad[index].y
                        })
                        .sum::<f64>()
                        .abs()
                        * 0.5
                        * request.width as f64
                        * request.height as f64;
                    let rotation_degrees = ((quad[1].y - quad[0].y) * request.height as f64)
                        .atan2((quad[1].x - quad[0].x) * request.width as f64)
                        .to_degrees();
                    MotionTrackPoint {
                        frame: observation.frame,
                        time: observation.frame as f64 / request.analysis_fps,
                        rect: NormalizedRect {
                            x: min_x,
                            y: min_y,
                            width: max_x - min_x,
                            height: max_y - min_y,
                        },
                        confidence: observation.confidence,
                        status: observation.status.as_str(),
                        activity: 0.0,
                        rotation_degrees,
                        scale: (polygon_area / initial_area).max(0.0).sqrt(),
                        quad,
                        planar_diagnostics: Some(PlanarDiagnostics {
                            matches: observation.matches,
                            inliers: observation.inliers,
                            reprojection_error_px: observation.reprojection_error_px,
                            appearance_correlation: observation.appearance_correlation,
                            global_search: observation.global_search,
                            region_supported: observation.region_supported,
                        }),
                    }
                })
                .collect();
            (points, "hao-core-rust-motion-track-0.4-planar")
        }
        Err(_) => {
            let mut points = track_direction(
                &request,
                &frames,
                (0..request.initial_frame).rev(),
                initial,
                &reference,
                columns,
                rows,
            );
            points.reverse();
            points.push(MotionTrackPoint {
                frame: request.initial_frame,
                time: request.initial_frame as f64 / request.analysis_fps,
                rect: normalized_rect(initial, request.width, request.height),
                confidence: 1.0,
                status: "manual",
                activity: 0.0,
                rotation_degrees: initial.rotation_degrees,
                scale: 1.0,
                quad: initial_quad,
                planar_diagnostics: None,
            });
            points.extend(track_direction(
                &request,
                &frames,
                request.initial_frame + 1..request.frame_count,
                initial,
                &reference,
                columns,
                rows,
            ));
            (points, "hao-core-rust-motion-track-0.4-region-fallback")
        }
    };
    for index in 1..points.len() {
        if points[index].status == "lost" || points[index - 1].status == "lost" {
            points[index].activity = 0.0;
            continue;
        }
        let mut previous = pixel_rect(points[index - 1].rect, request.width, request.height);
        previous.rotation_degrees = points[index - 1].rotation_degrees;
        let mut current = pixel_rect(points[index].rect, request.width, request.height);
        current.rotation_degrees = points[index].rotation_degrees;
        let focus = |rect: PixelRect| {
            clamp_rect(
                PixelRect {
                    x: rect.x + rect.width / 5,
                    y: rect.y + rect.height * 11 / 20,
                    width: rect.width * 3 / 5,
                    height: rect.height / 3,
                    rotation_degrees: rect.rotation_degrees,
                },
                request.width,
                request.height,
            )
        };
        let previous_frame = &frames[(index - 1) * frame_bytes..index * frame_bytes];
        let current_frame = &frames[index * frame_bytes..(index + 1) * frame_bytes];
        let previous_samples = sample_patch(previous_frame, request.width, focus(previous), 12, 8);
        let current_samples = sample_patch(current_frame, request.width, focus(current), 12, 8);
        let difference: usize = previous_samples
            .iter()
            .zip(current_samples.iter())
            .map(|(left, right)| (*left as i32 - *right as i32).unsigned_abs() as usize)
            .sum();
        points[index].activity =
            (difference as f64 / (previous_samples.len().max(1) as f64 * 255.0)).clamp(0.0, 1.0);
    }
    let lost = points.iter().filter(|point| point.status == "lost").count();
    Ok(MotionTrackPlan {
        engine: tracker_engine,
        analysis_fps: request.analysis_fps,
        width: request.width,
        height: request.height,
        lost_ratio: lost as f64 / points.len().max(1) as f64,
        points,
    })
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct FrameRange {
    start_frame: i64,
    end_frame: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SmartCutPlan {
    engine: &'static str,
    fps: f64,
    source_frames: i64,
    ranges: Vec<FrameRange>,
    removed_frames: i64,
    cut_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativePlan {
    engine: &'static str,
    fps: f64,
    duration_frames: i64,
    layers: Vec<Layer>,
    captions: Vec<CaptionPlan>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Layer {
    track_id: String,
    segments: Vec<Segment>,
}

#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum Segment {
    Gap {
        start_frame: i64,
        duration_frames: i64,
    },
    Clip {
        clip_id: String,
        asset_id: String,
        start_frame: i64,
        source_frame: i64,
        duration_frames: i64,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptionPlan {
    id: String,
    text: String,
    start_frame: i64,
    duration_frames: i64,
}

fn frame(value: f64, fps: f64) -> i64 {
    (value * fps).round() as i64
}

fn build_plan(project: Project) -> Result<NativePlan, String> {
    if !project.fps.is_finite() || project.fps <= 0.0 || project.fps > 240.0 {
        return Err("invalid fps".into());
    }
    let mut duration_frames = 0_i64;
    let mut layers = Vec::new();
    for track in project
        .tracks
        .into_iter()
        .filter(|track| track.kind == "video" && !track.muted)
    {
        let mut clips = track.clips;
        clips.sort_by(|a, b| a.timeline_start.total_cmp(&b.timeline_start));
        let mut cursor = 0_i64;
        let mut segments = Vec::new();
        for clip in clips {
            let start = frame(clip.timeline_start, project.fps);
            let duration = frame(clip.duration, project.fps);
            if duration <= 0 || start < cursor {
                return Err(format!(
                    "invalid or overlapping video clip in track {}: {}",
                    track.id, clip.id
                ));
            }
            if start > cursor {
                segments.push(Segment::Gap {
                    start_frame: cursor,
                    duration_frames: start - cursor,
                });
            }
            segments.push(Segment::Clip {
                clip_id: clip.id,
                asset_id: clip.asset_id,
                start_frame: start,
                source_frame: frame(clip.source_start, project.fps),
                duration_frames: duration,
            });
            cursor = start + duration;
        }
        duration_frames = duration_frames.max(cursor);
        layers.push(Layer {
            track_id: track.id,
            segments,
        });
    }

    let captions: Vec<CaptionPlan> = project
        .captions
        .into_iter()
        .map(|caption| CaptionPlan {
            id: caption.id,
            text: caption.text,
            start_frame: frame(caption.start, project.fps),
            duration_frames: frame(caption.duration, project.fps),
        })
        .collect();
    let caption_end = captions
        .iter()
        .map(|item| item.start_frame + item.duration_frames)
        .max()
        .unwrap_or(0);
    duration_frames = duration_frames.max(caption_end);
    for layer in &mut layers {
        let cursor = layer
            .segments
            .last()
            .map(|segment| match segment {
                Segment::Gap {
                    start_frame,
                    duration_frames,
                } => start_frame + duration_frames,
                Segment::Clip {
                    start_frame,
                    duration_frames,
                    ..
                } => start_frame + duration_frames,
            })
            .unwrap_or(0);
        if cursor < duration_frames {
            layer.segments.push(Segment::Gap {
                start_frame: cursor,
                duration_frames: duration_frames - cursor,
            });
        }
    }
    if duration_frames <= 0 {
        return Err("project has no renderable duration".into());
    }
    Ok(NativePlan {
        engine: "hao-core-rust-0.4",
        fps: project.fps,
        duration_frames,
        layers,
        captions,
    })
}

fn finite_non_negative(value: f64) -> bool {
    value.is_finite() && value >= 0.0
}

fn build_smart_cut(request: SmartCutRequest) -> Result<SmartCutPlan, String> {
    if !request.fps.is_finite() || request.fps <= 0.0 || request.fps > 240.0 {
        return Err("invalid smart-cut fps".into());
    }
    if !request.duration.is_finite() || request.duration <= 0.0 {
        return Err("invalid smart-cut duration".into());
    }
    if !finite_non_negative(request.options.padding)
        || !finite_non_negative(request.options.min_silence)
        || !finite_non_negative(request.options.min_keep)
    {
        return Err("invalid smart-cut options".into());
    }
    let source_frames = frame(request.duration, request.fps);
    let padding_frames = frame(request.options.padding, request.fps);
    let min_silence_frames = frame(request.options.min_silence, request.fps).max(1);
    let min_keep_frames = frame(request.options.min_keep, request.fps).max(1);
    let mut removals = Vec::<FrameRange>::new();
    for silence in request.silences {
        if !finite_non_negative(silence.start)
            || !finite_non_negative(silence.end)
            || silence.end < silence.start
        {
            return Err("invalid silence range".into());
        }
        let raw_start = frame(silence.start, request.fps).clamp(0, source_frames);
        let raw_end = frame(silence.end, request.fps).clamp(0, source_frames);
        if raw_end - raw_start < min_silence_frames {
            continue;
        }
        let start_frame = (raw_start + padding_frames).min(source_frames);
        let end_frame = (raw_end - padding_frames).max(0);
        if end_frame > start_frame {
            removals.push(FrameRange {
                start_frame,
                end_frame,
            });
        }
    }
    removals.sort_by_key(|range| range.start_frame);
    let mut merged = Vec::<FrameRange>::new();
    for range in removals {
        if let Some(previous) = merged.last_mut() {
            if range.start_frame - previous.end_frame < min_keep_frames {
                previous.end_frame = previous.end_frame.max(range.end_frame);
                continue;
            }
        }
        merged.push(range);
    }
    if let Some(first) = merged.first_mut() {
        if first.start_frame < min_keep_frames {
            first.start_frame = 0;
        }
    }
    if let Some(last) = merged.last_mut() {
        if source_frames - last.end_frame < min_keep_frames {
            last.end_frame = source_frames;
        }
    }
    let cut_count = merged.len();
    let mut ranges = Vec::<FrameRange>::new();
    let mut cursor = 0_i64;
    for removal in merged {
        if removal.start_frame > cursor {
            ranges.push(FrameRange {
                start_frame: cursor,
                end_frame: removal.start_frame,
            });
        }
        cursor = cursor.max(removal.end_frame);
    }
    if cursor < source_frames {
        ranges.push(FrameRange {
            start_frame: cursor,
            end_frame: source_frames,
        });
    }
    if ranges.is_empty() {
        return Err("smart-cut would remove the entire clip".into());
    }
    let kept_frames: i64 = ranges
        .iter()
        .map(|range| range.end_frame - range.start_frame)
        .sum();
    Ok(SmartCutPlan {
        engine: "hao-core-rust-0.4",
        fps: request.fps,
        source_frames,
        ranges,
        removed_frames: source_frames - kept_frames,
        cut_count,
    })
}

fn run() -> Result<(), String> {
    let args: Vec<String> = env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("plan") => {
            let path = args.get(2).ok_or("usage: hao-core plan <project.json>")?;
            let project: Project =
                serde_json::from_str(&fs::read_to_string(path).map_err(|error| error.to_string())?)
                    .map_err(|error| error.to_string())?;
            let plan = build_plan(project)?;
            println!(
                "{}",
                serde_json::to_string(&plan).map_err(|error| error.to_string())?
            );
            Ok(())
        }
        Some("smart-cut") => {
            let path = args
                .get(2)
                .ok_or("usage: hao-core smart-cut <analysis.json>")?;
            let request: SmartCutRequest =
                serde_json::from_str(&fs::read_to_string(path).map_err(|error| error.to_string())?)
                    .map_err(|error| error.to_string())?;
            let plan = build_smart_cut(request)?;
            println!(
                "{}",
                serde_json::to_string(&plan).map_err(|error| error.to_string())?
            );
            Ok(())
        }
        Some("motion-track") => {
            let path = args
                .get(2)
                .ok_or("usage: hao-core motion-track <request.json>")?;
            let request: MotionTrackRequest =
                serde_json::from_str(&fs::read_to_string(path).map_err(|error| error.to_string())?)
                    .map_err(|error| error.to_string())?;
            let plan = build_motion_track(request)?;
            println!(
                "{}",
                serde_json::to_string(&plan).map_err(|error| error.to_string())?
            );
            Ok(())
        }
        Some("engine-validate") | Some("engine-compile") => {
            let path = args
                .get(2)
                .ok_or("usage: hao-core engine-compile <engine-graph.json>")?;
            let graph: engine::EngineGraph =
                serde_json::from_str(&fs::read_to_string(path).map_err(|error| error.to_string())?)
                    .map_err(|error| error.to_string())?;
            let compiled = engine::compile_graph(graph)?;
            println!(
                "{}",
                serde_json::to_string(&compiled).map_err(|error| error.to_string())?
            );
            Ok(())
        }
        Some("engine-dirty") => {
            let path = args.get(2).ok_or("usage: hao-core engine-dirty <engine-graph.json> <changed-node>...")?;
            let changed = args.get(3..).ok_or("engine-dirty requires at least one changed node")?.to_vec();
            if changed.is_empty() { return Err("engine-dirty requires at least one changed node".into()); }
            let graph: engine::EngineGraph = serde_json::from_str(&fs::read_to_string(path).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
            let dirty = engine::validate::dirty_descendants(&graph, &changed)?;
            println!("{}", serde_json::json!({ "schema": "editkin.engine-dirty/v1", "changed": changed, "dirty": dirty }));
            Ok(())
        }
        Some("engine-capabilities") => {
            println!(
                "{}",
                serde_json::json!({
                    "schema": "editkin.engine-capabilities/v1",
                    "engine": "hao-core",
                    "engineAbiVersion": engine::model::ENGINE_ABI_VERSION,
                    "graphSchema": engine::model::ENGINE_GRAPH_SCHEMA,
                    "residentAudio": {
                        "commandSchema": "editkin.audio-session-command/v1",
                        "eventSchema": "editkin.audio-session-event/v1",
                        "planSchema": "editkin.audio-codec-stream-plan/v2",
                        "sampleRate": 48000,
                        "maxCatalogSources": 4096,
                        "maxActiveSources": 16,
                        "physicalOutput": cfg!(windows)
                    },
                    "pixelFormats": ["rgba8", "rgba16_float", "rgba32_float", "alpha8", "alpha16"],
                    "featureFamilies": ["rational_time", "dirty_graph", "resource_cache", "triple_frame_ring", "device_recovery", "pixel_matte_refine", "audio_buffer_executor", "native_preview_mix_dag", "spsc_audio_ring", "sample_master_clock", "sidechain_ducking", "peak_limiter", "premultiplied_compositing", "track_matte", "adjustment_matrix", "effect_abi", "effect_sequence_abi", "scene_2_5d", "parent_hierarchy", "z_buffer", "directional_light", "particles", "depth_of_field", "motion_blur"]
                })
            );
            Ok(())
        }
        Some("engine-selftest") => {
            println!("{}", serde_json::to_string(&engine::diagnostics::selftest_receipt()?).map_err(|error| error.to_string())?);
            Ok(())
        }
        Some("engine-pipeline-selftest") => {
            let path = args.get(2).ok_or("usage: hao-core engine-pipeline-selftest <output-directory>")?;
            println!("{}", serde_json::to_string(&engine::pipeline::pipeline_selftest(std::path::Path::new(path))?).map_err(|error| error.to_string())?);
            Ok(())
        }
        Some("audio-realtime-selftest") => {
            println!("{}", serde_json::to_string(&engine::audio::realtime_transport_selftest_receipt()?).map_err(|error| error.to_string())?);
            Ok(())
        }
        Some("audio-device-selftest") => {
            println!("{}", serde_json::to_string(&engine::audio_device::physical_output_selftest_receipt()?).map_err(|error| error.to_string())?);
            Ok(())
        }
        Some("audio-device-endurance") => {
            let seconds = args
                .get(2)
                .ok_or("usage: hao-core audio-device-endurance <seconds>")?
                .parse::<u64>()
                .map_err(|_| "audio endurance seconds must be an integer")?;
            println!("{}", serde_json::to_string(&engine::audio_device::physical_output_endurance_receipt(seconds)?).map_err(|error| error.to_string())?);
            Ok(())
        }
        Some("audio-preview-recovery-selftest") => {
            println!(
                "{}",
                serde_json::to_string(
                    &engine::audio_device::physical_output_preview_recovery_selftest_receipt()?
                )
                .map_err(|error| error.to_string())?
            );
            Ok(())
        }
        Some("audio-preview-play") => {
            let path = args
                .get(2)
                .ok_or("usage: hao-core audio-preview-play <f32le-pcm> <timeline-start-seconds>")?;
            let timeline_start_seconds = args
                .get(3)
                .ok_or("usage: hao-core audio-preview-play <f32le-pcm> <timeline-start-seconds>")?
                .parse::<f64>()
                .map_err(|_| "audio preview timeline start must be a number")?;
            let bytes = fs::read(path).map_err(|error| format!("read audio preview PCM: {error}"))?;
            if bytes.is_empty() || bytes.len() > 46_080_000 * 4 || bytes.len() % 4 != 0 {
                return Err("audio preview PCM must be non-empty bounded f32le samples".into());
            }
            let mut pcm = Vec::with_capacity(bytes.len() / 4);
            for sample in bytes.chunks_exact(4) {
                pcm.push(f32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]]));
            }
            let stdout = std::io::stdout();
            let mut output = stdout.lock();
            engine::audio_device::physical_output_play_preview_pcm(
                &pcm,
                48_000,
                2,
                timeline_start_seconds,
                |event| {
                    writeln!(
                        output,
                        "{}",
                        serde_json::to_string(event).map_err(|error| error.to_string())?
                    )
                    .map_err(|error| format!("write audio preview event: {error}"))?;
                    output
                        .flush()
                        .map_err(|error| format!("flush audio preview event: {error}"))
                },
            )?;
            Ok(())
        }
        Some("audio-preview-mix") => {
            let manifest = args
                .get(2)
                .ok_or("usage: hao-core audio-preview-mix <manifest.json> <output.f32le>")?;
            let output = args
                .get(3)
                .ok_or("usage: hao-core audio-preview-mix <manifest.json> <output.f32le>")?;
            println!(
                "{}",
                serde_json::to_string(&engine::audio_preview::write_preview_audio_mix(
                    std::path::Path::new(manifest),
                    std::path::Path::new(output),
                )?)
                .map_err(|error| error.to_string())?
            );
            Ok(())
        }
        Some("audio-session-server") => {
            if args.len()!=5 { return Err("usage: hao-core audio-session-server PLAN_DIRECTORY FFMPEG SHA256".into()); }
            engine::audio_session_server::run_server(std::path::Path::new(&args[2]),std::path::Path::new(&args[3]),&args[4])
        }
        Some(command @ ("audio-codec-play" | "audio-codec-inspect")) => {
            if args.len()!=5 {return Err("usage: hao-core audio-codec-play|audio-codec-inspect PLAN FFMPEG SHA256".into());}
            let cancel=std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let reader=engine::audio_codec_stream::CodecAudioStream::open(std::path::Path::new(&args[2]),std::path::Path::new(&args[3]),&args[4],cancel.clone())?;
            let audit=reader.audit.clone();
            let result=if command=="audio-codec-inspect" {
                reader.inspect().map(|value|println!("{value}"))
            }else{
                let(generation,start,frames)=(reader.generation,reader.start_frame,reader.frame_count);
                engine::audio_device::physical_output_play_reader(reader,generation,start,frames,cancel,|event|{
                    use std::io::Write;let mut out=std::io::stdout().lock();
                    writeln!(out,"{event}").map_err(|e|e.to_string())?;out.flush().map_err(|e|e.to_string())
                }).map(|_|())
            };
            if result.is_err(){if let Ok(value)=audit.lock(){eprintln!("CODEC_CLEANUP {}",serde_json::json!({"decoders":*value}));}}
            result
        }
        Some("audio-stream-play") => {
            if args.len()!=3 {return Err("usage: hao-core audio-stream-play <plan.json>".into());}
            let reader=engine::audio_stream_file::FileAudioStream::open(std::path::Path::new(&args[2]))?;
            let cancel=std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            engine::audio_device::physical_output_play_stream(reader,cancel,|event| {
                use std::io::Write;
                let mut out=std::io::stdout().lock();
                writeln!(out,"{}",serde_json::to_string(event).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
                out.flush().map_err(|e|e.to_string())
            })?;
            Ok(())
        }
        Some("audio-stream-mix") => {
            if args.len() != 4 { return Err("usage: hao-core audio-stream-mix <plan.json> <new-output.f32le>".into()); }
            let receipt = engine::audio_stream_file::render_stream_plan(
                std::path::Path::new(&args[2]), std::path::Path::new(&args[3]),
            )?;
            println!("{}", serde_json::to_string(&receipt).map_err(|error|error.to_string())?);
            Ok(())
        }
        Some("audio-preview-mix-play") => {
            let manifest = args
                .get(2)
                .ok_or("usage: hao-core audio-preview-mix-play <manifest.json> <timeline-start-seconds>")?;
            let timeline_start_seconds = args
                .get(3)
                .ok_or("usage: hao-core audio-preview-mix-play <manifest.json> <timeline-start-seconds>")?
                .parse::<f64>()
                .map_err(|_| "audio preview timeline start must be a number")?;
            let rendered = engine::audio_preview::render_preview_audio_mix(std::path::Path::new(manifest))?;
            let mix_receipt = rendered.receipt;
            let stdout = std::io::stdout();
            let mut output = stdout.lock();
            engine::audio_device::physical_output_play_preview_pcm(
                &rendered.buffer.samples,
                rendered.buffer.sample_rate,
                rendered.buffer.channels,
                timeline_start_seconds,
                |event| {
                    let decorated = engine::audio_preview::attach_mix_receipt(event, &mix_receipt)?;
                    writeln!(
                        output,
                        "{}",
                        serde_json::to_string(&decorated).map_err(|error| error.to_string())?
                    )
                    .map_err(|error| format!("write native mix preview event: {error}"))?;
                    output
                        .flush()
                        .map_err(|error| format!("flush native mix preview event: {error}"))
                },
            )?;
            Ok(())
        }
        Some("effect-plugin-worker") => {
            let path = args.get(2).ok_or("usage: hao-core effect-plugin-worker <request.json>")?;
            let request: engine::plugin::EffectPluginRunRequest = serde_json::from_str(&fs::read_to_string(path).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
            let receipt = engine::plugin::run_plugin_worker(request)?;
            println!("{}", serde_json::to_string(&receipt).map_err(|error| error.to_string())?);
            Ok(())
        }
        Some("effect-plugin-run") => {
            let path = args.get(2).ok_or("usage: hao-core effect-plugin-run <request.json>")?;
            let request: engine::plugin::EffectPluginRunRequest = serde_json::from_str(&fs::read_to_string(path).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
            let manifest: engine::plugin::EffectPluginManifest = serde_json::from_str(&fs::read_to_string(&request.manifest_path).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
            engine::plugin::validate_plugin_manifest(&manifest)?;
            let mut child = process::Command::new(env::current_exe().map_err(|error| error.to_string())?).arg("effect-plugin-worker").arg(path).stdin(process::Stdio::null()).stdout(process::Stdio::piped()).stderr(process::Stdio::piped()).spawn().map_err(|error| format!("start effect worker: {error}"))?;
            let started = std::time::Instant::now();
            loop {
                if child.try_wait().map_err(|error|format!("poll effect worker: {error}"))?.is_some() { break; }
                if started.elapsed() >= std::time::Duration::from_millis(manifest.timeout_ms as u64) {
                    let _=child.kill(); let _=child.wait(); return Err(format!("effect plugin timed out after {} ms",manifest.timeout_ms));
                }
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
            let output=child.wait_with_output().map_err(|error|format!("collect effect worker: {error}"))?;
            if !output.status.success() { return Err(format!("isolated effect worker failed: {}",String::from_utf8_lossy(&output.stderr).trim())); }
            let receipt:String=String::from_utf8(output.stdout).map_err(|_|"effect worker returned non-UTF8 output")?;
            let parsed:serde_json::Value=serde_json::from_str(receipt.trim()).map_err(|error|format!("effect worker returned invalid receipt: {error}"))?;
            println!("{}",serde_json::json!({"schema":"editkin.effect-plugin-supervisor-receipt/v1","status":"GREEN","isolated":true,"elapsedMs":started.elapsed().as_millis(),"worker":parsed}));
            Ok(())
        }
        Some("effect-plugin-sequence-worker") => {
            let path = args.get(2).ok_or("usage: hao-core effect-plugin-sequence-worker <request.json>")?;
            let request: engine::plugin::EffectPluginSequenceRequest = serde_json::from_str(&fs::read_to_string(path).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
            let receipt = engine::plugin::run_plugin_sequence_worker(request)?;
            println!("{}", serde_json::to_string(&receipt).map_err(|error| error.to_string())?);
            Ok(())
        }
        Some("effect-plugin-sequence-run") => {
            let path = args.get(2).ok_or("usage: hao-core effect-plugin-sequence-run <request.json>")?;
            let request: engine::plugin::EffectPluginSequenceRequest = serde_json::from_str(&fs::read_to_string(path).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
            let manifest: engine::plugin::EffectPluginManifest = serde_json::from_str(&fs::read_to_string(&request.manifest_path).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
            engine::plugin::validate_plugin_manifest(&manifest)?;
            let timeout_ms = u64::from(manifest.timeout_ms)
                .checked_mul(u64::from(request.frame_count.max(1)))
                .unwrap_or(600_000)
                .saturating_add(250)
                .min(600_000);
            let mut child = process::Command::new(env::current_exe().map_err(|error| error.to_string())?)
                .arg("effect-plugin-sequence-worker")
                .arg(path)
                .stdin(process::Stdio::null())
                .stdout(process::Stdio::piped())
                .stderr(process::Stdio::piped())
                .spawn()
                .map_err(|error| format!("start effect sequence worker: {error}"))?;
            let temporary_output = engine::plugin::sequence_temp_output_path(&request.output_path, child.id());
            let started = std::time::Instant::now();
            loop {
                if child.try_wait().map_err(|error| format!("poll effect sequence worker: {error}"))?.is_some() {
                    break;
                }
                if started.elapsed() >= std::time::Duration::from_millis(timeout_ms) {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = fs::remove_file(&temporary_output);
                    return Err(format!("effect plugin sequence timed out after {timeout_ms} ms"));
                }
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
            let output = child.wait_with_output().map_err(|error| format!("collect effect sequence worker: {error}"))?;
            if !output.status.success() {
                let _ = fs::remove_file(&temporary_output);
                return Err(format!("isolated effect sequence worker failed: {}", String::from_utf8_lossy(&output.stderr).trim()));
            }
            let receipt = String::from_utf8(output.stdout).map_err(|_| "effect sequence worker returned non-UTF8 output")?;
            let parsed: serde_json::Value = serde_json::from_str(receipt.trim()).map_err(|error| format!("effect sequence worker returned invalid receipt: {error}"))?;
            println!("{}", serde_json::json!({"schema":"editkin.effect-plugin-sequence-supervisor-receipt/v1","status":"GREEN","isolated":true,"elapsedMs":started.elapsed().as_millis(),"worker":parsed}));
            Ok(())
        }
        Some("auto-roto") => {
            let path = args.get(2).ok_or("usage: hao-core auto-roto <request.json>")?;
            let request: engine::auto_roto::AutoRotoRequest = serde_json::from_str(&fs::read_to_string(path).map_err(|error| error.to_string())?).map_err(|error| error.to_string())?;
            let receipt = engine::auto_roto::run_auto_roto(request)?;
            println!("{}", serde_json::to_string(&receipt).map_err(|error| error.to_string())?);
            Ok(())
        }
        Some("version") => {
            println!("hao-core 0.4.0");
            Ok(())
        }
        _ => Err(
            "usage: hao-core <plan PROJECT|smart-cut ANALYSIS|motion-track REQUEST|auto-roto REQUEST|engine-compile GRAPH|engine-dirty GRAPH NODE...|engine-capabilities|engine-selftest|engine-pipeline-selftest OUTPUT_DIR|audio-realtime-selftest|audio-device-selftest|audio-device-endurance SECONDS|audio-preview-recovery-selftest|audio-preview-play F32LE TIMELINE_START|audio-preview-mix MANIFEST OUTPUT|audio-stream-mix PLAN NEW_OUTPUT|audio-session-server PLAN_DIRECTORY FFMPEG SHA256|audio-codec-play PLAN FFMPEG SHA256|audio-codec-inspect PLAN FFMPEG SHA256|audio-preview-mix-play MANIFEST TIMELINE_START|effect-plugin-run REQUEST|effect-plugin-sequence-run REQUEST|version>".into(),
        ),
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("hao-core: {error}");
        process::exit(2);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aligns_frames_and_inserts_gap() {
        let project = Project {
            fps: 30.0,
            tracks: vec![Track {
                id: "video-main".into(),
                kind: "video".into(),
                muted: false,
                clips: vec![Clip {
                    id: "clip-1".into(),
                    asset_id: "asset-1".into(),
                    timeline_start: 1.0,
                    source_start: 0.5,
                    duration: 2.0,
                }],
            }],
            captions: vec![Caption {
                id: "caption-1".into(),
                text: "Hello".into(),
                start: 0.0,
                duration: 1.0,
            }],
        };
        let plan = build_plan(project).expect("plan");
        assert_eq!(plan.duration_frames, 90);
        assert_eq!(plan.layers[0].segments.len(), 2);
        match &plan.layers[0].segments[0] {
            Segment::Gap {
                duration_frames, ..
            } => assert_eq!(*duration_frames, 30),
            _ => panic!("expected gap"),
        }
    }

    #[test]
    fn accepts_overlap_across_tracks_but_rejects_within_one_track() {
        let clip = |id: &str, start: f64| Clip {
            id: id.into(),
            asset_id: "asset".into(),
            timeline_start: start,
            source_start: 0.0,
            duration: 2.0,
        };
        let project = Project {
            fps: 30.0,
            tracks: vec![Track {
                id: "main".into(),
                kind: "video".into(),
                muted: false,
                clips: vec![clip("a", 0.0), clip("b", 1.0)],
            }],
            captions: vec![],
        };
        assert!(build_plan(project).is_err());

        let layered = Project {
            fps: 30.0,
            tracks: vec![
                Track {
                    id: "main".into(),
                    kind: "video".into(),
                    muted: false,
                    clips: vec![clip("a", 0.0)],
                },
                Track {
                    id: "overlay".into(),
                    kind: "video".into(),
                    muted: false,
                    clips: vec![clip("b", 1.0)],
                },
            ],
            captions: vec![],
        };
        assert_eq!(build_plan(layered).expect("layered plan").layers.len(), 2);
    }

    #[test]
    fn smart_cut_pads_silence_and_returns_frame_ranges() {
        let plan = build_smart_cut(SmartCutRequest {
            fps: 30.0,
            duration: 10.0,
            silences: vec![
                TimeRange {
                    start: 2.0,
                    end: 4.0,
                },
                TimeRange {
                    start: 6.0,
                    end: 7.0,
                },
            ],
            options: SmartCutOptions {
                padding: 0.1,
                min_silence: 0.35,
                min_keep: 0.25,
            },
        })
        .expect("smart cut");
        assert_eq!(
            plan.ranges,
            vec![
                FrameRange {
                    start_frame: 0,
                    end_frame: 63
                },
                FrameRange {
                    start_frame: 117,
                    end_frame: 183
                },
                FrameRange {
                    start_frame: 207,
                    end_frame: 300
                },
            ]
        );
        assert_eq!(plan.removed_frames, 78);
        assert_eq!(plan.cut_count, 2);
    }

    #[test]
    fn smart_cut_merges_short_speech_islands_and_rejects_remove_all() {
        let plan = build_smart_cut(SmartCutRequest {
            fps: 30.0,
            duration: 5.0,
            silences: vec![
                TimeRange {
                    start: 1.0,
                    end: 2.0,
                },
                TimeRange {
                    start: 2.1,
                    end: 3.0,
                },
            ],
            options: SmartCutOptions {
                padding: 0.0,
                min_silence: 0.2,
                min_keep: 0.25,
            },
        })
        .expect("merged smart cut");
        assert_eq!(
            plan.ranges,
            vec![
                FrameRange {
                    start_frame: 0,
                    end_frame: 30
                },
                FrameRange {
                    start_frame: 90,
                    end_frame: 150
                },
            ]
        );

        let all = build_smart_cut(SmartCutRequest {
            fps: 30.0,
            duration: 1.0,
            silences: vec![TimeRange {
                start: 0.0,
                end: 1.0,
            }],
            options: SmartCutOptions {
                padding: 0.0,
                min_silence: 0.1,
                min_keep: 0.25,
            },
        });
        assert!(all.is_err());
    }

    #[test]
    fn motion_tracker_follows_a_translating_subject() {
        let width = 64_usize;
        let height = 48_usize;
        let frame_count = 8_usize;
        let mut frames = vec![24_u8; width * height * frame_count];
        for frame in 0..frame_count {
            let x = 8 + frame * 2;
            for y in 14..26 {
                for column in x..x + 12 {
                    frames[frame * width * height + y * width + column] =
                        if (column + y) % 2 == 0 { 235 } else { 180 };
                }
            }
        }
        let path = env::temp_dir().join(format!(
            "hao-core-motion-track-{}-{}.raw",
            process::id(),
            frame_count
        ));
        fs::write(&path, &frames).expect("raw fixture");
        let plan = build_motion_track(MotionTrackRequest {
            raw_path: path.to_string_lossy().to_string(),
            width,
            height,
            frame_count,
            analysis_fps: 10.0,
            initial_frame: 0,
            initial_rect: NormalizedRect {
                x: 8.0 / width as f64,
                y: 14.0 / height as f64,
                width: 12.0 / width as f64,
                height: 12.0 / height as f64,
            },
            search_radius: 0.8,
            confidence_threshold: 0.45,
            max_hold_frames: 2,
            max_rotation_step: 8.0,
        })
        .expect("motion track");
        let _ = fs::remove_file(path);
        assert_eq!(plan.points.len(), frame_count);
        assert!(plan.lost_ratio < 0.2);
        assert!((plan.points.last().unwrap().rect.x - 22.0 / width as f64).abs() < 0.08);
    }
}
