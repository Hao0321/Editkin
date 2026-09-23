#[cfg(feature = "auto-roto-research-onnx")]
use ort::session::Session;
#[cfg(feature = "auto-roto-research-onnx")]
use ort::value::{Tensor, TensorElementType, ValueType};
use serde::{Deserialize, Serialize};
#[cfg(feature = "auto-roto-research-onnx")]
use sha2::{Digest, Sha256};
#[cfg(feature = "auto-roto-research-onnx")]
use std::fs;
#[cfg(feature = "auto-roto-research-onnx")]
use std::path::Path;
use std::path::PathBuf;
#[cfg(feature = "auto-roto-research-onnx")]
use std::sync::OnceLock;

#[cfg(feature = "auto-roto-research-onnx")]
const PACK_SCHEMA: &str = "editkin.auto-roto-onnx-pack/v1";
#[cfg(feature = "auto-roto-research-onnx")]
const FEATURE_CONTRACT: &str = "foreground-logit";
#[cfg(feature = "auto-roto-research-onnx")]
const OUTPUT_CONTRACT: &str = "probability";

#[cfg(feature = "auto-roto-research-onnx")]
static INITIALIZED_RUNTIME: OnceLock<Result<PathBuf, String>> = OnceLock::new();

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnnxRotoPackRequest {
    pub trusted_root: PathBuf,
    pub manifest_path: PathBuf,
    #[serde(default)]
    pub allow_integration_fixture: bool,
}

#[cfg(feature = "auto-roto-research-onnx")]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OnnxRotoPackManifest {
    schema: String,
    id: String,
    version: String,
    quality_tier: String,
    model_path: String,
    model_sha256: String,
    runtime_path: String,
    runtime_sha256: String,
    runtime_version: String,
    runtime_version_path: String,
    runtime_version_sha256: String,
    license_path: String,
    license_sha256: String,
    input_name: String,
    output_name: String,
    input_shape: Vec<usize>,
    feature_contract: String,
    output_contract: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OnnxRotoModelReceipt {
    pub schema: &'static str,
    pub id: String,
    pub version: String,
    pub quality_tier: String,
    pub model_sha256: String,
    pub runtime_sha256: String,
    pub runtime_version: String,
    pub runtime_version_sha256: String,
    pub license_sha256: String,
    pub input_name: String,
    pub output_name: String,
    pub tensor_elements: usize,
    pub inference_calls: usize,
}

#[cfg(feature = "auto-roto-research-onnx")]
pub struct OnnxRotoSession {
    session: Session,
    receipt: OnnxRotoModelReceipt,
}

#[cfg(not(feature = "auto-roto-research-onnx"))]
pub struct OnnxRotoSession;

#[cfg(feature = "auto-roto-research-onnx")]
fn sha256_file(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|error| format!("read ONNX pack file: {error}"))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

#[cfg(feature = "auto-roto-research-onnx")]
fn validate_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(feature = "auto-roto-research-onnx")]
fn trusted_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.trim().is_empty() || Path::new(relative).is_absolute() || relative.contains('\\') {
        return Err("ONNX pack path must be a non-empty POSIX relative path".into());
    }
    let candidate = fs::canonicalize(root.join(relative))
        .map_err(|error| format!("resolve ONNX pack path {relative}: {error}"))?;
    if !candidate.starts_with(root) || !candidate.is_file() {
        return Err(format!("ONNX pack path escapes trusted root: {relative}"));
    }
    Ok(candidate)
}

#[cfg(feature = "auto-roto-research-onnx")]
fn initialize_runtime(runtime_path: &Path) -> Result<(), String> {
    let initialized = INITIALIZED_RUNTIME.get_or_init(|| {
        ort::init_from(runtime_path)
            .map_err(|error| format!("load ONNX Runtime: {error}"))?
            .with_name("editkin-auto-roto")
            .commit();
        Ok(runtime_path.to_path_buf())
    });
    match initialized {
        Ok(path) if path == runtime_path => Ok(()),
        Ok(_) => Err("a different ONNX Runtime is already initialized".into()),
        Err(error) => Err(error.clone()),
    }
}

