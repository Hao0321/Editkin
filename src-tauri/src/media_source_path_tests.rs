//! The single-import check (`media_source_path_check`) on every path the import surface and the preview/export
//! bindings receive: a refused form never reaches a probe or a file-system call (recording stand-ins count them),
//! and local paths give the same results as before.
use crate::{
    agent_connect::unsafe_workspace_reason, checked_drop_paths, desktop_files, engine_tasks_v1,
    gpu_render_layers_local, local_media_binding_with, local_path_text_problem, media_source_path_check,
    probe_import_picks, reveal_in_folder, template_short_prepare, LocalPathProblem,
};
use serde_json::{json, Value};
use std::{
    cell::{Cell, RefCell},
    collections::BTreeSet,
    path::{Path, PathBuf},
    rc::Rc,
    sync::{Arc, Mutex},
};

const NETWORK: &str = "拒絕網路共用或裝置路徑作為媒體來源，請先以一般檔名複製到本機磁碟：";
const STREAM: &str = "拒絕檔名裡帶冒號的路徑作為媒體來源（這是檔案的隱藏資料串流，不是檔案本身），請改用一般檔名：";
const NOT_ABSOLUTE: &str = "媒體路徑不是 absolute path：";
const DROP_UNREADABLE: &str = "拖入項目不是可讀取的媒體檔案";

/// Every refused form, with the reason the single-import check gives (the message is the reason plus the path).
fn refused() -> Vec<(&'static str, &'static str)> {
    if !cfg!(windows) {
        return vec![("relative/clip.mp4", NOT_ABSOLUTE)];
    }
    vec![
        (r"\\nas\footage\clip.mp4", NETWORK),
        (r"\\?\UNC\nas\footage\clip.mov", NETWORK),
        (r"\\.\C:\footage\clip.mp4", NETWORK),
        (r"\\.\pipe\clip.mp4", NETWORK),
        ("//nas/footage/clip.mp4", NETWORK),
        (r"C:\footage\NUL.mp4", NETWORK),
        (r"C:\footage\COM1.mov", NETWORK),
        (r"C:\footage\clip.mp4:stream", STREAM),
        (r"C:\footage\clip.mp4::$DATA", STREAM),
        (r"\\?\C:\footage\clip.mp4:stream", STREAM),
        ("D:/footage/clip.mov:hidden", STREAM),
        (r"\??\C:\footage\clip.mp4", NOT_ABSOLUTE),
        (r"C:footage\clip.mp4", NOT_ABSOLUTE),
    ]
}

/// Local media paths every chooser keeps accepting: drive letters, `/` separators, non-ASCII and spaces, verbatim.
fn local() -> Vec<&'static str> {
    if cfg!(windows) {
        vec![r"C:\footage\IMG_0001.MOV", "D:/媒體/京都 day 1.mp4", r"\\?\C:\footage\long.mkv", r"E:\Camera Roll\song.flac"]
    } else {
        vec!["/footage/IMG_0001.MOV", "/footage/京都 day 1.mp4"]
    }
}

/// A stand-in for `Path::is_file` that records every path it is asked about.
fn recording_is_file(answer: bool) -> (Rc<RefCell<Vec<PathBuf>>>, impl Fn(&Path) -> bool) {
    let calls = Rc::new(RefCell::new(Vec::new()));
    let seen = calls.clone();
    (calls, move |path: &Path| {
        seen.borrow_mut().push(path.to_path_buf());
        answer
    })
}

type ProbeCalls = Arc<Mutex<Vec<Vec<String>>>>;

/// A stand-in for the app's media probe (`inspect_media_batch`) that records every call.
fn recording_probe(reply: Value) -> (ProbeCalls, impl FnOnce(Vec<String>) -> std::future::Ready<Result<Value, String>>) {
    let calls = ProbeCalls::default();
    let seen = calls.clone();
    (calls, move |paths: Vec<String>| {
        seen.lock().unwrap().push(paths);
        std::future::ready(Ok(reply))
    })
}

#[test]
fn the_shared_check_refuses_streams_and_keeps_drive_and_verbatim_local_paths() {
    for (path, reason) in refused() {
        assert_eq!(media_source_path_check(path), Err(format!("{reason}{path}")), "{path}");
    }
    for path in local() {
        assert_eq!(media_source_path_check(path), Ok(()), "{path}");
    }
    // The plain-problem wording (src/application/plainProblems.ts) must not read a stream as a network drive.
    assert!(!STREAM.contains("網路共用") && !STREAM.contains("裝置路徑"));
}

