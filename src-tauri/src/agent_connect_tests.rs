use super::*;
use std::{
    cell::RefCell,
    process::{Command, Stdio},
    rc::Rc,
    sync::atomic::{AtomicUsize, Ordering},
};

static NONCE: AtomicUsize = AtomicUsize::new(0);

/// A fresh folder under the system temp folder whose name has a space and CJK characters.
fn scratch(label: &str) -> PathBuf {
    let directory = env::temp_dir().join(format!(
        "editkin agentfix 測試 {label}-{}-{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(),
        NONCE.fetch_add(1, Ordering::SeqCst)
    ));
    fs::create_dir_all(&directory).unwrap();
    directory
}

fn strings_of(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|part| part.to_string()).collect()
}

/// `C:\Users`, `c:/users` and `c:\users`, assembled so this file never spells a Windows profile path (the public
/// source export refuses one). Fixtures use neutral user names.
const WIN_USERS: &str = concat!("C:", "\\", "Users");
const WIN_USERS_LOWER_SLASH: &str = concat!("c:", "/", "users");
const WIN_USERS_LOWER: &str = concat!("c:", "\\", "users");

/// The folder `rest` (a profile name, then more) under the Windows users folder.
fn win_user(rest: &str) -> String {
    format!("{WIN_USERS}\\{rest}")
}

// ---- failure shape, detail, log ------------------------------------------------------------------------------

#[test]
fn failure_serializes_to_the_ui_contract() {
    let failure = SetupFailure::new(
        SetupStep::PrepareRuntime,
        FailureCode::ConfigAlreadyExistsDifferent,
        "boom",
        None,
        Some(Path::new(r"C:\logs\agent-connect-x.log")),
    );
    assert_eq!(
        serde_json::to_value(&failure).unwrap(),
        json!({
            "step": "prepare_runtime",
            "code": "CONFIG_ALREADY_EXISTS_DIFFERENT",
            "detail": "boom",
            "logPath": r"C:\logs\agent-connect-x.log",
        })
    );
    let steps = [
        (SetupStep::Detect, "detect"),
        (SetupStep::PrepareRuntime, "prepare_runtime"),
        (SetupStep::Probe, "probe"),
        (SetupStep::WriteConfig, "write_config"),
        (SetupStep::HealthCheck, "health_check"),
    ];
    for (step, text) in steps {
        assert_eq!(serde_json::to_value(step).unwrap(), json!(text));
        assert_eq!(step.as_str(), text);
    }
    let codes = [
        (FailureCode::AgentAppNotFound, "AGENT_APP_NOT_FOUND"),
        (FailureCode::RuntimeFilesMissing, "RUNTIME_FILES_MISSING"),
        (FailureCode::RuntimeProbeFailed, "RUNTIME_PROBE_FAILED"),
        (FailureCode::WorkspaceNotWritable, "WORKSPACE_NOT_WRITABLE"),
        (FailureCode::WorkspaceChoiceExpired, "WORKSPACE_CHOICE_EXPIRED"),
        (FailureCode::WorkspaceUnsafe, "WORKSPACE_UNSAFE"),
        (FailureCode::ConfigWriteRefused, "CONFIG_WRITE_REFUSED"),
        (FailureCode::ConfigAlreadyExistsDifferent, "CONFIG_ALREADY_EXISTS_DIFFERENT"),
        (FailureCode::HealthCheckFailed, "HEALTH_CHECK_FAILED"),
        (FailureCode::Unknown, "UNKNOWN"),
    ];
    for (code, text) in codes {
        assert_eq!(serde_json::to_value(code).unwrap(), json!(text));
    }
    let without_log = SetupFailure::new(SetupStep::Probe, FailureCode::Unknown, "x", None, None);
    assert!(serde_json::to_value(&without_log).unwrap().get("logPath").is_none());
}

#[test]
fn detail_replaces_the_user_profile_and_stays_within_two_kilobytes() {
    let profile_text = win_user("Ana Test");
    let profile = Path::new(&profile_text);
    let tester = win_user("Ana Tester");
    // The same profile as typed (any letter case, `/`) and JSON-escaped (`\\`).
    let escaped = profile_text.replace('\\', "\\\\");
    let text = format!(
        r#"failed at {profile_text}\AppData\x.mjs and {WIN_USERS_LOWER_SLASH}/ana test/y and "{escaped}\\z" but not {tester}\w"#
    );
    let redacted = redact_user_profile(&text, Some(profile));
    let home = PROFILE_PLACEHOLDER;
    assert_eq!(
        redacted,
        format!(r#"failed at {home}\AppData\x.mjs and {home}/y and "{home}\\z" but not {tester}\w"#)
    );
    // macOS: $HOME shows as ~ (the same matching, any system).
    assert_eq!(
        redact_user_profile("/Users/ana/Library/x and /Users/anabel/y", Some(Path::new("/Users/ana/"))),
        format!("{home}/Library/x and /Users/anabel/y")
    );
    assert_eq!(redact_user_profile(&text, None), text);

    let long = format!("HEAD {} 中文 {} TAIL", "a".repeat(3_000), "尾".repeat(1_000));
    let bounded = bounded_detail(&long);
    assert!(bounded.len() <= DETAIL_LIMIT_BYTES, "{}", bounded.len());
    assert!(bounded.starts_with("HEAD "));
    assert!(bounded.ends_with(" TAIL"));
    assert!(bounded.contains("中間省略"));
    assert_eq!(bounded_detail("  short  "), "short");

    let failure = SetupFailure::new(
        SetupStep::Probe,
        FailureCode::RuntimeProbeFailed,
        &format!(r"{profile_text}\x {}", "e".repeat(5_000)),
        Some(profile),
        None,
    );
    assert!(failure.detail.starts_with(&format!(r"{PROFILE_PLACEHOLDER}\x ")));
    assert!(failure.detail.len() <= DETAIL_LIMIT_BYTES);
}

#[test]
fn utc_stamp_is_civil_utc_and_sorts_chronologically() {
    assert_eq!(utc_stamp(UNIX_EPOCH), "19700101-000000-000Z");
    assert_eq!(
        utc_stamp(UNIX_EPOCH + Duration::from_millis(951_782_400_000 + 3_723_045)),
        "20000229-010203-045Z"
    );
    assert_eq!(
        utc_stamp(UNIX_EPOCH + Duration::from_secs(1_798_761_599)),
        "20261231-235959-000Z"
    );
    assert!(utc_stamp(UNIX_EPOCH + Duration::from_secs(9)) < utc_stamp(UNIX_EPOCH + Duration::from_secs(10)));
}

#[test]
fn connect_logs_keep_the_newest_ten_and_touch_nothing_else() {
    let root = scratch("logs");
    for index in 0..12 {
        fs::write(root.join(format!("agent-connect-20260101-0000{index:02}-000Z.log")), b"old").unwrap();
    }
    fs::write(root.join("unrelated.log"), b"keep").unwrap();
    fs::write(root.join("agent-connect-notes.txt"), b"keep").unwrap();
    let profile = PathBuf::from(win_user("Ana Test"));
    let mut log = ConnectLog::open(Some(root.clone()), "claude", Some(profile));
    log.line(&format!(r"probe {}\AppData\launcher.mjs", win_user("Ana Test")));
    log.command("claude", &strings_of(&["mcp", "get", "editkin"]));
    log.output(&Ok(CliRun {
        success: false,
        stdout: Vec::new(),
        stderr: b"No MCP server found".to_vec(),
    }));
    let path = log.path().unwrap().to_path_buf();
    let logs = fs::read_dir(&root)
        .unwrap()
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().to_string())
        .filter(|name| name.starts_with("agent-connect-") && name.ends_with(".log"))
        .collect::<BTreeSet<_>>();
    assert_eq!(logs.len(), LOG_KEEP);
    assert!(logs.contains(path.file_name().unwrap().to_str().unwrap()));
    assert!(!logs.contains("agent-connect-20260101-000000-000Z.log"));
    assert!(root.join("unrelated.log").exists() && root.join("agent-connect-notes.txt").exists());
    let text = fs::read_to_string(&path).unwrap();
    assert!(text.contains(&format!(r"{PROFILE_PLACEHOLDER}\AppData\launcher.mjs")), "{text}");
    assert!(!text.contains("Ana Test"));
    assert!(text.contains("$ claude mcp get editkin"));
    assert!(text.contains("No MCP server found"));
    log.discard();
    assert!(!path.exists());
    fs::remove_dir_all(root).unwrap();
}

// ---- reading `claude mcp get` ----------------------------------------------------------------------------------