#[cfg(feature = "auto-roto-research-onnx")]
impl OnnxRotoSession {
    pub fn load(request: &OnnxRotoPackRequest) -> Result<Self, String> {
        let trusted_root = fs::canonicalize(&request.trusted_root)
            .map_err(|error| format!("resolve ONNX trusted root: {error}"))?;
        if !trusted_root.is_dir() {
            return Err("ONNX trusted root is not a directory".into());
        }
        let manifest_path = fs::canonicalize(&request.manifest_path)
            .map_err(|error| format!("resolve ONNX manifest: {error}"))?;
        if !manifest_path.starts_with(&trusted_root) || !manifest_path.is_file() {
            return Err("ONNX manifest escapes trusted root".into());
        }
        let manifest: OnnxRotoPackManifest = serde_json::from_slice(
            &fs::read(&manifest_path).map_err(|error| format!("read ONNX manifest: {error}"))?,
        )
        .map_err(|error| format!("parse ONNX manifest: {error}"))?;
        if manifest.schema != PACK_SCHEMA
            || manifest.id.trim().is_empty()
            || manifest.id.len() > 128
            || manifest.version.trim().is_empty()
            || !matches!(
                manifest.quality_tier.as_str(),
                "production" | "integration_fixture"
            )
            || manifest.feature_contract != FEATURE_CONTRACT
            || manifest.output_contract != OUTPUT_CONTRACT
            || manifest.input_name.trim().is_empty()
            || manifest.output_name.trim().is_empty()
            || manifest.input_shape != [3, 4, 5]
            || ![
                &manifest.model_sha256,
                &manifest.runtime_sha256,
                &manifest.runtime_version_sha256,
                &manifest.license_sha256,
            ]
            .iter()
            .all(|value| validate_sha256(value))
        {
            return Err("invalid ONNX Auto Roto pack manifest".into());
        }
        if manifest.quality_tier == "integration_fixture" && !request.allow_integration_fixture {
            return Err(
                "integration-only ONNX Auto Roto pack is not allowed in product mode".into(),
            );
        }

        let model_path = trusted_path(&trusted_root, &manifest.model_path)?;
        let runtime_path = trusted_path(&trusted_root, &manifest.runtime_path)?;
        let runtime_version_path = trusted_path(&trusted_root, &manifest.runtime_version_path)?;
        let license_path = trusted_path(&trusted_root, &manifest.license_path)?;
        for (label, path, expected) in [
            ("model", &model_path, &manifest.model_sha256),
            ("runtime", &runtime_path, &manifest.runtime_sha256),
            (
                "runtime version",
                &runtime_version_path,
                &manifest.runtime_version_sha256,
            ),
            ("license", &license_path, &manifest.license_sha256),
        ] {
            if sha256_file(path)? != expected.to_ascii_lowercase() {
                return Err(format!("ONNX Auto Roto {label} SHA-256 mismatch"));
            }
        }
        let observed_runtime_version = fs::read_to_string(&runtime_version_path)
            .map_err(|error| format!("read ONNX Runtime version: {error}"))?;
        if observed_runtime_version.trim() != manifest.runtime_version {
            return Err("ONNX Runtime version file does not match its manifest".into());
        }
        initialize_runtime(&runtime_path)?;
        let session = Session::builder()
            .map_err(|error| format!("create ONNX session builder: {error}"))?
            .with_intra_threads(1)
            .map_err(|error| format!("configure ONNX session: {error}"))?
            .commit_from_file(&model_path)
            .map_err(|error| format!("load ONNX Auto Roto model: {error}"))?;
        if session.inputs().len() != 1
            || session.outputs().len() != 1
            || session.inputs()[0].name() != manifest.input_name
            || session.outputs()[0].name() != manifest.output_name
        {
            return Err("ONNX Auto Roto model I/O names do not match its manifest".into());
        }
        let expected_shape = manifest
            .input_shape
            .iter()
            .map(|value| *value as i64)
            .collect::<Vec<_>>();
        let input_ok = matches!(
            session.inputs()[0].dtype(),
            ValueType::Tensor { ty: TensorElementType::Float32, shape, .. }
                if shape.as_ref() == expected_shape.as_slice()
        );
        let output_ok = matches!(
            session.outputs()[0].dtype(),
            ValueType::Tensor { ty: TensorElementType::Float32, shape, .. }
                if shape.as_ref() == expected_shape.as_slice()
        );
        if !input_ok || !output_ok {
            return Err("ONNX Auto Roto model tensor schema does not match its manifest".into());
        }
        let tensor_elements = manifest
            .input_shape
            .iter()
            .try_fold(1_usize, |total, value| total.checked_mul(*value))
            .ok_or("ONNX Auto Roto tensor size overflow")?;
        Ok(Self {
            session,
            receipt: OnnxRotoModelReceipt {
                schema: PACK_SCHEMA,
                id: manifest.id,
                version: manifest.version,
                quality_tier: manifest.quality_tier,
                model_sha256: manifest.model_sha256.to_ascii_lowercase(),
                runtime_sha256: manifest.runtime_sha256.to_ascii_lowercase(),
                runtime_version: manifest.runtime_version,
                runtime_version_sha256: manifest.runtime_version_sha256.to_ascii_lowercase(),
                license_sha256: manifest.license_sha256.to_ascii_lowercase(),
                input_name: manifest.input_name,
                output_name: manifest.output_name,
                tensor_elements,
                inference_calls: 0,
            },
        })
    }