#[test]
fn drag_and_drop_refuses_before_any_file_system_call_and_keeps_local_results() {
    for (path, reason) in refused() {
        // Alone, and after a local file (which is asked about first, as before).
        for paths in [vec![path.to_string()], vec![local()[0].to_string(), path.to_string()]] {
            let (calls, is_file) = recording_is_file(true);
            let error = checked_drop_paths(paths, &is_file).expect_err(path);
            // A relative form keeps the drag-and-drop message; the rest get the single-import message.
            let expected = if reason == NOT_ABSOLUTE { DROP_UNREADABLE.to_string() } else { format!("{reason}{path}") };
            assert_eq!(error, expected);
            assert!(calls.borrow().iter().all(|seen| seen != Path::new(path)), "{path} reached is_file");
        }
    }
    // Local paths: is_file is asked once each, in order, and the same paths come back.
    let (calls, is_file) = recording_is_file(true);
    let paths: Vec<String> = local().iter().map(|path| path.to_string()).collect();
    let selected = checked_drop_paths(paths.clone(), &is_file).unwrap();
    assert_eq!(selected, paths.iter().map(PathBuf::from).collect::<Vec<_>>());
    assert_eq!(*calls.borrow(), selected);
    // The existing drag-and-drop messages are unchanged.
    let (_, missing) = recording_is_file(false);
    assert_eq!(checked_drop_paths(vec![local()[0].to_string()], &missing), Err(DROP_UNREADABLE.to_string()));
    let (_, present) = recording_is_file(true);
    let text = if cfg!(windows) { r"C:\notes\readme.txt" } else { "/notes/readme.txt" };
    assert_eq!(
        checked_drop_paths(vec![text.to_string()], &present),
        Err(format!("不支援的媒體格式：{}", Path::new(text).display()))
    );
    let (calls, present) = recording_is_file(true);
    assert_eq!(checked_drop_paths(vec![local()[0].to_string(); 257], &present), Err("一次最多拖入 256 份素材".to_string()));
    assert!(calls.borrow().is_empty());
}

#[test]
fn the_media_chooser_refuses_before_the_probe_and_probes_local_picks_as_before() {
    for (path, reason) in refused() {
        for picks in [vec![PathBuf::from(path)], vec![PathBuf::from(local()[0]), PathBuf::from(path)]] {
            let (calls, probe) = recording_probe(json!([]));
            let result = tauri::async_runtime::block_on(probe_import_picks(&picks, probe));
            assert_eq!(result.expect_err(path), format!("{reason}{path}"));
            assert!(calls.lock().unwrap().is_empty(), "{path} reached the media probe");
        }
    }
    let picks: Vec<PathBuf> = local().iter().map(PathBuf::from).collect();
    let strings: Vec<String> = picks.iter().map(|path| path.to_string_lossy().to_string()).collect();
    let reply = json!([{ "hasVideo": true, "duration": 4.5 }]);
    let (calls, probe) = recording_probe(reply.clone());
    let (paths, probes) = tauri::async_runtime::block_on(probe_import_picks(&picks, probe)).unwrap();
    assert_eq!(paths, strings);
    assert_eq!(probes, reply);
    assert_eq!(*calls.lock().unwrap(), vec![strings]);
    let failed = tauri::async_runtime::block_on(probe_import_picks(&picks, |_| {
        std::future::ready(Err::<Value, String>("probe failed".into()))
    }));
    assert_eq!(failed, Err("probe failed".to_string()));
}

#[test]
fn preview_and_export_bindings_ask_is_file_only_for_checked_paths() {
    for (path, _) in refused() {
        let asked = Cell::new(0);
        assert!(!local_media_binding_with(path, |_| { asked.set(asked.get() + 1); true }), "{path}");
        assert_eq!(asked.get(), 0, "{path} reached is_file");
    }
    for path in local() {
        for answer in [true, false] {
            let asked = Cell::new(0);
            let bound = local_media_binding_with(path, |seen| {
                asked.set(asked.get() + 1);
                assert_eq!(seen, Path::new(path));
                answer
            });
            assert_eq!((bound, asked.get()), (answer, 1), "{path}");
        }
    }
}