struct Fixture {
    root: PathBuf,
    executable: PathBuf,
    launcher: PathBuf,
    state: PathBuf,
    workspace: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let root = scratch("fixture");
        // Not `node.exe`: every open of a freshly written fake .exe waits for an antivirus scan (seconds each).
        let executable = root.join("node-fixture.bin");
        let launcher = root.join("agent runtime").join("launcher.mjs");
        let state = root.join("agent-runtime-v3");
        let workspace = root.join("影片 作品");
        fs::create_dir_all(launcher.parent().unwrap()).unwrap();
        fs::create_dir_all(&state).unwrap();
        fs::create_dir_all(&workspace).unwrap();
        fs::write(&executable, b"fixture").unwrap();
        fs::write(&launcher, b"fixture").unwrap();
        Self {
            root,
            executable,
            launcher,
            state,
            workspace,
        }
    }

    fn environment(&self, workspace: &Path) -> Vec<(String, String)> {
        vec![
            ("ELECTRON_RUN_AS_NODE".into(), "1".into()),
            ("EDITKIN_AGENT_STATE_ROOT".into(), self.state.to_string_lossy().to_string()),
            ("EDITKIN_WORKSPACE".into(), workspace.to_string_lossy().to_string()),
        ]
    }

    fn expected(&self, workspace: &Path) -> ExpectedConfig {
        ExpectedConfig {
            executable: self.executable.clone(),
            launcher: self.launcher.clone(),
            environment: self.environment(workspace).into_iter().collect(),
        }
    }

    fn add_args(&self, target: &str, workspace: &Path) -> Vec<String> {
        crate::agent_setup::agent_add_arguments(
            target,
            self.executable.to_str().unwrap(),
            self.launcher.to_str().unwrap(),
            &self.environment(workspace),
        )
    }

    fn log(&self) -> ConnectLog {
        ConnectLog::open(Some(self.root.join("logs")), "test", None)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ReportStyle {
    /// Claude Code 2.1.123: `claude mcp remove "editkin" -s user`.
    Quoted,
    /// Claude Code 2.1.311 (issue #104): `claude mcp remove editkin -s user`.
    Unquoted,
    /// A plausible later spelling: `--scope user`.
    LongScope,
}

fn claude_report(
    style: ReportStyle,
    status: &str,
    command: &str,
    args: &str,
    environment: &[(String, String)],
) -> String {
    let hint = match style {
        ReportStyle::Quoted => "claude mcp remove \"editkin\" -s user",
        ReportStyle::Unquoted => "claude mcp remove editkin -s user",
        ReportStyle::LongScope => "claude mcp remove editkin --scope user",
    };
    let mut text = format!(
        "editkin:\n  Scope: User config (available in all your projects)\n  Status: {status}\n  Type: stdio\n  Command: {command}\n  Args: {args}\n  Environment:\n"
    );
    for (key, value) in environment {
        text.push_str(&format!("    {key}={value}\n"));
    }
    text.push_str(&format!("\nTo remove this server, run: {hint}\n"));
    text
}

#[test]
fn claude_get_report_is_read_with_quoted_unquoted_or_long_scope_remove_hint() {
    let fixture = Fixture::new();
    let environment = fixture.environment(&fixture.workspace);
    let keys = environment.iter().map(|(key, _)| key.clone()).collect::<BTreeSet<_>>();
    for style in [ReportStyle::Quoted, ReportStyle::Unquoted, ReportStyle::LongScope] {
        let report = claude_report(
            style,
            "✓ Connected",
            fixture.executable.to_str().unwrap(),
            fixture.launcher.to_str().unwrap(),
            &environment,
        );
        let parsed = parse_claude_mcp_get(&report.replace('\n', "\r\n"), "editkin").unwrap();
        assert!(!parsed.irregular);
        assert_eq!(parsed.remove_scope.as_deref(), Some("user"));
        let assessed = assess_claude_entry(&parsed, &fixture.expected(&fixture.workspace));
        assert!(assessed.matches && assessed.usable && assessed.connected, "{assessed:?}");
        // The compatibility reader that the health check used to depend on (#104).
        assert_eq!(
            claude_mcp_text_inspection(
                report.as_bytes(),
                &fixture.executable,
                &fixture.launcher,
                &fixture.state,
                &keys
            ),
            Some((true, true))
        );
    }
}

#[test]
fn claude_get_report_differences_failures_and_spoofs_are_never_a_match() {
    let fixture = Fixture::new();
    let environment = fixture.environment(&fixture.workspace);
    let expected = fixture.expected(&fixture.workspace);
    let connected = claude_report(
        ReportStyle::Unquoted,
        "✓ Connected",
        fixture.executable.to_str().unwrap(),
        fixture.launcher.to_str().unwrap(),
        &environment,
    );
    let failed = connected.replace("✓ Connected", "✗ Failed to connect");
    let assessed = assess_claude_entry(&parse_claude_mcp_get(&failed, "editkin").unwrap(), &expected);
    assert!(assessed.matches && !assessed.connected && !assessed.usable);
    assert_eq!(assessed.status, "✗ Failed to connect");

    let other_workspace = fixture.root.join("另一個");
    fs::create_dir_all(&other_workspace).unwrap();
    let moved = assess_claude_entry(
        &parse_claude_mcp_get(&connected, "editkin").unwrap(),
        &fixture.expected(&other_workspace),
    );
    assert!(!moved.matches && !moved.usable);
    assert_eq!(moved.differences, ["environment"]);

    for spoofed in [
        connected.replace("  Command:", "  Note: Command:"),
        connected.replace("  Args:", "  Command: duplicate\n  Args:"),
        connected.replace("    EDITKIN_WORKSPACE=", "    EXTRA=value\n    EDITKIN_WORKSPACE="),
        connected.replace("✓ Connected", "not connected but ✓ Connected later"),
        connected.replace("  Scope: User config", "  Scope: Local config"),
        connected.replace("remove editkin -s user", "remove other -s user"),
    ] {
        let parsed = parse_claude_mcp_get(&spoofed, "editkin").unwrap();
        let assessed = assess_claude_entry(&parsed, &expected);
        assert!(!(assessed.matches && assessed.connected), "{spoofed}");
        assert!(!assessed.usable, "{spoofed}");
    }
    assert!(parse_claude_mcp_get("No MCP server found with name: \"editkin\"", "editkin").is_none());
    assert!(parse_claude_mcp_get("other:\n  Status: ✓ Connected\n", "editkin").is_none());
    // A newer Claude Code adding an informational field still reads as this exact entry; a line that is not a
    // field at all makes it irregular (usable after our own write, never left alone as "unchanged").
    let newer = connected.replace("  Type: stdio\n", "  Type: stdio\n  Tools: 104\n");
    let assessed = assess_claude_entry(&parse_claude_mcp_get(&newer, "editkin").unwrap(), &expected);
    assert!(assessed.usable && assessed.matches);
    let odd = connected.replace("  Type: stdio\n", "  Type: stdio\n  ??? unexpected\n");
    let assessed = assess_claude_entry(&parse_claude_mcp_get(&odd, "editkin").unwrap(), &expected);
    assert!(assessed.usable && !assessed.matches);
}

// ---- configure flow against a scripted CLI -------------------------------------------------------------------

#[derive(Clone)]
struct ClaudeEntry {
    command: String,
    args: String,
    environment: Vec<(String, String)>,
}

#[derive(Clone)]
struct FakeClaude {
    entry: Option<ClaudeEntry>,
    others: Vec<String>,
    status: String,
    style: ReportStyle,
    refuse_add: bool,
    refuse_remove: bool,
    calls: Vec<Vec<String>>,
}

impl FakeClaude {
    fn new(style: ReportStyle) -> Self {
        Self {
            entry: None,
            others: vec!["other-server".into()],
            status: "✓ Connected".into(),
            style,
            refuse_add: false,
            refuse_remove: false,
            calls: Vec::new(),
        }
    }

    fn run(&mut self, args: &[String]) -> Result<CliRun, String> {
        self.calls.push(args.to_vec());
        let ok = |stdout: String| Ok(CliRun { success: true, stdout: stdout.into_bytes(), stderr: Vec::new() });
        let fail = |stderr: String| Ok(CliRun { success: false, stdout: Vec::new(), stderr: stderr.into_bytes() });
        match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
            ["mcp", "get", "editkin"] => match &self.entry {
                Some(entry) => ok(claude_report(self.style, &self.status, &entry.command, &entry.args, &entry.environment)),
                None => fail(format!(
                    "No MCP server found with name: \"editkin\". Configured servers: {}",
                    self.others.join(", ")
                )),
            },
            ["mcp", "remove", "editkin", "-s", "user"] => {
                if self.refuse_remove || self.entry.is_none() {
                    fail("No user-scoped MCP server found with name: editkin".into())
                } else {
                    self.entry = None;
                    ok("Removed MCP server editkin from user config".into())
                }
            }
            ["mcp", "add", "--scope", "user", "editkin", rest @ ..] => {
                if self.refuse_add {
                    return fail("Error: permission denied writing .claude.json".into());
                }
                if self.entry.is_some() {
                    return fail("MCP server editkin already exists in user config".into());
                }
                let split = rest.iter().position(|part| *part == "--").unwrap();
                let environment = rest[..split]
                    .chunks(2)
                    .map(|pair| {
                        assert_eq!(pair[0], "-e");
                        let (key, value) = pair[1].split_once('=').unwrap();
                        (key.to_string(), value.to_string())
                    })
                    .collect();
                self.entry = Some(ClaudeEntry {
                    command: rest[split + 1].to_string(),
                    args: rest[split + 2..].join(" "),
                    environment,
                });
                ok("Added stdio MCP server editkin to user config".into())
            }
            other => panic!("unexpected claude call {other:?}"),
        }
    }
}

fn run_claude(
    cli: &Rc<RefCell<FakeClaude>>,
    fixture: &Fixture,
    workspace: &Path,
) -> Result<ConfigSuccess, ConfigFailure> {
    let mut log = fixture.log();
    let shared = cli.clone();
    let mut runner = move |args: &[String], _: Duration| shared.borrow_mut().run(args);
    configure_agent_mcp(
        "claude",
        &mut runner,
        &fixture.expected(workspace),
        &fixture.add_args("claude", workspace),
        &mut log,
    )
}

fn call_names(calls: &[Vec<String>]) -> Vec<String> {
    calls.iter().map(|call| call[..3.min(call.len())].join(" ")).collect()
}

#[test]
fn claude_first_connect_adds_and_reads_back_with_the_2_1_311_report() {
    let fixture = Fixture::new();
    let cli = Rc::new(RefCell::new(FakeClaude::new(ReportStyle::Unquoted)));
    let result = run_claude(&cli, &fixture, &fixture.workspace).unwrap();
    assert_eq!(result.change, ConfigChange::Added);
    assert_eq!(result.health, "connected");
    assert_eq!(
        call_names(&cli.borrow().calls),
        ["mcp get editkin", "mcp add --scope", "mcp get editkin"]
    );
}

#[test]
fn claude_reconnect_with_the_same_entry_changes_nothing() {
    let fixture = Fixture::new();
    let cli = Rc::new(RefCell::new(FakeClaude::new(ReportStyle::Quoted)));
    run_claude(&cli, &fixture, &fixture.workspace).unwrap();
    cli.borrow_mut().calls.clear();
    let again = run_claude(&cli, &fixture, &fixture.workspace).unwrap();
    assert_eq!(again.change, ConfigChange::Unchanged);
    assert_eq!(call_names(&cli.borrow().calls), ["mcp get editkin"]);
}

#[test]
fn claude_reconnect_with_a_different_entry_replaces_only_editkin() {
    // #105: add-json on an existing entry failed and was reported as "did not accept the automatic setup".
    let fixture = Fixture::new();
    let cli = Rc::new(RefCell::new(FakeClaude::new(ReportStyle::Unquoted)));
    run_claude(&cli, &fixture, &fixture.workspace).unwrap();
    cli.borrow_mut().calls.clear();
    let moved = fixture.root.join("新的 工作區");
    fs::create_dir_all(&moved).unwrap();
    let result = run_claude(&cli, &fixture, &moved).unwrap();
    assert_eq!(result.change, ConfigChange::Replaced);
    let state = cli.borrow();
    assert_eq!(
        call_names(&state.calls),
        ["mcp get editkin", "mcp remove editkin", "mcp add --scope", "mcp get editkin"]
    );
    assert_eq!(state.calls[1], strings_of(&["mcp", "remove", "editkin", "-s", "user"]));
    assert_eq!(state.others, ["other-server"]);
    assert!(state
        .entry
        .as_ref()
        .unwrap()
        .environment
        .contains(&("EDITKIN_WORKSPACE".into(), moved.to_string_lossy().to_string())));
}