    pub fn calibrate_probabilities(&mut self, logits: &[f32]) -> Result<Vec<f32>, String> {
        if logits.is_empty() || logits.iter().any(|value| !value.is_finite()) {
            return Err("invalid ONNX Auto Roto logits".into());
        }
        let chunk_size = self.receipt.tensor_elements;
        let mut output = Vec::with_capacity(logits.len());
        for chunk in logits.chunks(chunk_size) {
            let mut padded = vec![0.0_f32; chunk_size];
            padded[..chunk.len()].copy_from_slice(chunk);
            let input = Tensor::from_array((vec![3_usize, 4, 5], padded.into_boxed_slice()))
                .map_err(|error| format!("create ONNX Auto Roto tensor: {error}"))?;
            let outputs = self
                .session
                .run(ort::inputs![self.receipt.input_name.as_str() => input])
                .map_err(|error| format!("run ONNX Auto Roto model: {error}"))?;
            let value = outputs
                .get(self.receipt.output_name.as_str())
                .ok_or("ONNX Auto Roto output is missing")?;
            let (shape, values) = value
                .try_extract_tensor::<f32>()
                .map_err(|error| format!("read ONNX Auto Roto output: {error}"))?;
            if shape.as_ref() != [3_i64, 4, 5] || values.len() != chunk_size {
                return Err("ONNX Auto Roto output shape changed at runtime".into());
            }
            if values
                .iter()
                .any(|value| !value.is_finite() || !(0.0..=1.0).contains(value))
            {
                return Err("ONNX Auto Roto returned invalid probabilities".into());
            }
            output.extend_from_slice(&values[..chunk.len()]);
            self.receipt.inference_calls += 1;
        }
        Ok(output)
    }

    pub fn receipt(&self) -> OnnxRotoModelReceipt {
        self.receipt.clone()
    }
}

#[cfg(not(feature = "auto-roto-research-onnx"))]
impl OnnxRotoSession {
    pub fn load(_request: &OnnxRotoPackRequest) -> Result<Self, String> {
        Err("external ONNX Auto Roto runtime is not compiled into the product binary".into())
    }

    pub fn calibrate_probabilities(&mut self, _logits: &[f32]) -> Result<Vec<f32>, String> {
        Err("external ONNX Auto Roto runtime is not compiled into the product binary".into())
    }

    pub fn receipt(&self) -> OnnxRotoModelReceipt {
        unreachable!("product binary cannot construct an external ONNX Auto Roto session")
    }
}
