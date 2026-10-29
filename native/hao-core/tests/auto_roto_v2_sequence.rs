use hao_core::engine::auto_roto::{AutoRotoRequest, run_auto_roto};
use hao_core::engine::auto_roto_v2::{AutoRotoCliReceipt, run_auto_roto_cli};
use hao_core::engine::roto_edge_v2::RotoEdgeSettingsV2;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Cursor;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

struct Case {
    root: PathBuf,
    keep: bool,
}
impl Case {
    fn new(label: &str) -> Self {
        let selected = if label == "layout" {
            std::env::var("EDITKIN_ROTO_V2_SEQUENCE_EVIDENCE").ok()
        } else {
            None
        };
        let keep = selected.is_some();
        let root = selected.map(PathBuf::from).unwrap_or_else(|| {
            std::env::temp_dir().join(format!(
                "editkin-roto-v2-{label}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ))
        });
        fs::create_dir(&root).unwrap();
        let mut rgb = vec![24_u8; 32 * 24 * 5 * 3];
        for frame in 0..5 {
            for y in 6..19 {
                for x in 8 + frame..23 + frame {
                    let i = ((frame * 24 + y) * 32 + x) * 3;
                    rgb[i..i + 3].copy_from_slice(&[224, 58, 46]);
                }
            }
        }
        fs::write(root.join("frames.rgb24"), rgb).unwrap();
        Self { root, keep }
    }
    fn value(&self, name: &str, edge: bool, high: bool) -> Value {
        let mut value = json!({"rawPath":self.root.join("frames.rgb24"),"outputDir":self.root.join(name),
            "width":32,"height":24,"frameCount":5,"analysisFps":4,"initialFrame":2,
            "initialRect":{"x":0.25,"y":0.25,"width":0.5,"height":0.55},"temporalStability":0.2,
            "feather":0.02,"edgeShift":0,"contrast":1.7,"corrections":[],
            "regionMemoryPolicy":if edge { "guarded_experimental" } else { "fixed_baseline" }});
        if edge {
            value["edgeRefine"] = serde_json::to_value(RotoEdgeSettingsV2 {
                alpha16: high,
                ..Default::default()
            })
            .unwrap();
        }
        value
    }
}
impl Drop for Case {
    fn drop(&mut self) {
        if !self.keep {
            fs::remove_dir_all(&self.root).unwrap();
        }
    }
}

#[test]
fn v1_default_and_untagged_cli_serialization_stay_exact() {
    let case = Case::new("v1");
    let request: AutoRotoRequest = serde_json::from_value(case.value("old", false, false)).unwrap();
    assert!(request.edge_refine.is_none());
    let old = run_auto_roto(request).unwrap();
    let bytes = serde_json::to_vec(&old).unwrap();
    assert_eq!(
        serde_json::to_vec(&AutoRotoCliReceipt::V1(old)).unwrap(),
        bytes
    );
    let result =
        run_auto_roto_cli(serde_json::from_value(case.value("cli", false, false)).unwrap())
            .unwrap();
    let value = serde_json::to_value(result).unwrap();
    assert_eq!(value["schema"], "editkin.auto-roto-matte/v1");
    assert_eq!(value["regionMemoryRouting"]["executed"], "fixed_baseline");
    assert!(value.get("edgeSettings").is_none());
}

#[test]
fn actual_cli_v2_writes_exact_8_and_16bit_frame_sequences() {
    let case = Case::new("layout");
    let executable = PathBuf::from(env!("CARGO_BIN_EXE_hao-core"));
    let exe_sha = format!("{:x}", Sha256::digest(fs::read(&executable).unwrap()));
    let mut executions = Vec::new();
    for high in [false, true] {
        let name = if high { "out-16" } else { "out-8" };
        let value = case.value(name, true, high);
        let request_path = case.root.join(format!("{name}-request.json"));
        fs::write(&request_path, serde_json::to_vec_pretty(&value).unwrap()).unwrap();
        let mut command = Command::new(&executable);
        command.args(["auto-roto"]).arg(&request_path);
        let started = std::time::Instant::now();
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["schema"], "editkin.auto-roto-matte/v2");
        assert_eq!(result["engine"], "editkin-native-roto-edge/v2");
        assert_eq!(result["qualityState"], "diagnostic");
        assert_eq!(result["coarseRouting"]["requested"], "guarded_experimental");
        assert_eq!(result["frames"].as_array().unwrap().len(), 5);
        let root = case.root.join(name);
        let size = 32 * 24 * 5;
        let alpha = fs::read(root.join(result["alphaPath"].as_str().unwrap())).unwrap();
        assert_eq!(alpha.len(), size * if high { 2 } else { 1 });
        assert_eq!(
            fs::read(root.join("foreground.rgb24")).unwrap().len(),
            size * 3
        );
        assert_eq!(
            result["sourceRawSha256"],
            format!(
                "{:x}",
                Sha256::digest(fs::read(case.root.join("frames.rgb24")).unwrap())
            )
        );
        for frame in 0..5 {
            assert_eq!(result["frames"][frame]["frame"], frame);
            assert_eq!(result["frames"][frame]["time"], frame as f64 / 4.0);
            assert_eq!(
                result["frames"][frame]["edgeRefinement"]["qualityState"],
                "diagnostic"
            );
            let bytes = fs::read(root.join(format!("frame-{frame:06}.png"))).unwrap();
            let mut decoder = png::Decoder::new(Cursor::new(bytes));
            decoder.set_transformations(png::Transformations::IDENTITY);
            let mut reader = decoder.read_info().unwrap();
            let mut pixels = vec![0; reader.output_buffer_size().unwrap()];
            let info = reader.next_frame(&mut pixels).unwrap();
            let slice = &alpha[frame * 32 * 24 * if high { 2 } else { 1 }
                ..(frame + 1) * 32 * 24 * if high { 2 } else { 1 }];
            if high {
                assert_eq!(info.bit_depth, png::BitDepth::Sixteen);
                let little: Vec<u8> = pixels[..info.buffer_size()]
                    .chunks_exact(2)
                    .flat_map(|b| u16::from_be_bytes([b[0], b[1]]).to_le_bytes())
                    .collect();
                assert_eq!(little, slice);
            } else {
                assert_eq!(info.bit_depth, png::BitDepth::Eight);
                assert_eq!(&pixels[..info.buffer_size()], slice);
            }
        }
        assert!(String::from_utf8_lossy(&output.stderr).contains("ROTO_V2_PROGRESS 5/5"));
        let committed: Value =
            serde_json::from_slice(&fs::read(root.join("matte-v2-manifest.json")).unwrap())
                .unwrap();
        assert_eq!(result, committed);
        executions.push(json!({"executable":executable,"executableSha256":exe_sha,"request":request_path,"exitCode":output.status.code(),
            "closed":true,"elapsedSeconds":started.elapsed().as_secs_f64(),"stdoutSha256":format!("{:x}",Sha256::digest(&output.stdout)),"stderr":String::from_utf8_lossy(&output.stderr)}));
    }
    if case.keep {
        fs::write(
            case.root.join("CLI_EXECUTIONS.json"),
            serde_json::to_vec_pretty(&executions).unwrap(),
        )
        .unwrap();
    }
}

#[test]
fn manual_soft_background_correction_is_not_erased_or_applied_twice() {
    let case = Case::new("brush");
    let mut value = case.value("result", true, true);
    value["corrections"] = json!([{"id":"manual-bg","frame":2,"mode":"background","radius":0.12,"points":[{"x":16.0/31.0,"y":12.0/23.0}]}]);
    let result = run_auto_roto_cli(serde_json::from_value(value).unwrap()).unwrap();
    let value = serde_json::to_value(result).unwrap();
    let root = case.root.join("result");
    let coarse = fs::read(root.join("coarse/matte-sequence.alpha8")).unwrap();
    let high = fs::read(root.join("matte-sequence.alpha16le")).unwrap();
    for x in [16, 17] {
        let i = (2 * 24 + 12) * 32 + x;
        let a = u16::from_le_bytes([high[i * 2], high[i * 2 + 1]]);
        assert_eq!(a, coarse[i] as u16 * 257);
    }
    assert!(value["frames"][2]["manualPixelsRestored"].as_u64().unwrap() > 0);
    assert_eq!(value["correctionStrokesApplied"], 1);
}

#[test]
fn unsafe_layout_policy_and_existing_directory_fail_before_writes() {
    let case = Case::new("refuse");
    for patch in [
        json!({"frameCount":1441}),
        json!({"width":usize::MAX}),
        json!({"analysisFps":0}),
        json!({"regionMemoryPolicy":"fixed_baseline"}),
        json!({"frameCount":6}),
    ] {
        let mut value = case.value("reject", true, true);
        for (k, v) in patch.as_object().unwrap() {
            value[k] = v.clone();
        }
        assert!(run_auto_roto_cli(serde_json::from_value(value).unwrap()).is_err());
        assert!(!case.root.join("reject").exists());
    }
    fs::create_dir(case.root.join("existing")).unwrap();
    fs::write(case.root.join("existing/keep.txt"), b"keep").unwrap();
    assert!(
        run_auto_roto_cli(serde_json::from_value(case.value("existing", true, true)).unwrap())
            .is_err()
    );
    assert_eq!(
        fs::read(case.root.join("existing/keep.txt")).unwrap(),
        b"keep"
    );
}

#[test]
fn v2_edge_settings_and_model_injection_are_closed_and_v1_api_cannot_ignore_them() {
    let case = Case::new("closed");
    let mut value = case.value("reject", true, true);
    value["edgeRefine"]["model"] = json!("sam");
    assert!(serde_json::from_value::<AutoRotoRequest>(value).is_err());
    let mut value = case.value("reject", true, true);
    value["onnxPack"] = json!({});
    assert!(serde_json::from_value::<AutoRotoRequest>(value).is_err());
    let value = case.value("reject", true, true);
    assert!(run_auto_roto(serde_json::from_value(value).unwrap()).is_err());
    assert!(!case.root.join("reject").exists());
}
