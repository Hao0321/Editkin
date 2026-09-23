fn main() {
    println!("cargo:rerun-if-changed=src/software_video_bridge.cpp");
    println!("cargo:rerun-if-changed=src/software_video_bridge.h");
    println!("cargo:rerun-if-changed=vendor/ffmpeg-8.1-lgpl/include");

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    cc::Build::new()
        .cpp(true)
        .std("c++17")
        .warnings(true)
        .define("WIN32_LEAN_AND_MEAN", None)
        .define("NOMINMAX", None)
        .include("vendor/ffmpeg-8.1-lgpl/include")
        .include("src")
        .file("src/software_video_bridge.cpp")
        .compile("editkin_software_video_bridge");
}