#[test]
fn claude_unreadable_get_then_existing_entry_is_replaced_after_add_refuses() {
    let fixture = Fixture::new();
    let cli = Rc::new(RefCell::new(FakeClaude::new(ReportStyle::Quoted)));
    run_claude(&cli, &fixture, &fixture.workspace).unwrap();
    cli.borrow_mut().calls.clear();
    let moved = fixture.root.join("third");
    fs::create_dir_all(&moved).unwrap();
    let mut log = fixture.log();
    let shared = cli.clone();
    let mut first_get = true;
    // The first `mcp get` times out (Claude's own health check of the old entry hung).
    let mut runner = move |args: &[String], _: Duration| {
        if first_get && args == ["mcp", "get", "editkin"] {
            first_get = false;
            shared.borrow_mut().calls.push(args.to_vec());
            return Err("Agent CLI 在期限內沒有回應".to_string());
        }
        shared.borrow_mut().run(args)
    };
    let result = configure_agent_mcp(
        "claude",
        &mut runner,
        &fixture.expected(&moved),
        &fixture.add_args("claude", &moved),
        &mut log,
    )
    .unwrap();
    assert_eq!(result.change, ConfigChange::Replaced);
    assert_eq!(
        call_names(&cli.borrow().calls),
        ["mcp get editkin", "mcp add --scope", "mcp remove editkin", "mcp add --scope", "mcp get editkin"]
    );
}

#[test]
fn claude_refusals_are_structured_and_offer_the_fallback() {
    let fixture = Fixture::new();
    let cli = Rc::new(RefCell::new(FakeClaude::new(ReportStyle::Unquoted)));
    cli.borrow_mut().refuse_add = true;
    let refused = run_claude(&cli, &fixture, &fixture.workspace).unwrap_err();
    assert_eq!(
        (refused.step, refused.code, refused.prior, refused.offer_fallback),
        (SetupStep::WriteConfig, FailureCode::ConfigWriteRefused, PriorEntry::Absent, true)
    );
    assert!(refused.detail.contains("permission denied writing .claude.json"), "{}", refused.detail);

    let cli = Rc::new(RefCell::new(FakeClaude::new(ReportStyle::Unquoted)));
    run_claude(&cli, &fixture, &fixture.workspace).unwrap();
    cli.borrow_mut().refuse_remove = true;
    let moved = fixture.root.join("moved");
    fs::create_dir_all(&moved).unwrap();
    let existing = run_claude(&cli, &fixture, &moved).unwrap_err();
    assert_eq!(
        (existing.step, existing.code, existing.prior, existing.offer_fallback),
        (SetupStep::WriteConfig, FailureCode::ConfigAlreadyExistsDifferent, PriorEntry::Present, true)
    );
}

#[test]
fn claude_failed_connection_after_writing_is_a_health_check_failure_not_a_refusal() {
    let fixture = Fixture::new();
    let cli = Rc::new(RefCell::new(FakeClaude::new(ReportStyle::Unquoted)));
    cli.borrow_mut().status = "✗ Failed to connect".into();
    let failure = run_claude(&cli, &fixture, &fixture.workspace).unwrap_err();
    assert_eq!(
        (failure.step, failure.code, failure.offer_fallback),
        (SetupStep::HealthCheck, FailureCode::HealthCheckFailed, false)
    );
    assert!(failure.detail.contains("✗ Failed to connect"));
    // The same exact entry on the next attempt is not rewritten, and still reported honestly.
    cli.borrow_mut().calls.clear();
    let again = run_claude(&cli, &fixture, &fixture.workspace).unwrap_err();
    assert_eq!(again.code, FailureCode::HealthCheckFailed);
    assert_eq!(call_names(&cli.borrow().calls), ["mcp get editkin"]);
}

fn codex_report(fixture: &Fixture, workspace: &Path) -> String {
    json!({
        "name": "editkin",
        "enabled": true,
        "disabled_reason": null,
        "transport": {
            "type": "stdio",
            "command": fixture.executable,
            "args": [fixture.launcher],
            "env": fixture.environment(workspace).into_iter().collect::<BTreeMap<_, _>>(),
            "env_vars": [],
            "cwd": null,
        },
        "enabled_tools": null,
        "disabled_tools": null,
        "startup_timeout_sec": null,
        "tool_timeout_sec": null,
    })
    .to_string()
}

#[test]
fn codex_reconnect_is_idempotent_and_replaces_a_stale_entry() {
    let fixture = Fixture::new();
    let fixture = &fixture;
    let configured = Rc::new(RefCell::new(None::<PathBuf>));
    let calls = Rc::new(RefCell::new(Vec::<Vec<String>>::new()));
    let run = |workspace: &Path| {
        let mut log = fixture.log();
        let (configured, calls) = (configured.clone(), calls.clone());
        let mut runner = move |args: &[String], _: Duration| {
            calls.borrow_mut().push(args.to_vec());
            match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
                ["mcp", "get", "editkin", "--json"] => Ok(match configured.borrow().as_ref() {
                    Some(workspace) => CliRun { success: true, stdout: codex_report(&fixture, workspace).into_bytes(), stderr: Vec::new() },
                    None => CliRun { success: false, stdout: Vec::new(), stderr: b"Error: No MCP server named 'editkin' found.".to_vec() },
                }),
                ["mcp", "add", "editkin", rest @ ..] => {
                    let workspace = rest
                        .iter()
                        .find_map(|part| part.strip_prefix("EDITKIN_WORKSPACE="))
                        .map(PathBuf::from)
                        .unwrap();
                    *configured.borrow_mut() = Some(workspace);
                    Ok(CliRun { success: true, stdout: b"Added global MCP server 'editkin'.".to_vec(), stderr: Vec::new() })
                }
                other => panic!("unexpected codex call {other:?}"),
            }
        };
        configure_agent_mcp("codex", &mut runner, &fixture.expected(workspace), &fixture.add_args("codex", workspace), &mut log)
    };
    assert_eq!(run(&fixture.workspace).unwrap().change, ConfigChange::Added);
    calls.borrow_mut().clear();
    assert_eq!(run(&fixture.workspace).unwrap().change, ConfigChange::Unchanged);
    assert_eq!(calls.borrow().len(), 1);
    let moved = fixture.root.join("codex moved");
    fs::create_dir_all(&moved).unwrap();
    assert_eq!(run(&moved).unwrap().change, ConfigChange::Replaced);
}

#[test]
fn command_copied_is_claimed_only_for_a_verified_clipboard() {
    let fields = |fallback: Fallback| fallback_result_fields(&fallback).into_iter().collect::<BTreeMap<_, _>>();
    let copied = fields(Fallback {
        command: Some("claude mcp add --scope user editkin -- node x".into()),
        script_path: Some(PathBuf::from(r"C:\state\Connect Editkin to Claude Code.cmd")),
        clipboard_written: true,
    });
    assert_eq!(copied["status"], json!("command_copied"));
    assert_eq!(copied["health"], json!("manual_step"));
    assert_eq!(copied["clipboardWritten"], json!(true));
    assert_eq!(copied["fallbackCommand"], json!("claude mcp add --scope user editkin -- node x"));
    assert_eq!(copied["fallbackKind"], json!(if cfg!(windows) { "windows_shell" } else { "posix_shell" }));
    let not_copied = fields(Fallback {
        command: Some("claude mcp add --scope user editkin -- node x".into()),
        script_path: None,
        clipboard_written: false,
    });
    assert!(!not_copied.contains_key("status") && !not_copied.contains_key("health"));
    assert_eq!(not_copied["clipboardWritten"], json!(false));
    assert!(not_copied.contains_key("fallbackCommand"), "shown for manual copying");
    let nothing = fields(Fallback { command: None, script_path: None, clipboard_written: true });
    assert!(!nothing.contains_key("status") && !nothing.contains_key("fallbackKind"));
    assert_eq!(nothing["clipboardWritten"], json!(false));
}

// ---- progress feed ---------------------------------------------------------------------------------------------

fn collecting_log(fixture: &Fixture) -> (ConnectLog, std::sync::Arc<std::sync::Mutex<Vec<(String, String)>>>) {
    let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = events.clone();
    let mut log = fixture.log();
    log.set_progress(Box::new(move |event: Value| {
        sink.lock().unwrap().push((
            event["step"].as_str().unwrap().to_string(),
            event["state"].as_str().unwrap().to_string(),
        ));
    }));
    (log, events)
}

fn pairs(list: &[(&str, &str)]) -> Vec<(String, String)> {
    list.iter().map(|(step, state)| (step.to_string(), state.to_string())).collect()
}

#[test]
fn progress_reports_the_three_screen_steps_running_done_and_failed() {
    let fixture = Fixture::new();
    // A fresh connect: prepare (probe included) → write → health check.
    let (mut log, events) = collecting_log(&fixture);
    log.step(SetupStep::Detect);
    log.step(SetupStep::PrepareRuntime);
    log.step(SetupStep::Probe);
    let cli = Rc::new(RefCell::new(FakeClaude::new(ReportStyle::Unquoted)));
    let shared = cli.clone();
    let mut runner = move |args: &[String], _: Duration| shared.borrow_mut().run(args);
    configure_agent_mcp("claude", &mut runner, &fixture.expected(&fixture.workspace), &fixture.add_args("claude", &fixture.workspace), &mut log).unwrap();
    log.finish_progress(true);
    assert_eq!(
        *events.lock().unwrap(),
        pairs(&[
            ("prepare_runtime", "running"),
            ("prepare_runtime", "done"),
            ("write_config", "running"),
            ("write_config", "done"),
            ("health_check", "running"),
            ("health_check", "done"),
        ])
    );
    // Reconnecting to the same entry skips the write; every step still ends done.
    let (mut log, events) = collecting_log(&fixture);
    log.step(SetupStep::PrepareRuntime);
    let shared = cli.clone();
    let mut runner = move |args: &[String], _: Duration| shared.borrow_mut().run(args);
    let unchanged = configure_agent_mcp("claude", &mut runner, &fixture.expected(&fixture.workspace), &fixture.add_args("claude", &fixture.workspace), &mut log).unwrap();
    assert_eq!(unchanged.change, ConfigChange::Unchanged);
    log.finish_progress(true);
    assert_eq!(
        *events.lock().unwrap(),
        pairs(&[
            ("prepare_runtime", "running"),
            ("prepare_runtime", "done"),
            ("write_config", "running"),
            ("write_config", "done"),
            ("health_check", "done"),
        ])
    );
    // A failing probe fails the first step and reports nothing after it.
    let (mut log, events) = collecting_log(&fixture);
    log.step(SetupStep::PrepareRuntime);
    log.step(SetupStep::Probe);
    log.finish_progress(false);
    assert_eq!(*events.lock().unwrap(), pairs(&[("prepare_runtime", "running"), ("prepare_runtime", "failed")]));
}

// ---- official pages, work folder, finding the CLI -------------------------------------------------------------

