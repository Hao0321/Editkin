use hao_core::engine::auto_roto::{
    run_auto_roto, AutoRotoRequest, RegionMemoryRoutePolicy, RotoCorrectionMode,
    RotoCorrectionStroke, RotoPoint, RotoRect,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const WIDTH: usize = 40;
const HEIGHT: usize = 30;
const FRAMES: usize = 7;
const SEED_FRAME: usize = 3;

fn workspace(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock after epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "editkin-auto-roto-pixel-matte-{label}-{}-{nonce}",
        std::process::id()
    ))
}

fn fixture_frames() -> Vec<u8> {
    let mut bytes = vec![18_u8; WIDTH * HEIGHT * FRAMES * 3];
    for frame in 0..FRAMES {
        let left = 9 + frame;
        for y in 8..23 {
            for x in left..left + 15 {
                let offset = (frame * WIDTH * HEIGHT + y * WIDTH + x) * 3;
                bytes[offset..offset + 3].copy_from_slice(&[224, 58, 46]);
            }
        }
    }
    bytes
}

fn request(
    raw_path: &Path,
    output_dir: PathBuf,
    corrections: Vec<RotoCorrectionStroke>,
) -> AutoRotoRequest {
    AutoRotoRequest {
        raw_path: raw_path.to_path_buf(),
        output_dir,
        width: WIDTH,
        height: HEIGHT,
        frame_count: FRAMES,
        analysis_fps: 12.0,
        initial_frame: SEED_FRAME,
        initial_rect: RotoRect {
            x: 11.0 / WIDTH as f64,
            y: 7.0 / HEIGHT as f64,
            width: 18.0 / WIDTH as f64,
            height: 17.0 / HEIGHT as f64,
        },
        temporal_stability: 0.82,
        feather: 0.02,
        edge_shift: 0.0,
        contrast: 1.7,
        corrections,
        region_memory_policy: RegionMemoryRoutePolicy::FixedBaseline,
    }
}

fn frame_difference(left: &[u8], right: &[u8], frame: usize) -> u64 {
    let frame_bytes = WIDTH * HEIGHT;
    let start = frame * frame_bytes;
    left[start..start + frame_bytes]
        .iter()
        .zip(&right[start..start + frame_bytes])
        .map(|(left, right)| u64::from(left.abs_diff(*right)))
        .sum()
}

fn alpha_at(sequence: &[u8], frame: usize, normalized_x: f64, normalized_y: f64) -> u8 {
    let x = (normalized_x * (WIDTH - 1) as f64).round() as usize;
    let y = (normalized_y * (HEIGHT - 1) as f64).round() as usize;
    sequence[frame * WIDTH * HEIGHT + y * WIDTH + x]
}

#[test]
fn streamed_product_route_propagates_seed_corrections_both_directions_and_freezes_every_pixel() {
    let root = workspace("bidirectional-correction");
    fs::create_dir_all(&root).expect("create fixture root");
    let raw_path = root.join("frames.rgb24");
    fs::write(&raw_path, fixture_frames()).expect("write fixture frames");

    let baseline = run_auto_roto(request(&raw_path, root.join("baseline"), vec![]))
        .expect("baseline product route");
    let corrected = run_auto_roto(request(
        &raw_path,
        root.join("corrected"),
        vec![
            RotoCorrectionStroke {
                id: "remove-seed-center".into(),
                frame: SEED_FRAME,
                mode: RotoCorrectionMode::Background,
                radius: 0.18,
                points: vec![RotoPoint { x: 0.49, y: 0.5 }],
            },
            RotoCorrectionStroke {
                id: "keep-seed-corner".into(),
                frame: SEED_FRAME,
                mode: RotoCorrectionMode::Foreground,
                radius: 0.07,
                points: vec![RotoPoint { x: 0.12, y: 0.15 }],
            },
        ],
    ))
    .expect("corrected product route");

    let baseline_alpha = fs::read(&baseline.sequence_path).expect("read baseline alpha");
    let corrected_alpha = fs::read(&corrected.sequence_path).expect("read corrected alpha");
    let expected_bytes = WIDTH * HEIGHT * FRAMES;

    assert_eq!(baseline_alpha.len(), expected_bytes);
    assert_eq!(corrected_alpha.len(), expected_bytes);
    assert_eq!(corrected.frames.len(), FRAMES);
    assert_eq!(corrected.alpha_refinement.applied_frames, FRAMES);
    assert_eq!(corrected.correction_strokes_applied, 2);
    assert_eq!(corrected.corrected_frames, vec![SEED_FRAME]);
    assert!(corrected.frozen);
    assert_eq!(corrected.region_memory_routing.executed, "fixed_baseline");

    let removed_baseline = alpha_at(&baseline_alpha, SEED_FRAME, 0.49, 0.5);
    let removed_corrected = alpha_at(&corrected_alpha, SEED_FRAME, 0.49, 0.5);
    assert!(
        removed_corrected < removed_baseline,
        "a Background correction must lower alpha at its seed point: {removed_baseline} -> {removed_corrected}",
    );
    let kept_baseline = alpha_at(&baseline_alpha, SEED_FRAME, 0.12, 0.15);
    let kept_corrected = alpha_at(&corrected_alpha, SEED_FRAME, 0.12, 0.15);
    assert!(
        kept_corrected > kept_baseline,
        "a Foreground correction must raise alpha at its seed point: {kept_baseline} -> {kept_corrected}",
    );

    assert!(frame_difference(&baseline_alpha, &corrected_alpha, SEED_FRAME) > 0);
    assert!(
        (0..SEED_FRAME).any(|frame| frame_difference(&baseline_alpha, &corrected_alpha, frame) > 0),
        "a correction on an interior seed must affect at least one earlier frame",
    );
    assert!(
        (SEED_FRAME + 1..FRAMES).any(|frame| frame_difference(
            &baseline_alpha,
            &corrected_alpha,
            frame
        ) > 0),
        "a correction on an interior seed must affect at least one later frame",
    );
    assert!(corrected
        .frames
        .iter()
        .all(|frame| frame.alpha_path.is_file()));
    assert!(root.join("corrected/matte-manifest.json").is_file());

    fs::remove_dir_all(root).expect("remove fixture root");
}