#[test]
fn gpu_render_graph_image_layers_are_checked_before_the_worker() {
    let layer = |source: Value| json!({ "id": "layer", "source": source, "blendMode": "normal", "opacity": 1, "enabled": true,
        "transform": { "x": 0, "y": 0, "scale": 1, "rotation": 0 } });
    let solid = layer(json!({ "kind": "solid", "color": [0, 0, 0, 1] }));
    assert_eq!(gpu_render_layers_local(&[solid.clone()]), Ok(()));
    for path in local() {
        assert_eq!(gpu_render_layers_local(&[solid.clone(), layer(json!({ "kind": "image", "path": path }))]), Ok(()));
    }
    for (path, reason) in refused() {
        assert_eq!(
            gpu_render_layers_local(&[solid.clone(), layer(json!({ "kind": "image", "path": path }))]),
            Err(format!("{reason}{path}"))
        );
    }
    assert!(gpu_render_layers_local(&[layer(json!({ "kind": "image", "path": 7 }))]).is_err());
}

#[test]
fn a_regular_save_path_from_the_webview_is_checked_before_the_write() {
    const PROJECT_NETWORK: &str = "拒絕網路共用或裝置路徑：請先把專案檔複製到這台電腦";
    if cfg!(windows) {
        for path in [
            r"\\nas\projects\trip.editkin.json",
            r"\\?\UNC\nas\projects\trip.editkin.json",
            r"\\.\C:\projects\trip.editkin.json",
            r"C:\projects\CON.editkin.json",
        ] {
            assert_eq!(desktop_files::local_project_path(path), Err(PROJECT_NETWORK.to_string()), "{path}");
            // Opening a known path gives the same message, before any file-system call.
            assert_eq!(desktop_files::validate_project_path(path).unwrap_err(), PROJECT_NETWORK);
        }
        assert_eq!(desktop_files::local_project_path(r"D:\Trips\kyoto.editkin.json"), Ok(()));
        assert_eq!(desktop_files::local_project_path(r"\\?\D:\Trips\kyoto.editkin.json"), Ok(()));
    }
    assert_eq!(desktop_files::local_project_path("relative.editkin.json"), Err("專案檔位置不合法".to_string()));
}

fn body<'a>(main: &'a str, signature: &str) -> &'a str {
    let start = main.find(signature).unwrap_or_else(|| panic!("{signature} missing"));
    &main[start..start + main[start..].find("\n}\n").expect("function end")]
}

/// In the commands themselves: each check runs before the first probe, file-system call or worker request.
#[test]
fn every_chooser_or_webview_path_is_checked_before_its_first_io() {
    let main = include_str!("main.rs").replace("\r\n", "\n");
    let before = |signature: &str, check: &str, later: &[&str]| {
        let text = body(&main, signature);
        let at = text.find(check).unwrap_or_else(|| panic!("{signature}: {check} missing"));
        for io in later {
            let io_at = text.find(io).unwrap_or_else(|| panic!("{signature}: {io} missing"));
            assert!(at < io_at, "{signature}: {check} must come before {io}");
        }
    };
    before("async fn import_media_paths(", "checked_drop_paths(paths, Path::is_file)?", &["import_media_path_bufs("]);
    before("fn checked_drop_paths(", "media_source_path_check(", &["is_file(path.as_path())"]);
    before("async fn probe_import_picks<", "media_source_path_check(path)?", &["inspect(path_strings"]);
    before("async fn import_media_path_bufs(", "probe_import_picks(&selected,", &["allow_path(", "record_outside_media_grants("]);
    before("async fn pick_relink_media(", "media_source_path_check(&text)?", &["sha256_file", "allow_path("]);
    before("async fn open_gpu_video_preview_session(", "media_source_path_check(&input_path)?", &["fs::canonicalize(&input_path)", "video_open"]);
    before("async fn render_gpu_composition(", "gpu_render_layers_local(layers)?", &["fs::create_dir_all", "fs::write", "with_resident_gpu"]);
    before("async fn save_project(", "desktop_files::local_project_path(current)?", &["call_service("]);
    for signature in [
        "async fn load_gpu_engine_preview_session(",
        "fn load_gpu_engine_video_preview_inner(",
        "fn validate_openexr_sequence_request(",
    ] {
        let text = body(&main, signature);
        assert!(text.contains("!local_media_binding(path)"), "{signature}");
        assert!(!text.contains(".is_file()"), "{signature} asks is_file outside the checked binding");
    }
    // One rule: no network-only check is left on the import surface.
    for signature in ["async fn import_media_paths(", "fn checked_drop_paths(", "async fn import_media_path_bufs(", "async fn pick_relink_media("] {
        assert!(!body(&main, signature).contains("is_windows_network_path"), "{signature}");
    }
    assert_eq!(main.matches("fn media_source_path_check(").count(), 1);
}