#[test]
fn only_the_four_official_pages_open_and_everything_else_is_refused() {
    for url in EXTERNAL_URL_ALLOWLIST {
        assert!(allowed_external_url(url), "{url}");
    }
    for refused in [
        "http://code.claude.com/docs/en/setup",
        "https://code.claude.com/docs/en/setup/",
        "https://code.claude.com/docs/en/setup?x=1",
        "https://code.claude.com/docs/en/setup#install",
        "HTTPS://CODE.CLAUDE.COM/docs/en/setup",
        " https://code.claude.com/docs/en/setup",
        "https://code.claude.com@evil.example/docs/en/setup",
        "https://code.claude.com.evil.example/docs/en/setup",
        "https://github.com/openai/codex/../../evil",
        "https://github.com/Hao0321/Editkin/releases/download/x/evil.exe",
        "https://github.com/Hao0321",
        "file:///C:/Windows/System32/calc.exe",
        "javascript:alert(1)",
        "ms-settings:",
        r"C:\Windows\System32\calc.exe",
        "",
    ] {
        assert!(!allowed_external_url(refused), "{refused}");
        // The command refuses before any process starts.
        assert!(open_external_url(refused.to_string()).unwrap_err().contains("已拒絕"), "{refused}");
    }
}

#[test]
fn a_raw_path_or_a_forged_token_is_refused() {
    let choices = WorkspaceChoices::default();
    let now = Instant::now();
    choices.issue(PathBuf::from(r"D:\EditkinWork"), false, "main", now).unwrap();
    for forged in [
        r"C:\",
        win_user(r"someone\Documents").as_str(),
        r"\\server\share",
        "../../Windows",
        "",
        "0123456789abcdef0123456789abcdef",
        "0123456789ABCDEF0123456789ABCDEF",
        "0123456789abcdef0123456789abcde",
        "not-a-token-not-a-token-not-a-to",
    ] {
        assert_eq!(choices.redeem(forged, "main", now), Err(WorkspaceTokenError::Expired), "{forged}");
    }
}

#[test]
fn a_folder_token_works_once_only_in_its_window_and_expires() {
    let choices = WorkspaceChoices::default();
    let now = Instant::now();
    let path = PathBuf::from(r"D:\EditkinWork");
    let token = choices.issue(path.clone(), false, "main", now).unwrap();
    assert_eq!(token.len(), 32);
    assert_ne!(token, choices.issue(path.clone(), false, "main", now).unwrap(), "random per choice");
    assert_eq!(choices.redeem(&token, "main", now + Duration::from_secs(5)).unwrap().path, path);
    assert_eq!(choices.redeem(&token, "main", now + Duration::from_secs(6)), Err(WorkspaceTokenError::Expired), "single use");

    let late = choices.issue(path.clone(), false, "main", now).unwrap();
    assert_eq!(
        choices.redeem(&late, "main", now + WORKSPACE_CHOICE_TTL + Duration::from_secs(1)),
        Err(WorkspaceTokenError::Expired),
        "expired after ten minutes"
    );
    let in_time = choices.issue(path.clone(), false, "main", now).unwrap();
    assert!(choices.redeem(&in_time, "main", now + WORKSPACE_CHOICE_TTL - Duration::from_secs(1)).is_ok());

    let other_window = choices.issue(path.clone(), false, "main", now).unwrap();
    assert_eq!(choices.redeem(&other_window, "remote-preview", now), Err(WorkspaceTokenError::Expired));
    assert_eq!(choices.redeem(&other_window, "main", now), Err(WorkspaceTokenError::Expired), "a refused attempt still uses it");
    let issued_elsewhere = choices.issue(path, false, "remote-preview", now).unwrap();
    assert_eq!(choices.redeem(&issued_elsewhere, "main", now), Err(WorkspaceTokenError::Expired));
}

