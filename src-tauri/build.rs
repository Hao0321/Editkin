use sha2::{Digest, Sha256};
use std::{env, fs, path::PathBuf};

// Deliberately reviewed native attestation, not a value copied from the incoming
// manifest. This scope keeps the owner-authorized visual grant while separating
// the mutable product evidence ledger from executable runtime build identity.
const EDITKIN_PRODUCT_POLICY_SHA256: &str =
    "163608ac9aeb7da11b3db6c8753ac9fe5d7c288f1b72467d28400d2be75f905a";

fn main() {
    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
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