/// The rows of the table both languages are checked against (src/shared/localPathVerdicts.json), for this system.
fn verdict_rows() -> Vec<(String, Option<LocalPathProblem>)> {
    let table: Value = serde_json::from_str(include_str!("../../src/shared/localPathVerdicts.json")).unwrap();
    assert_eq!(table["schema"], "editkin.local-path-verdicts/v1");
    table[if cfg!(windows) { "windows" } else { "posix" }]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            let verdict = match row["verdict"].as_str().unwrap() {
                "local" => None,
                "not_absolute" => Some(LocalPathProblem::NotAbsolute),
                "network_or_device" => Some(LocalPathProblem::NetworkOrDevice),
                "alternate_stream" => Some(LocalPathProblem::AlternateStream),
                other => panic!("unknown verdict {other}"),
            };
            (row["path"].as_str().unwrap().to_string(), verdict)
        })
        .collect()
}

/// The same table runs through `localPathTextProblem` in src/shared/localPathVerdicts.test.ts, so the two can't drift.
#[test]
fn the_shared_predicate_gives_every_row_of_the_cross_language_table_its_verdict() {
    let rows = verdict_rows();
    let mut seen = BTreeSet::new();
    for (path, expected) in &rows {
        assert_eq!(local_path_text_problem(path), *expected, "{path:?}");
        seen.insert(format!("{expected:?}"));
    }
    assert_eq!(seen.len(), if cfg!(windows) { 4 } else { 2 }, "every verdict has rows");
}

/// Each caller keeps its own messages; only the verdict comes from the predicate.
#[test]
fn every_caller_maps_the_shared_verdict_to_its_own_messages() {
    const MEDIA_NETWORK: &str = "拒絕網路共用或裝置路徑作為媒體來源，請先以一般檔名複製到本機磁碟：";
    const PROJECT_NETWORK: &str = "拒絕網路共用或裝置路徑：請先把專案檔複製到這台電腦";
    for (path, verdict) in verdict_rows() {
        let absolute = Path::new(&path).is_absolute();
        // Media: network (absolute) / stream / not absolute (a non-absolute device form included, as before).
        let media = media_source_path_check(&path);
        match verdict {
            None => assert_eq!(media, Ok(()), "{path:?}"),
            Some(LocalPathProblem::NetworkOrDevice) if absolute => assert_eq!(media, Err(format!("{MEDIA_NETWORK}{path}"))),
            Some(LocalPathProblem::AlternateStream) => assert_eq!(media, Err(format!("{STREAM}{path}"))),
            Some(_) => assert_eq!(media, Err(format!("{NOT_ABSOLUTE}{path}")), "{path:?}"),
        }
        // Project paths and the bool form used by the project-file and missing-media checks.
        let project = desktop_files::local_project_path(&path);
        match verdict {
            None => assert_eq!(project, Ok(()), "{path:?}"),
            Some(LocalPathProblem::NetworkOrDevice) if absolute => assert_eq!(project, Err(PROJECT_NETWORK.to_string())),
            Some(_) => assert_eq!(project, Err("專案檔位置不合法".to_string()), "{path:?}"),
        }
        assert_eq!(desktop_files::local_absolute(&path), verdict.is_none() && !path.is_empty(), "{path:?}");
        if verdict.is_some() {
            // Engine tasks refuse before looking at any ancestor.
            assert_eq!(engine_tasks_v1::plain_local(Path::new(&path)), Err("ENGINE_TASK_LOCAL_PATH_REQUIRED".to_string()));
        }
        if verdict == Some(LocalPathProblem::NetworkOrDevice) {
            // Template Shorts and 「打開資料夾」 refuse network and device forms (absolute or not) before any I/O.
            assert_eq!(template_short_prepare(path.clone()), Err("請先把影片複製到這台電腦的磁碟".to_string()), "{path:?}");
            assert_eq!(reveal_in_folder(path.clone()), Err("不能打開網路上的位置".to_string()), "{path:?}");
        }
    }
    if cfg!(windows) {
        // Agent work folders: the shared rule, the stream form as an incomplete path, workspace-only rules on top.
        let none = |_: &str| None;
        for folder in [r"D:\EditkinWork:hidden", r"\\?\D:\EditkinWork:hidden"] {
            assert_eq!(unsafe_workspace_reason(Path::new(folder), &none), Some("工作資料夾必須是完整路徑".to_string()), "{folder}");
        }
        for folder in [r"\\server\share\EditkinWork", r"\\.\pipe\editkin", r"D:\EditkinWork\NUL"] {
            assert_eq!(unsafe_workspace_reason(Path::new(folder), &none),
                Some("工作資料夾必須在這台電腦的磁碟上，不能是網路或裝置路徑".to_string()), "{folder}");
        }
        assert_eq!(unsafe_workspace_reason(Path::new(r"D:\EditkinWork"), &none), None);
        assert_eq!(unsafe_workspace_reason(Path::new(r"\\?\D:\EditkinWork"), &none), None);
    }
}