#[test]
#[cfg(windows)]
fn every_unsafe_folder_kind_is_refused_and_ordinary_subfolders_are_allowed() {
    let user = win_user("Ana");
    let lookup = |name: &str| match name {
        "USERPROFILE" => Some(user.clone()),
        "APPDATA" => Some(format!(r"{user}\AppData\Roaming")),
        "LOCALAPPDATA" => Some(format!(r"{user}\AppData\Local")),
        "SystemRoot" | "windir" => Some(r"C:\Windows".to_string()),
        "ProgramFiles" | "ProgramW6432" => Some(r"C:\Program Files".to_string()),
        "ProgramFiles(x86)" => Some(r"C:\Program Files (x86)".to_string()),
        "ProgramData" => Some(r"C:\ProgramData".to_string()),
        _ => None,
    };
    for refused in [
        r"C:\".to_string(),
        r"D:\".into(),
        user.clone(),
        format!(r"{WIN_USERS_LOWER}\ana\"),
        format!(r"{user}\AppData"),
        format!(r"{user}\AppData\Roaming"),
        format!(r"{user}\AppData\Local\"),
        r"C:\Windows".into(),
        r"C:\WINDOWS\System32".into(),
        r"C:\Program Files".into(),
        r"C:\Program Files\Editkin".into(),
        r"C:\Program Files (x86)\Common Files".into(),
        r"C:\ProgramData".into(),
        r"C:\ProgramData\Editkin".into(),
        r"\\server\share\EditkinWork".into(),
        r"\\?\UNC\server\share\EditkinWork".into(),
        r"\\.\pipe\editkin".into(),
        r"\??\C:\EditkinWork".into(),
        format!(r"{user}\Documents\CON"),
        format!(r"{user}\Documents\..\..\..\Windows"),
        r"relative\EditkinWork".into(),
    ] {
        assert!(unsafe_workspace_reason(Path::new(&refused), &lookup).is_some(), "{refused}");
    }
    for allowed in [
        format!(r"{user}\Documents\Editkin 作品"),
        r"D:\EditkinWork".into(),
        r"\\?\D:\EditkinWork".into(),
        format!(r"{user}\Videos\旅行 & 作品 (二)"),
        r"E:\Program Files Backup\work".into(),
    ] {
        assert_eq!(unsafe_workspace_reason(Path::new(&allowed), &lookup), None, "{allowed}");
    }
}

#[test]
fn the_suggested_default_and_a_picked_subfolder_both_connect() {
    let fixture = Fixture::new();
    let choices = WorkspaceChoices::default();
    let now = Instant::now();
    // The suggestion is created by the setup; the picked folder already exists.
    let suggested = fixture.root.join("Documents").join(DEFAULT_WORKSPACE_NAME);
    let picked = fixture.root.join("EditkinWork 二");
    fs::create_dir_all(&picked).unwrap();
    for (path, create_if_missing) in [(suggested.clone(), true), (picked.clone(), false)] {
        let token = choices.issue(path.clone(), create_if_missing, "main", now).unwrap();
        let choice = choices.redeem(&token, "main", now).unwrap();
        let workspace = prepare_chosen_workspace(&choice).unwrap();
        assert!(path.is_dir());
        assert_eq!(fs::canonicalize(workspace.path()).unwrap(), fs::canonicalize(&path).unwrap());
        let cli = Rc::new(RefCell::new(FakeClaude::new(ReportStyle::Unquoted)));
        let shared = cli.clone();
        let mut runner = move |args: &[String], _: Duration| shared.borrow_mut().run(args);
        let mut log = fixture.log();
        let connected = configure_agent_mcp(
            "claude",
            &mut runner,
            &fixture.expected(workspace.path()),
            &fixture.add_args("claude", workspace.path()),
            &mut log,
        )
        .unwrap();
        assert_eq!((connected.change, connected.health), (ConfigChange::Added, "connected"));
        assert!(cli.borrow().entry.as_ref().unwrap().environment.contains(&(
            "EDITKIN_WORKSPACE".to_string(),
            workspace.path().to_string_lossy().to_string()
        )));
    }
    // A picked folder that disappeared is not silently re-created.
    let gone = fixture.root.join("gone");
    let token = choices.issue(gone.clone(), false, "main", now).unwrap();
    let error = prepare_chosen_workspace(&choices.redeem(&token, "main", now).unwrap()).unwrap_err();
    assert!(error.contains("已不存在") && !gone.exists(), "{error}");
    // Whatever reaches the store is checked again when the setup uses it.
    let token = choices.issue(PathBuf::from(r"C:\"), true, "main", now).unwrap();
    assert!(prepare_chosen_workspace(&choices.redeem(&token, "main", now).unwrap()).is_err());
}

#[test]
fn the_last_connected_folder_is_remembered_only_while_it_exists() {
    let root = scratch("remembered");
    let workspace = root.join("作品");
    fs::create_dir_all(&workspace).unwrap();
    assert_eq!(remembered_workspace(&root), None);
    remember_workspace(&root, &workspace);
    assert_eq!(remembered_workspace(&root), Some(workspace.clone()));
    fs::remove_dir(&workspace).unwrap();
    assert_eq!(remembered_workspace(&root), None, "a removed folder is not suggested");
    fs::write(root.join("agent-connect-workspace.json"), br#"{"schema":"other","path":"C:\\"}"#).unwrap();
    assert_eq!(remembered_workspace(&root), None);
    fs::remove_dir_all(root).unwrap();
}

#[test]
#[cfg(windows)]
fn registry_and_npm_locations_become_absolute_search_folders() {
    let user = win_user("測試 User");
    let lookup = |name: &str| match name {
        "USERPROFILE" => Some(user.clone()),
        "APPDATA" => Some(format!(r"{user}\AppData\Roaming")),
        "LOCALAPPDATA" => Some(format!(r"{user}\AppData\Local")),
        _ => None,
    };
    assert_eq!(
        expand_percent_variables(r"%USERPROFILE%\.local\bin;%UNKNOWN%\x;100%;%%", &lookup),
        format!(r"{user}\.local\bin;%UNKNOWN%\x;100%;%%")
    );
    assert_eq!(
        path_list_directories(r#"%LOCALAPPDATA%\Programs\x;;relative;"%USERPROFILE%\.local\bin" ; C:\Tools"#, &lookup),
        [
            PathBuf::from(format!(r"{user}\AppData\Local\Programs\x")),
            PathBuf::from(format!(r"{user}\.local\bin")),
            PathBuf::from(r"C:\Tools"),
        ]
    );
    assert_eq!(
        npm_global_prefixes(&lookup, Some("registry=https://example\nprefix = \"D:\\npm global\"\n")),
        [PathBuf::from(r"D:\npm global"), PathBuf::from(format!(r"{user}\AppData\Roaming\npm"))]
    );
    assert_eq!(
        merge_search_directories(vec![
            vec![PathBuf::from(r"C:\Tools"), PathBuf::from("relative")],
            vec![PathBuf::from(r"c:\tools\"), PathBuf::from(r"D:\npm")],
        ]),
        [PathBuf::from(r"C:\Tools"), PathBuf::from(r"D:\npm")]
    );
    assert_eq!(plain_path_text(r"\\?\C:\Program Files\x.exe"), r"C:\Program Files\x.exe");
    assert_eq!(plain_path_text(r"\\?\UNC\host\share\x"), r"\\host\share\x");
    assert_eq!(plain_path_text(r"C:\x"), r"C:\x");
    // The real search list always includes Editkin's own PATH entries.
    let live = agent_cli_search_directories();
    assert!(live.iter().all(|directory| directory.is_absolute()));
}

#[test]
#[cfg(windows)]
fn a_cli_installed_after_startup_is_found_in_every_install_layout() {
    let root = scratch("cli layouts");
    let touch = |path: PathBuf| {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"fixture").unwrap();
        path
    };
    let empty = root.join("empty");
    fs::create_dir_all(&empty).unwrap();
    assert!(crate::locate_agent_cli_in("claude", &[empty.clone()]).is_none());
    // Claude's native installer: %USERPROFILE%\.local\bin\claude.exe.
    let native = root.join("home").join(".local").join("bin");
    let claude = touch(native.join("claude.exe"));
    let found = crate::locate_agent_cli_in("claude", &[empty.clone(), native.clone()]).unwrap();
    assert_eq!(found.command, fs::canonicalize(&claude).unwrap());
    assert!(found.prefix_args.is_empty());
    // npm (current package): %APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe beside claude.cmd.
    let npm = root.join("AppData").join("Roaming").join("npm");
    touch(npm.join("claude.cmd"));
    let packaged = touch(npm.join(r"node_modules\@anthropic-ai\claude-code\bin\claude.exe"));
    assert_eq!(crate::locate_agent_cli_in("claude", &[npm.clone()]).unwrap().command, fs::canonicalize(&packaged).unwrap());
    // npm (older package): cli.js started by node.
    let legacy = root.join("legacy npm");
    let node_dir = root.join("nodejs");
    let node = touch(node_dir.join("node.exe"));
    let cli = touch(legacy.join(r"node_modules\@anthropic-ai\claude-code\cli.js"));
    let found = crate::locate_agent_cli_in("claude", &[legacy.clone(), node_dir.clone()]).unwrap();
    assert_eq!(found.command, fs::canonicalize(&node).unwrap());
    assert_eq!(found.prefix_args, [fs::canonicalize(&cli).unwrap().to_string_lossy().to_string()]);
    // Codex from npm: node + codex.js.
    let codex = touch(npm.join(r"node_modules\@openai\codex\bin\codex.js"));
    let found = crate::locate_agent_cli_in("codex", &[npm.clone(), node_dir.clone()]).unwrap();
    assert_eq!(found.command, fs::canonicalize(&node).unwrap());
    assert_eq!(found.prefix_args, [fs::canonicalize(&codex).unwrap().to_string_lossy().to_string()]);
    assert!(crate::locate_agent_cli_in("other", &[native]).is_none());
    fs::remove_dir_all(root).unwrap();
}

// ---- universal quoting -----------------------------------------------------------------------------------------

#[test]
fn universal_tokens_quote_paths_and_refuse_shell_specific_characters() {
    assert_eq!(universal_shell_token("mcp").as_deref(), Some("mcp"));
    assert_eq!(universal_shell_token("--").as_deref(), Some("--"));
    assert_eq!(universal_shell_token("ELECTRON_RUN_AS_NODE=1").as_deref(), Some("ELECTRON_RUN_AS_NODE=1"));
    assert_eq!(universal_shell_token(r"K=D:\影片\作品").as_deref(), Some(r"K=D:\影片\作品"));
    assert_eq!(universal_shell_token(r"D:\a\").as_deref(), Some(r"D:\a\"), "bare tokens keep a trailing backslash");
    assert_eq!(
        universal_shell_token(r"K=C:\Program Files\Ana's (二) & 作品").as_deref(),
        Some(r#""K=C:\Program Files\Ana's (二) & 作品""#)
    );
    for refused in [
        r"K=C:\a b\",          // quoted + trailing backslash: PowerShell 5.1 and 7 disagree
        r"K=C:\100% done",     // cmd expands %
        r"K=C:\$HOME x",       // PowerShell expands $
        "K=C:\\a `b",          // PowerShell escape
        "K=C:\\a \u{201C}b",   // PowerShell curly quote
        r"K=C:\a&b",           // no space: PowerShell drops the quotes, a .cmd shim sees &
        r"K=C:\a(b)",
        "K=\"x\"",
        "K=a\nb",
        "",
    ] {
        assert_eq!(universal_shell_token(refused), None, "{refused:?}");
    }
    assert_eq!(batch_quote(r"C:\100% & $x !y ^z\"), Some(r#""C:\100%% & $x !y ^z\\""#.to_string()));
    assert_eq!(batch_quote("a\"b"), None);
    let state_script = format!(
        r"{}\AppData\Roaming\studio.hao.editkin\agent-runtime-v3\Connect Editkin to Claude Code.cmd",
        win_user("測試 User")
    );
    assert_eq!(
        script_invocation(Path::new(&state_script)).as_deref(),
        Some(format!(r#"cmd /d /c call "{state_script}" --no-pause"#).as_str())
    );
    assert_eq!(script_invocation(Path::new(&win_user(r"a%b\x y.cmd"))), None);
    assert_eq!(script_invocation(Path::new(&win_user(r"$me\x y.cmd"))), None);
}

// ---- macOS: POSIX shells, folders, CLI locations (pure rules, run on every system) ------------------------------

/// The part of POSIX shell word parsing a pasted line can meet: blanks split words, '...' is literal and `\x` is x.
/// Everything zsh or bash would interpret when unquoted ($ ` * ? [ ] { } ( ) < > | & ; # ! ~ " newline, and a word
/// starting with `=`) is an error here, so a line that parses is one both shells read back exactly.
fn posix_words(line: &str) -> Result<Vec<String>, String> {
    let mut words = Vec::new();
    let mut chars = line.chars().peekable();
    loop {
        while matches!(chars.peek(), Some(' ')) {
            chars.next();
        }
        if chars.peek().is_none() {
            break;
        }
        let mut word = String::new();
        let mut first = true;
        while let Some(&character) = chars.peek() {
            match character {
                ' ' => break,
                '\'' => {
                    chars.next();
                    loop {
                        match chars.next() {
                            Some('\'') => break,
                            Some(quoted) => word.push(quoted),
                            None => return Err("unterminated '".into()),
                        }
                    }
                }
                '\\' => {
                    chars.next();
                    word.push(chars.next().ok_or("trailing backslash")?);
                }
                '=' if first => return Err("unquoted leading = (zsh EQUALS)".into()),
                '$' | '`' | '*' | '?' | '[' | ']' | '{' | '}' | '(' | ')' | '<' | '>' | '|' | '&' | ';' | '#' | '!'
                | '~' | '"' | '\n' | '\t' => return Err(format!("unquoted {character:?} would be interpreted")),
                other => {
                    chars.next();
                    word.push(other);
                }
            }
            first = false;
        }
        words.push(word);
    }
    Ok(words)
}

#[test]
fn posix_tokens_read_back_exactly_under_zsh_and_bash_word_rules() {
    let samples = [
        "mcp", "--", "-e", "--scope", "ELECTRON_RUN_AS_NODE=1", "/Applications/Editkin.app/Contents/Resources/runtime/node",
        "EDITKIN_WORKSPACE=/Users/ana/Movies/Editkin 作品", "it's", "'", "''", "a'b'c", "$HOME", "${HOME}", "`date`",
        "$(date)", "\\", r"C:\Tools\x\", "!bang", "\"quoted\"", "semi;colon", "amp&er", "pipe|x", "star*", "q?",
        "[x]", "{a,b}", "(sub)", "<in", ">out", "#hash", "~/x", "a~b", "=cmd", "a=b", "x y", "%PATH%", "^caret",
        "😀 emoji", "", "trailing\\", " lead", "end ", "-", "@", "a:b,c+d",
    ];
    for sample in samples {
        let token = posix_shell_token(sample).unwrap();
        assert!(token.starts_with('\'') || token.chars().all(|c| c.is_ascii_alphanumeric() || "_-./:,+@=".contains(c)), "{token}");
        assert_eq!(posix_words(&token).unwrap(), vec![sample.to_string()], "{sample:?} -> {token}");
    }
    for refused in ["a\nb", "a\rb", "tab\there", "bell\u{7}"] {
        assert_eq!(posix_shell_token(refused), None, "{refused:?}");
    }
    // The grammar itself rejects what would be interpreted.
    for interpreted in ["$HOME", "a b*", "~/x", "=cmd", "x;y", "\"x\""] {
        assert!(posix_words(interpreted).is_err(), "{interpreted}");
    }
}

#[test]
fn the_macos_fallback_command_is_exactly_the_add_arguments_with_no_json() {
    let environment = [
        ("ELECTRON_RUN_AS_NODE".to_string(), "1".to_string()),
        ("EDITKIN_AGENT_STATE_ROOT".to_string(), "/Users/ana o'neil/Library/Application Support/studio.hao.editkin/agent-runtime-v3".to_string()),
        ("EDITKIN_WORKSPACE".to_string(), "/Volumes/T7/Ana's 作品 $HOME `x` ~ !bang (a) & b; c".to_string()),
        ("EDITKIN_PLUGIN_ROOTS".to_string(), "/Applications/Editkin.app/Contents/Resources/plugins:/Users/ana/x".to_string()),
    ];
    for target in ["claude", "codex"] {
        let args = crate::agent_setup::agent_add_arguments(
            target,
            "/Applications/Editkin.app/Contents/Resources/runtime/node",
            "/Applications/Editkin.app/Contents/Resources/agent-runtime-v3/launcher.mjs",
            &environment,
        );
        let line = render_posix_command(target, &args).unwrap();
        let words = posix_words(&line).unwrap();
        assert_eq!(words[0], target);
        assert_eq!(words[1..], args[..], "{line}");
        assert!(!line.contains("add-json") && !line.contains('{'));
        assert_eq!(FallbackShell::Posix.render_command(target, &args), Some(line));
    }
    assert_eq!(FallbackShell::Posix.kind(), "posix_shell");
    assert_eq!(FallbackShell::Windows.kind(), "windows_shell");
    assert_eq!(FallbackShell::CURRENT, if cfg!(windows) { FallbackShell::Windows } else { FallbackShell::Posix });
}

#[test]
fn the_macos_command_file_runs_the_same_steps_with_exact_arguments() {
    let args = crate::agent_setup::agent_add_arguments(
        "claude",
        "/Applications/Editkin.app/Contents/Resources/runtime/node",
        "/Applications/Editkin.app/Contents/Resources/agent-runtime-v3/launcher.mjs",
        &[("EDITKIN_WORKSPACE".to_string(), "/Users/ana/Movies/Ana's 作品 $x".to_string())],
    );
    let program = vec!["/Users/ana/.local/share/claude/versions/2.1.311".to_string()];
    let script = posix_fallback_script("claude", &program, &args).unwrap();
    assert!(script.starts_with("#!/bin/bash\n") && !script.contains('\r'));
    let line_words = |prefix: &str, suffix: &str| -> Vec<Vec<String>> {
        script
            .lines()
            .filter_map(|line| line.strip_prefix(prefix)?.strip_suffix(suffix))
            .map(|command| posix_words(command).unwrap())
            .collect()
    };
    let with_program = |rest: &[String]| program.iter().cloned().chain(rest.iter().cloned()).collect::<Vec<_>>();
    assert_eq!(line_words("if ! ", "; then"), [with_program(&args)]);
    assert_eq!(line_words("  ", " || status=1"), [with_program(&args)]);
    let command_line = |marker: &str| {
        let line = script.lines().find(|line| line.contains(marker)).unwrap();
        posix_words(line.trim_start()).unwrap()
    };
    assert_eq!(command_line(" mcp remove "), with_program(&strings_of(&["mcp", "remove", "editkin", "-s", "user"])));
    assert_eq!(command_line(" mcp get "), with_program(&strings_of(&["mcp", "get", "editkin"])));
    // Codex: no remove step (codex mcp add replaces the entry).
    let codex = posix_fallback_script("codex", &["/opt/homebrew/bin/node".to_string(), "/x/codex.js".to_string()], &args).unwrap();
    assert!(!codex.contains("mcp remove"));
    assert_eq!(FallbackShell::Posix.script_name("claude"), "Connect Editkin to Claude Code.command");
    assert_eq!(FallbackShell::Posix.script_name("codex"), "Connect Editkin to Codex.command");
    let state = Path::new("/Users/ana/Library/Application Support/studio.hao.editkin/agent-runtime-v3/Connect Editkin to Claude Code.command");
    let invocation = FallbackShell::Posix.script_invocation(state).unwrap();
    assert_eq!(posix_words(&invocation).unwrap(), [state.to_str().unwrap(), "--no-pause"]);
}

#[test]
fn macos_work_folder_rules_refuse_system_whole_volume_home_and_library_folders() {
    let home = Some("/Users/ana");
    for refused in [
        "/", "//", "/System", "/System/Library/CoreServices", "/Library", "/Applications", "/usr", "/usr/local/work",
        "/bin", "/sbin/x", "/private", "/Users", "/Volumes", "/Volumes/T7", "/Volumes/T7/", "/Users/ana", "/Users/ANA/",
        "/users/ana/./", "/Users/ana/Library", "/Users/ana/Library/Application Support/Editkin", "/Users/ana/Movies/../Library",
        "relative/work", "/dev/disk0",
    ] {
        assert!(posix_workspace_refusal(refused, home).is_some(), "{refused}");
    }
    for allowed in [
        "/Users/ana/Movies/Editkin 作品", "/Users/ana/Documents/Editkin 作品", "/Users/ana/Movies/旅行/2026",
        "/Volumes/T7/EditkinWork", "/Volumes/外接硬碟/影片", "/private/var/folders/x/T/editkin", "/Users/ana/Desktop/work",
    ] {
        assert_eq!(posix_workspace_refusal(allowed, home), None, "{allowed}");
    }
    assert_eq!(posix_workspace_refusal("/Users/ana", None), None, "without $HOME the home rule cannot apply");
}

#[test]
fn macos_cli_folders_cover_the_native_installer_homebrew_npm_and_the_login_shell() {
    let lookup = |name: &str| (name == "NPM_CONFIG_PREFIX").then(|| "~/npm-prefix".to_string());
    let prefixes = posix_npm_prefixes(&lookup, Some("prefix=/Users/ana/.npm-packages\ncolor=false\nprefix = relative\n"), Some("/Users/ana"));
    assert_eq!(prefixes, ["/Users/ana/npm-prefix", "/Users/ana/.npm-packages"]);
    assert_eq!(
        posix_standard_cli_directories(Some("/Users/ana/"), &prefixes),
        [
            "/Users/ana/.local/bin", "/opt/homebrew/bin", "/usr/local/bin", "/Users/ana/.npm-global/bin",
            "/Users/ana/npm-prefix/bin", "/Users/ana/.npm-packages/bin", "/Users/ana/.claude/local",
            "/Users/ana/.claude/local/node_modules/.bin",
        ]
    );
    let report = "PATH=/opt/homebrew/bin:/usr/bin:relative:/bin\nCMD=/Users/ana/.local/bin/claude\nCMD=claude: aliased to x\nCMD=/opt/homebrew/bin/node\nNPM_PREFIX=/opt/homebrew/\nnoise\n";
    assert_eq!(
        parse_login_shell_report(report),
        ["/Users/ana/.local/bin", "/opt/homebrew/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/opt/homebrew/bin"]
    );
    assert_eq!(classify_cli_head(b"#!/usr/bin/env node\nrequire('x')", true), CliFileKind::NodeScript);
    assert_eq!(classify_cli_head(b"#!/usr/bin/env -S node --no-warnings\n", true), CliFileKind::NodeScript);
    assert_eq!(classify_cli_head(b"#!/usr/local/bin/node\n", false), CliFileKind::NodeScript);
    assert_eq!(classify_cli_head(b"#!/bin/bash\nexec node \"$@\"\n", true), CliFileKind::OtherScript);
    assert_eq!(classify_cli_head(b"#!/usr/bin/env nodejs-wrapper\n", true), CliFileKind::OtherScript);
    assert_eq!(classify_cli_head(&[0xCF, 0xFA, 0xED, 0xFE, 7, 0, 0, 1], true), CliFileKind::Binary);
    assert_eq!(classify_cli_head(&[0xCF, 0xFA, 0xED, 0xFE], false), CliFileKind::NotExecutable);
}

/// macOS only (the Mac CI runner): the real /bin/zsh and /bin/bash read the pasted command and the generated
/// .command file exactly, through stand-in `claude` / `codex` / `node` scripts that record their argv.
#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    const RECORDER: &str = "#!/bin/sh\n\
{ printf 'CALL\\000'; for a in \"$@\"; do printf '%s\\000' \"$a\"; done; } >> \"$EDITKIN_ARGV_RECORD\"\n\
if [ \"$1\" = mcp ] && [ \"$2\" = add ] && [ -f \"$EDITKIN_STANDIN_FAIL_ONCE\" ]; then\n\
  rm -f \"$EDITKIN_STANDIN_FAIL_ONCE\"; echo 'MCP server editkin already exists in user config' >&2; exit 1\n\
fi\n\
exit 0\n";

    fn executable(path: &Path, bytes: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, bytes).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn calls(record: &Path) -> Vec<Vec<String>> {
        let bytes = fs::read(record).unwrap_or_default();
        String::from_utf8(bytes)
            .unwrap()
            .split("CALL\0")
            .filter(|call| !call.is_empty())
            .map(|call| call.trim_end_matches('\0').split('\0').map(str::to_string).collect())
            .collect()
    }

    #[test]
    fn zsh_and_bash_read_the_pasted_command_and_the_command_file_exactly() {
        let root = scratch("posix shells");
        let bin = root.join("bin 測試");
        for name in ["claude", "codex", "node"] {
            executable(&bin.join(name), RECORDER.as_bytes());
        }
        let environment = [
            ("ELECTRON_RUN_AS_NODE".to_string(), "1".to_string()),
            ("EDITKIN_WORKSPACE".to_string(), "/Volumes/T7/Ana's 作品 $HOME `x` ~ !bang (a) & b; c\\".to_string()),
            ("EDITKIN_PLUGIN_ROOTS".to_string(), "/a b/plugins:/c".to_string()),
        ];
        let shells = ["/bin/zsh", "/bin/bash"].into_iter().filter(|shell| Path::new(shell).is_file()).collect::<Vec<_>>();
        assert!(!shells.is_empty());
        let mut run = 0;
        let mut through = |shell: &str, line: &str, fail_once: bool| {
            run += 1;
            let record = root.join(format!("argv-{run}"));
            let flag = root.join(format!("fail-{run}"));
            if fail_once {
                fs::write(&flag, b"x").unwrap();
            }
            let output = Command::new(shell)
                .arg("-c")
                .arg(line)
                .env("PATH", format!("{}:/usr/bin:/bin", bin.display()))
                .env("EDITKIN_ARGV_RECORD", &record)
                .env("EDITKIN_STANDIN_FAIL_ONCE", &flag)
                .stdin(Stdio::null())
                .output()
                .unwrap();
            (calls(&record), String::from_utf8_lossy(&output.stderr).to_string())
        };
        for target in ["claude", "codex"] {
            let args = crate::agent_setup::agent_add_arguments(target, "/Applications/Editkin.app/node", "/Applications/Editkin.app/launcher.mjs", &environment);
            let line = render_posix_command(target, &args).unwrap();
            for &shell in &shells {
                let (recorded, stderr) = through(shell, &line, false);
                assert_eq!(recorded, [args.clone()], "{target} via {shell}: {line}\n{stderr}");
            }
            let program = if target == "claude" {
                vec![bin.join("claude").to_string_lossy().to_string()]
            } else {
                vec![bin.join("node").to_string_lossy().to_string(), "/Users/ana/.npm-global/lib/node_modules/@openai/codex/bin/codex.js".to_string()]
            };
            let script_path = root.join(FallbackShell::Posix.script_name(target));
            write_fallback_script(&script_path, &posix_fallback_script(target, &program, &args).unwrap()).unwrap();
            assert_eq!(fs::metadata(&script_path).unwrap().permissions().mode() & 0o777, 0o755);
            let invocation = FallbackShell::Posix.script_invocation(&script_path).unwrap();
            let prefix = program[1..].to_vec();
            let with_prefix = |rest: Vec<String>| prefix.iter().cloned().chain(rest).collect::<Vec<_>>();
            for &shell in &shells {
                let (recorded, stderr) = through(shell, &invocation, target == "claude");
                let expected = if target == "claude" {
                    vec![
                        with_prefix(args.clone()),
                        with_prefix(strings_of(&["mcp", "remove", "editkin", "-s", "user"])),
                        with_prefix(args.clone()),
                        with_prefix(strings_of(&["mcp", "get", "editkin"])),
                    ]
                } else {
                    vec![with_prefix(args.clone()), with_prefix(strings_of(&["mcp", "get", "editkin"]))]
                };
                assert_eq!(recorded, expected, "{target} script via {shell}: {invocation}\n{stderr}");
            }
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cli_detection_follows_npm_homebrew_and_native_installer_links() {
        let root = scratch("mac cli layouts");
        let prefix = root.join("homebrew");
        let mach_o = [0xCF_u8, 0xFA, 0xED, 0xFE, 7, 0, 0, 1];
        // npm (current): bin/claude -> ../lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe (native).
        let native = prefix.join("lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe");
        executable(&native, &mach_o);
        fs::create_dir_all(prefix.join("bin")).unwrap();
        symlink("../lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe", prefix.join("bin/claude")).unwrap();
        let found = crate::locate_agent_cli_in("claude", &[prefix.join("bin")]).unwrap();
        assert_eq!(found.command, fs::canonicalize(&native).unwrap());
        assert!(found.prefix_args.is_empty());
        // npm codex: bin/codex -> codex.js (#!/usr/bin/env node) runs through bin/node.
        let codex = prefix.join("lib/node_modules/@openai/codex/bin/codex.js");
        executable(&codex, b"#!/usr/bin/env node\nimport './x.js';\n");
        symlink("../lib/node_modules/@openai/codex/bin/codex.js", prefix.join("bin/codex")).unwrap();
        let node = prefix.join("bin/node");
        executable(&node, &mach_o);
        let found = crate::locate_agent_cli_in("codex", &[prefix.join("bin")]).unwrap();
        assert_eq!(found.command, fs::canonicalize(&node).unwrap());
        assert_eq!(found.prefix_args, [fs::canonicalize(&codex).unwrap().to_string_lossy().to_string()]);
        // ~/.claude/local: the bash wrapper is skipped, its node_modules/.bin link to cli.js runs through node.
        let local = root.join("home/.claude/local");
        executable(&local.join("claude"), b"#!/bin/bash\nexec \"$HOME/.claude/local/node_modules/.bin/claude\" \"$@\"\n");
        let cli = local.join("node_modules/@anthropic-ai/claude-code/cli.js");
        executable(&cli, b"#!/usr/bin/env node\n");
        fs::create_dir_all(local.join("node_modules/.bin")).unwrap();
        symlink("../@anthropic-ai/claude-code/cli.js", local.join("node_modules/.bin/claude")).unwrap();
        let found = crate::locate_agent_cli_in("claude", &[local.clone(), local.join("node_modules/.bin"), prefix.join("bin")]).unwrap();
        assert_eq!(found.command, fs::canonicalize(&node).unwrap());
        assert_eq!(found.prefix_args, [fs::canonicalize(&cli).unwrap().to_string_lossy().to_string()]);
        // A binary without the execute bit is not run.
        let plain = root.join("plain");
        fs::create_dir_all(&plain).unwrap();
        fs::write(plain.join("claude"), mach_o).unwrap();
        assert!(crate::locate_agent_cli_in("claude", &[plain]).is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_real_mac_paths_follow_the_mac_work_folder_rules() {
        let home = env::var("HOME").unwrap();
        let lookup = |name: &str| (name == "HOME").then(|| home.clone());
        for refused in ["/".to_string(), "/Applications".into(), "/Volumes".into(), home.clone(), format!("{home}/Library/Caches")] {
            assert!(unsafe_workspace_reason(Path::new(&refused), &lookup).is_some(), "{refused}");
        }
        for allowed in [format!("{home}/Movies/Editkin 作品"), "/Volumes/T7/EditkinWork".to_string()] {
            assert_eq!(unsafe_workspace_reason(Path::new(&allowed), &lookup), None, "{allowed}");
        }
        assert_eq!(PROFILE_PLACEHOLDER, "~");
        assert_eq!(redact_user_profile(&format!("{home}/Movies/x"), Some(Path::new(&home))), "~/Movies/x");
    }
}

// ---- real shells: cmd.exe, Windows PowerShell 5.1, PowerShell 7 -----------------------------------------------

#[cfg(windows)]
mod shells {
    use super::*;
    use std::os::windows::process::CommandExt;

    /// Stand-in for claude.exe / node.exe: appends its argv as one JSON line to %EDITKIN_ARGV_RECORD%; with
    /// %EDITKIN_STANDIN_FAIL_ONCE% naming an existing file, the first `mcp add` deletes it and fails like Claude
    /// does for an existing entry.
    const RECORDER: &str = r#"
use std::io::Write;
fn escape(text: &str) -> String {
    let mut out = String::from("\"");
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
fn main() {
    let args: Vec<String> = std::env::args_os().skip(1).map(|a| a.to_string_lossy().into_owned()).collect();
    if let Some(record) = std::env::var_os("EDITKIN_ARGV_RECORD") {
        let line = format!("[{}]\n", args.iter().map(|a| escape(a)).collect::<Vec<_>>().join(","));
        std::fs::OpenOptions::new().create(true).append(true).open(record).unwrap().write_all(line.as_bytes()).unwrap();
    }
    let add = args.iter().position(|a| a == "mcp").is_some_and(|i| args.get(i + 1).map(String::as_str) == Some("add"));
    if add {
        if let Some(flag) = std::env::var_os("EDITKIN_STANDIN_FAIL_ONCE") {
            if std::path::Path::new(&flag).exists() {
                let _ = std::fs::remove_file(&flag);
                eprintln!("MCP server editkin already exists in user config");
                std::process::exit(1);
            }
        }
    }
}
"#;

    fn system_root() -> PathBuf {
        PathBuf::from(env::var_os("SystemRoot").expect("SystemRoot"))
    }

    fn rustc() -> PathBuf {
        if let Some(rustc) = env::var_os("RUSTC") {
            return PathBuf::from(rustc);
        }
        for cargo in [env::var_os("CARGO").map(PathBuf::from), option_env!("CARGO").map(PathBuf::from)]
            .into_iter()
            .flatten()
        {
            let sibling = cargo.with_file_name("rustc.exe");
            if sibling.is_file() {
                return sibling;
            }
        }
        PathBuf::from("rustc")
    }

    /// Built inside the harness folder, so the harness's Drop removes it with everything else.
    fn build_recorder(directory: &Path) -> PathBuf {
        let source = directory.join("recorder.rs");
        fs::write(&source, RECORDER).unwrap();
        let output = directory.join("recorder.exe");
        let status = Command::new(rustc())
            .args(["--edition", "2021", "-C", "opt-level=0", "-C", "debuginfo=0", "-o"])
            .arg(&output)
            .arg(&source)
            .current_dir(directory)
            .status()
            .expect("rustc must be available to build the argv recorder");
        assert!(status.success(), "building the argv recorder failed");
        for leftover in ["recorder.pdb"] {
            let _ = fs::remove_file(directory.join(leftover));
        }
        output
    }

    pub enum Shell {
        Cmd,
        PowerShell(PathBuf),
    }

    pub fn shells() -> Vec<(&'static str, Shell)> {
        let mut shells = vec![
            ("cmd.exe /c", Shell::Cmd),
            (
                "powershell.exe 5.1 -Command",
                Shell::PowerShell(system_root().join(r"System32\WindowsPowerShell\v1.0\powershell.exe")),
            ),
        ];
        let pwsh = env::var_os("PATH")
            .map(|paths| env::split_paths(&paths).map(|dir| dir.join("pwsh.exe")).collect::<Vec<_>>())
            .unwrap_or_default()
            .into_iter()
            .chain([PathBuf::from(r"C:\Program Files\PowerShell\7\pwsh.exe")])
            .find(|path| path.is_file());
        match pwsh {
            Some(pwsh) => shells.push(("pwsh 7 -Command", Shell::PowerShell(pwsh))),
            None => eprintln!("pwsh not installed: PowerShell 7 not exercised"),
        }
        shells
    }

    fn encoded_command(text: &str) -> String {
        const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let bytes = text.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<_>>();
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let value = (u32::from(chunk[0]) << 16)
                | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
                | u32::from(*chunk.get(2).unwrap_or(&0));
            for index in 0..4 {
                if index <= chunk.len() {
                    out.push(TABLE[(value >> (18 - 6 * index) & 63) as usize] as char);
                } else {
                    out.push('=');
                }
            }
        }
        out
    }

    pub struct Harness {
        pub root: PathBuf,
        /// `claude.exe` and `codex.exe` stand-ins.
        pub exe_bin: PathBuf,
        /// npm-style `claude.cmd` / `codex.cmd` shims in front of them.
        pub cmd_bin: PathBuf,
        runs: AtomicUsize,
    }

    impl Harness {
        pub fn new(label: &str) -> Self {
            let root = scratch(label);
            let exe_bin = root.join("exe bin");
            let cmd_bin = root.join("cmd bin");
            fs::create_dir_all(&exe_bin).unwrap();
            fs::create_dir_all(&cmd_bin).unwrap();
            let recorder = build_recorder(&root);
            for name in ["claude", "codex", "node"] {
                fs::copy(&recorder, exe_bin.join(format!("{name}.exe"))).unwrap();
                fs::write(
                    cmd_bin.join(format!("{name}.cmd")),
                    format!(
                        "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\"%dp0%\\..\\exe bin\\{name}.exe\"   %*\r\n"
                    ),
                )
                .unwrap();
            }
            Self { root, exe_bin, cmd_bin, runs: AtomicUsize::new(0) }
        }

        /// Runs `text` as if pasted into `shell` with `bin` first on PATH; returns every recorded invocation.
        pub fn run(&self, shell: &Shell, bin: &Path, text: &str, fail_once: bool) -> (Vec<Vec<String>>, String) {
            let run = self.runs.fetch_add(1, Ordering::SeqCst);
            let record = self.root.join(format!("argv-{run}.jsonl"));
            let flag = self.root.join(format!("fail-once-{run}"));
            if fail_once {
                fs::write(&flag, b"x").unwrap();
            }
            let root = system_root();
            let path = format!(
                "{};{};{};{}",
                bin.display(),
                root.join("System32").display(),
                root.display(),
                root.join(r"System32\WindowsPowerShell\v1.0").display()
            );
            let mut command = match shell {
                Shell::Cmd => {
                    let mut command = Command::new(root.join(r"System32\cmd.exe"));
                    // /s /c "<text>": cmd removes exactly the outer quotes and runs the text as typed.
                    command.raw_arg(format!("/d /s /c \"{text}\""));
                    command
                }
                Shell::PowerShell(executable) => {
                    let mut command = Command::new(executable);
                    command.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
                    command.arg(encoded_command(text));
                    command
                }
            };
            command
                .env("PATH", path)
                .env("EDITKIN_ARGV_RECORD", &record)
                .env("EDITKIN_STANDIN_FAIL_ONCE", &flag)
                .current_dir(&self.root)
                .stdin(Stdio::null());
            let output = command.output().unwrap();
            let calls = fs::read_to_string(&record)
                .unwrap_or_default()
                .lines()
                .map(|line| serde_json::from_str::<Vec<String>>(line).unwrap())
                .collect();
            (
                calls,
                format!(
                    "{}\n{}",
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                ),
            )
        }
    }

    impl Drop for Harness {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn environment(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(key, value)| (key.to_string(), value.to_string())).collect()
    }

    const NODE: &str = r"C:\Program Files\Editkin\node.exe";
    // Assembled so the source never spells a Windows profile path.
    const STATE_ROOT: &str = concat!("C:", "\\", "Users", r"\測試 User\AppData\Roaming\studio.hao.editkin\agent-runtime-v3");
    const LAUNCHER: &str =
        concat!("C:", "\\", "Users", r"\測試 User\AppData\Roaming\studio.hao.editkin\agent-runtime-v3\launcher.mjs");
    const CACHE_ROOT: &str = concat!("C:", "\\", "Users", r"\測試 User\AppData\Local\studio.hao.editkin\media-cache");
    const CODEX_JS: &str =
        concat!("C:", "\\", "Users", r"\測試 User\AppData\Roaming\npm\node_modules\@openai\codex\bin\codex.js");

    #[test]
    fn direct_fallback_command_arrives_intact_through_cmd_powershell_and_pwsh() {
        let harness = Harness::new("direct");
        let env = environment(&[
            ("ELECTRON_RUN_AS_NODE", "1"),
            ("EDITKIN_AGENT_STATE_ROOT", STATE_ROOT),
            ("EDITKIN_WORKSPACE", r"D:\影片 Projects\Ana's 旅行 (二) & 作品"),
            ("EDITKIN_PLUGIN_ROOTS", r"C:\Program Files\Editkin\plugins;D:\外掛 x"),
            ("EDITKIN_CACHE_ROOT", r"C:\cache\媒體=快取;x,y"),
            ("HAO_FFMPEG_PATH", r"C:\Program Files\Editkin\runtime\ffmpeg.exe"),
        ]);
        for target in ["claude", "codex"] {
            let args = crate::agent_setup::agent_add_arguments(target, NODE, LAUNCHER, &env);
            let command = render_direct_command(target, &args).expect("these values have a universal spelling");
            assert!(!command.contains('\'') || command.contains("Ana's"), "no PowerShell-only quoting: {command}");
            for (label, shell) in shells() {
                for (kind, bin) in [("exe", &harness.exe_bin), ("npm .cmd shim", &harness.cmd_bin)] {
                    let (calls, output) = harness.run(&shell, bin, &command, false);
                    assert_eq!(calls, [args.clone()], "{target} via {label} ({kind}):\n{command}\n{output}");
                }
            }
        }
    }

    #[test]
    fn script_fallback_arrives_intact_and_replaces_an_existing_entry() {
        let harness = Harness::new("script");
        let env = environment(&[
            ("ELECTRON_RUN_AS_NODE", "1"),
            ("EDITKIN_WORKSPACE", r"D:\100% 完成 $HOME `tick` !bang ^caret (x) & y\"),
            ("EDITKIN_PLUGIN_ROOTS", r"E:\a&b(c);F:\x%PATH%y"),
            ("EDITKIN_CACHE_ROOT", CACHE_ROOT),
        ]);
        let script_dir = harness.root.join("state 狀態");
        fs::create_dir_all(&script_dir).unwrap();
        for target in ["claude", "codex"] {
            let args = crate::agent_setup::agent_add_arguments(target, NODE, LAUNCHER, &env);
            assert_eq!(render_direct_command(target, &args), None, "these values need the script");
            let program = if target == "claude" {
                vec![harness.exe_bin.join("claude.exe").to_string_lossy().to_string()]
            } else {
                vec![
                    harness.exe_bin.join("node.exe").to_string_lossy().to_string(),
                    CODEX_JS.to_string(),
                ]
            };
            let script = fallback_script(target, &program, &args).unwrap();
            assert!(script.starts_with("@echo off\r\n") && !script.starts_with('\u{feff}'));
            let path = script_dir.join(fallback_script_name(target));
            fs::write(&path, script.as_bytes()).unwrap();
            let invocation = script_invocation(&path).unwrap();
            let prefix = program[1..].to_vec();
            let with_prefix = |args: Vec<String>| prefix.iter().cloned().chain(args).collect::<Vec<_>>();
            for (label, shell) in shells() {
                let fail_once = target == "claude";
                let (calls, output) = harness.run(&shell, &harness.cmd_bin, &invocation, fail_once);
                let expected = if target == "claude" {
                    vec![
                        with_prefix(args.clone()),
                        with_prefix(strings_of(&["mcp", "remove", "editkin", "-s", "user"])),
                        with_prefix(args.clone()),
                        with_prefix(strings_of(&["mcp", "get", "editkin"])),
                    ]
                } else {
                    vec![with_prefix(args.clone()), with_prefix(strings_of(&["mcp", "get", "editkin"]))]
                };
                assert_eq!(calls, expected, "{target} script via {label}:\n{invocation}\n{output}");
            }
        }
    }

    /// Why the format changed (#102): the 0.15.0 fallback, PowerShell-quoted JSON, reaches Claude without its
    /// inner quotes from Windows PowerShell 5.1 ("Invalid configuration: : Invalid input").
    #[test]
    fn legacy_add_json_fallback_is_broken_by_windows_powershell() {
        let harness = Harness::new("legacy");
        let config = json!({ "type": "stdio", "command": NODE, "args": [LAUNCHER], "env": { "EDITKIN_WORKSPACE": r"D:\影片 Projects" } }).to_string();
        let legacy = format!("claude mcp add-json --scope user editkin '{}'", config.replace('\'', "''"));
        let windows_powershell = Shell::PowerShell(system_root().join(r"System32\WindowsPowerShell\v1.0\powershell.exe"));
        let (calls, _) = harness.run(&windows_powershell, &harness.exe_bin, &legacy, false);
        let received = calls[0].last().unwrap();
        assert_ne!(received, &config);
        assert!(serde_json::from_str::<Value>(received).is_err(), "{received}");
    }
}

// ---- the real Claude Code CLI, isolated ------------------------------------------------------------------------

/// Minimal stdio MCP server so Claude's own `mcp get` health check reports ✓ Connected.
#[cfg(windows)]
const FAKE_MCP_SERVER: &str = r#"
import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "editkin", version: "test" } } });
  } else if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
  } else if (message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  }
});
"#;

/// Runs against the real `claude` with CLAUDE_CONFIG_DIR, USERPROFILE, HOME, APPDATA and LOCALAPPDATA all inside
/// EDITKIN_TEST_ISOLATED_ROOT. Opt-in: `cargo test -- --ignored real_claude` with EDITKIN_TEST_CLAUDE_EXE,
/// EDITKIN_TEST_NODE and EDITKIN_TEST_ISOLATED_ROOT set.
#[test]
#[ignore]
#[cfg(windows)]
fn real_claude_cli_reconnect_is_idempotent_in_an_isolated_config_dir() {
    let claude = PathBuf::from(env::var_os("EDITKIN_TEST_CLAUDE_EXE").expect("EDITKIN_TEST_CLAUDE_EXE"));
    let node = PathBuf::from(env::var_os("EDITKIN_TEST_NODE").expect("EDITKIN_TEST_NODE"));
    let isolated = PathBuf::from(env::var_os("EDITKIN_TEST_ISOLATED_ROOT").expect("EDITKIN_TEST_ISOLATED_ROOT"));
    let real_home = PathBuf::from(env::var_os("USERPROFILE").expect("USERPROFILE"));
    assert!(isolated.is_absolute() && !isolated.starts_with(&real_home), "the isolated root must be outside the real profile");
    let root = isolated.join(format!("run-{}", utc_stamp(SystemTime::now())));
    let config = root.join("claude-config");
    let home = root.join("home");
    let runtime = root.join("fake runtime 測試");
    let state = root.join("agent-runtime-v3");
    let workspace = root.join("影片 作品 & 一");
    let moved = root.join("影片 作品 & 二");
    for directory in [&config, &home.join(r"AppData\Roaming"), &home.join(r"AppData\Local"), &runtime, &state, &workspace, &moved] {
        fs::create_dir_all(directory).unwrap();
    }
    let launcher = runtime.join("launcher.mjs");
    fs::write(&launcher, FAKE_MCP_SERVER).unwrap();
    let environment = |workspace: &Path| -> Vec<(String, String)> {
        vec![
            ("ELECTRON_RUN_AS_NODE".into(), "1".into()),
            ("EDITKIN_AGENT_STATE_ROOT".into(), state.to_string_lossy().to_string()),
            ("EDITKIN_WORKSPACE".into(), workspace.to_string_lossy().to_string()),
        ]
    };
    let isolate = |command: &mut Command| {
        command
            .env("CLAUDE_CONFIG_DIR", &config)
            .env("USERPROFILE", &home)
            .env("HOME", &home)
            .env("APPDATA", home.join(r"AppData\Roaming"))
            .env("LOCALAPPDATA", home.join(r"AppData\Local"))
            .env("DISABLE_AUTOUPDATER", "1")
            .current_dir(&root)
            .stdin(Stdio::null());
    };
    let run = |args: &[String]| -> Result<CliRun, String> {
        let mut command = Command::new(&claude);
        command.args(args);
        isolate(&mut command);
        let output = command.output().map_err(|error| error.to_string())?;
        Ok(CliRun { success: output.status.success(), stdout: output.stdout, stderr: output.stderr })
    };
    // Another server the user already has: it must survive every reconnect untouched.
    let other = run(&strings_of(&["mcp", "add", "--scope", "user", "other-server", "-e", "KEEP=yes", "--", "C:\\other.exe", "x"])).unwrap();
    assert!(other.success, "{}", cli_text(&other));
    let read_servers = || -> Value {
        serde_json::from_slice::<Value>(&fs::read(config.join(".claude.json")).unwrap()).unwrap()["mcpServers"].clone()
    };
    let other_before = read_servers()["other-server"].clone();
    let attempt = |workspace: &Path| {
        let expected = ExpectedConfig {
            executable: node.clone(),
            launcher: launcher.clone(),
            environment: environment(workspace).into_iter().collect(),
        };
        let args = crate::agent_setup::agent_add_arguments(
            "claude",
            node.to_str().unwrap(),
            launcher.to_str().unwrap(),
            &environment(workspace),
        );
        let mut log = ConnectLog::open(Some(root.join("logs")), "claude", None);
        let mut runner = |args: &[String], _: Duration| run(args);
        let result = configure_agent_mcp("claude", &mut runner, &expected, &args, &mut log);
        let log_text = fs::read_to_string(log.path().unwrap()).unwrap();
        (result, log_text)
    };
    let (first, log) = attempt(&workspace);
    assert_eq!(first.as_ref().map(|success| success.change), Ok(ConfigChange::Added), "{log}");
    let (second, log) = attempt(&workspace);
    assert_eq!(second.as_ref().map(|success| success.change), Ok(ConfigChange::Unchanged), "{log}");
    let (third, log) = attempt(&moved);
    assert_eq!(third.as_ref().map(|success| success.change), Ok(ConfigChange::Replaced), "{log}");
    let servers = read_servers();
    assert_eq!(servers["other-server"], other_before);
    assert_eq!(servers["editkin"]["env"]["EDITKIN_WORKSPACE"], json!(moved.to_string_lossy()));
    assert_eq!(servers["editkin"]["command"], json!(node.to_string_lossy()));
    assert_eq!(servers["editkin"]["args"], json!([launcher.to_string_lossy()]));
    eprintln!("isolated real-claude run kept at {}", root.display());
}
