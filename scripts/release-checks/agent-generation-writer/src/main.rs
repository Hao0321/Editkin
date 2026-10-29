// Writes an Agent generation for an extracted installer payload with the
// desktop's real activation code (src-tauri/src/agent_setup.rs, compiled as is).
//
// The paths mirror the release branch of `runtime_paths` and the connect command in
// src-tauri/src/main.rs. Usage:
//   editkin-agent-generation-writer <installed resource root> <application data root>
// Prints one JSON line and exits 0 on activation, 1 on refusal, 2 on bad usage.
#[allow(dead_code)]
#[path = "../../../../src-tauri/src/agent_setup.rs"]
mod agent_setup;

// agent_setup.rs's setup-command formatter calls crate::agent_connect, which needs
// the Tauri app. Activation never formats a command; this stand-in only lets the
// module compile. agent_connect_route.mjs refuses any other crate:: reference.
#[allow(dead_code)]
mod agent_connect {
    pub fn render_direct_command(_program: &str, _args: &[String]) -> Option<String> {
        None
    }
}

use agent_setup::{activate_product_agent_generation, ProductAgentGenerationPaths};
use std::{fs, path::PathBuf};

// The bytes the desktop embeds with include_str!("../../src/shared/agentSetupContract.json").
const EDITKIN_AGENT_SETUP_CONTRACT: &str = include_str!("../../../../src/shared/agentSetupContract.json");

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: editkin-agent-generation-writer <installed resource root> <application data root>");
        std::process::exit(2);
    }
    let resource = PathBuf::from(&args[1]);
    let application_data = PathBuf::from(&args[2]);
    let runtime = resource.join("runtime");
    let executable = |name: &str| runtime.join(if cfg!(windows) { format!("{name}.exe") } else { name.to_string() });
    // runtime_paths (release): the personal visual pack lives in the application data root.
    let personal_visual = application_data.join("personal-packs/hao-visual-library");
    if let Err(error) = fs::create_dir_all(&personal_visual) {
        println!("{}", serde_json::json!({ "status": "GENERATION_REFUSED", "error": error.to_string() }));
        std::process::exit(1);
    }
    let paths = ProductAgentGenerationPaths {
        resource_root: resource.clone(),
        embedded_contract: resource.join("agent-runtime-v3/agent-setup-contract.json"),
        entrypoint: runtime.join("mcp.mjs"),
        entrypoint_identity: runtime.join("mcp.mjs.material-color-identity.json"),
        ffmpeg: executable("ffmpeg"),
        ffprobe: executable("ffprobe"),
        gpu_compositor: executable("editkin-gpu-compositor"),
        launcher: resource.join("agent-runtime-v3/launcher.mjs"),
        native_core: executable("hao-core"),
        node: executable("node"),
        node_manifest: runtime.join(if cfg!(windows) { "NODE-MANIFEST.json" } else { "PLATFORM-MANIFEST.json" }),
        whisper: executable("whisper-cli"),
        color: resource.join("color/aces2"),
        creative_pack: resource.join("creative-packs/hao-creator-library"),
        fonts: resource.join("font-packs/editkin-open-fonts"),
        personal_music: resource.join("personal-packs/hao-music-library"),
        personal_visual,
        plugins: resource.join("plugins"),
    };
    // application_data_root(app).join(stateDirectoryName)
    let state_root = application_data.join("agent-runtime-v3");
    match activate_product_agent_generation(&state_root, &paths, EDITKIN_AGENT_SETUP_CONTRACT.as_bytes()) {
        Ok(activation) => println!(
            "{}",
            serde_json::json!({
                "status": "GENERATION_ACTIVATED",
                "stateRoot": activation.state_root.to_string_lossy(),
                "pointerSha256": activation.pointer_identity,
            })
        ),
        Err(error) => {
            println!("{}", serde_json::json!({ "status": "GENERATION_REFUSED", "error": error }));
            std::process::exit(1);
        }
    }
}