/// The name of the function whose body holds byte `position`, and whether it is a `#[test]`.
fn enclosing_function(code: &str, position: usize) -> (String, bool) {
    let lines: Vec<&str> = code[..position].lines().collect();
    for (index, line) in lines.iter().enumerate().rev() {
        let mut rest = line.trim_start();
        for prefix in ["pub(crate) ", "pub ", "async "] {
            rest = rest.strip_prefix(prefix).unwrap_or(rest);
        }
        if let Some(signature) = rest.strip_prefix("fn ") {
            let name = signature.split(['(', '<']).next().unwrap_or_default().to_string();
            let is_test = lines[..index]
                .iter()
                .rev()
                .take_while(|line| line.trim_start().starts_with("#["))
                .any(|line| line.trim() == "#[test]");
            return (name, is_test);
        }
    }
    (String::new(), false)
}

/// No path-taking code keeps (or reintroduces) its own network, device or stream check: the only callers of the
/// Windows text rules are `local_path_text_problem` itself and tests. Callers use the predicate.
#[test]
fn only_the_shared_predicate_applies_the_network_device_and_stream_rules() {
    let mut pending = vec![Path::new(env!("CARGO_MANIFEST_DIR")).join("src")];
    let mut offenders = Vec::new();
    let mut predicate_users = BTreeSet::new();
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(&directory).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                pending.push(path);
                continue;
            }
            let file = path.file_name().unwrap().to_string_lossy().to_string();
            if !file.ends_with(".rs") || file.ends_with("_tests.rs") {
                continue;
            }
            let code = std::fs::read_to_string(&path).unwrap().replace("\r\n", "\n");
            for (needle, allowed) in [
                ("is_windows_network_path(", &["is_windows_network_path", "local_path_text_problem"][..]),
                ("windows_alternate_stream_path(", &["windows_alternate_stream_path", "local_path_text_problem"][..]),
                (r#"starts_with("\\\\")"#, &["is_windows_network_path"][..]),
                (r#"starts_with("\\??\\")"#, &["is_windows_network_path"][..]),
                (r#"starts_with(r"\\")"#, &[][..]),
                (r#"starts_with(r"\??\")"#, &[][..]),
            ] {
                for (position, _) in code.match_indices(needle) {
                    let (function, is_test) = enclosing_function(&code, position);
                    let definition = code[..position].ends_with("fn ");
                    if !definition && !is_test && !allowed.contains(&function.as_str()) {
                        offenders.push(format!("{file}: {function} uses {needle}"));
                    }
                }
            }
            for (position, _) in code.match_indices("local_path_text_problem(") {
                if !code[..position].ends_with("fn ") && !enclosing_function(&code, position).1 {
                    predicate_users.insert(enclosing_function(&code, position).0);
                }
            }
        }
    }
    assert_eq!(offenders, Vec::<String>::new());
    // The callers this package moved onto the predicate (a removed caller would also show up here).
    for caller in [
        "media_source_path_check", "unsafe_workspace_reason", "local_start_directory", "local_absolute",
        "local_project_path", "plain_local", "root_for_visual", "allowed_source", "template_short_workspace_source",
        "template_short_prepare", "reveal_in_folder", "plain_local_media_path",
    ] {
        assert!(predicate_users.contains(caller), "{caller} no longer uses local_path_text_problem");
    }
}
