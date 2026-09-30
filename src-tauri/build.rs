use sha2::{Digest, Sha256};
use std::{env, fs, io::Read, path::PathBuf};

// Deliberately reviewed native attestation, not a value copied from the incoming
// manifest. This scope keeps the owner-authorized visual grant while separating
// the mutable product evidence ledger from executable runtime build identity.
const EDITKIN_PRODUCT_POLICY_SHA256: &str =
    "163608ac9aeb7da11b3db6c8753ac9fe5d7c288f1b72467d28400d2be75f905a";

fn main() {
    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    // Community verification cannot attest the owner-only delivered product.
    // Keep its identity distinct so it cannot satisfy the official release gate.
    if cfg!(feature = "community-desktop") {
        let mut files = serde_json::Map::new();
        let root = manifest_dir.parent().expect("community source root");
        for relative in [
            "package-lock.json",
            "desktop-dist/service.mjs",
            "src-tauri/Cargo.toml",
            "src-tauri/Cargo.lock",
            "src-tauri/build.rs",
            "src-tauri/tauri.conf.json",
            "src-tauri/remote-relay.json",
            "native/hao-core/src/engine/audio_session_protocol.rs",
        ] {
            hash_community_inputs(root, &root.join(relative), &mut files);
        }
        for relative in ["src-tauri/src", "src-tauri/capabilities", "src/shared", "native/shared", "dist"] {
            hash_community_inputs(root, &root.join(relative), &mut files);
        }
        files.sort_keys();
        let identity = serde_json::json!({
            "schemaVersion": 1,
            "product": "Editkin",
            "productVersion": env::var("CARGO_PKG_VERSION").expect("package version"),
            "target": env::var("TARGET").expect("build target"),
            "scope": {
                "id": "editkin.community-desktop-build/v1",
                "officialRelease": false
            },
            "files": files
        });
        fs::write(
            PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR")).join("release-input-identity.json"),
            serde_json::to_vec(&identity).expect("serialize community identity"),
        ).expect("write community identity");
        tauri_build::build();
        return;
    }
    let release_manifest_path = manifest_dir.join("../.release-input-manifest.json");
    println!("cargo:rerun-if-changed={}", release_manifest_path.display());
    let bytes = fs::read(&release_manifest_path).expect("read Editkin release input manifest");
    let manifest: serde_json::Value =
        serde_json::from_slice(&bytes).expect("parse Editkin release input manifest");
    for required in [
        "schemaVersion",
        "product",
        "productVersion",
        "inputIdentity",
        "outputIdentity",
        "scope",
    ] {
        assert!(
            !manifest[required].is_null(),
            "release input manifest is missing {required}"
        );
    }
    assert_eq!(
        manifest["schemaVersion"], 2,
        "release input manifest must use product-scoped schema v2"
    );
    assert_eq!(
        manifest["scope"]["id"], "editkin.formal-product-build-scope/v1",
        "release input manifest scope is not the formal product scope"
    );
    assert_eq!(
        manifest["scope"]["productMode"], "native-only-auto-roto",
        "release input manifest may not enable a research Auto Roto product engine"
    );
    assert_eq!(
        manifest["scope"]["researchBoundary"], "repository-retained-artifact-excluded",
        "release input manifest must keep research provenance outside the product artifact"
    );
    assert_eq!(
        manifest["scope"]["policySha256"], EDITKIN_PRODUCT_POLICY_SHA256,
        "release input manifest does not attest the pinned formal product input policy"
    );
    let embedded_identity = serde_json::json!({
        "schemaVersion": manifest["schemaVersion"],
        "product": manifest["product"],
        "productVersion": manifest["productVersion"],
        "inputIdentity": manifest["inputIdentity"],
        "outputIdentity": manifest["outputIdentity"],
        "scope": manifest["scope"],
        "manifestSha256": format!("{:x}", Sha256::digest(&bytes)),
        "detailLocation": "runtime/BUILD-MANIFEST.json"
    });
    let output =
        PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR")).join("release-input-identity.json");
    fs::write(
        output,
        serde_json::to_vec(&embedded_identity).expect("serialize release identity"),
    )
    .expect("write embedded release identity");
    tauri_build::build()
}

fn hash_community_inputs(root: &std::path::Path, path: &std::path::Path, files: &mut serde_json::Map<String, serde_json::Value>) {
    println!("cargo:rerun-if-changed={}", path.display());
    let metadata = fs::symlink_metadata(path).expect("inspect community build input");
    assert!(!metadata.file_type().is_symlink(), "community build inputs must not be symlinks");
    if metadata.is_dir() {
        for entry in fs::read_dir(path).expect("read community build directory") {
            hash_community_inputs(root, &entry.expect("read community build entry").path(), files);
        }
    } else {
        assert!(metadata.is_file(), "community build input must be a regular file");
        let relative = path.strip_prefix(root).expect("community input within source root")
            .to_str().expect("UTF-8 community input path").replace('\\', "/");
        let mut file = fs::File::open(path).expect("open community build input");
        let mut hash = Sha256::new();
        let mut buffer = [0_u8; 16 * 1024];
        loop {
            let count = file.read(&mut buffer).expect("read community build input");
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
        }
        files.insert(relative, format!("{hash:x}", hash = hash.finalize()).into());
    }
}
