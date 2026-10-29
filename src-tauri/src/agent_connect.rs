//! 「連接 Claude Code／Codex」: one setup attempt from detection to Claude's/Codex's own health check.
//!
//! Every attempt reports where it stopped as a structured `failure { step, code, detail, logPath }` and writes one
//! log under `<app data>/logs` (the newest ten are kept). Reconnecting is idempotent: an `editkin` entry that already
//! matches is left alone, a different one is replaced (only that entry; the user's other servers are untouched).
//! When the agent CLI will not take the configuration, the fallback put on the clipboard is a command that pastes
//! unchanged into cmd.exe, Windows PowerShell 5.1 and PowerShell 7 (no JSON, no PowerShell-only quoting), or, when
//! the paths make that impossible, a short `cmd /d /c call "...cmd"` that runs a generated script.
//! Connecting never requires the Video Autopilot Skill; its state is reported as `vaSkill` for the UI to offer.

use crate::agent_setup::{
    activate_product_agent_generation, rollback_product_agent_generation, AgentWorkspace,
    ProductAgentGenerationPaths,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    io::Write,
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};

/// Upper bound of `failure.detail` in bytes (UTF-8), after the user profile path is replaced.
pub const DETAIL_LIMIT_BYTES: usize = 2048;
/// How many `agent-connect-*.log` files are kept.
pub const LOG_KEEP: usize = 10;
const LOG_OUTPUT_TAIL_BYTES: usize = 4096;
const LOG_PREFIX: &str = "agent-connect-";
const SERVER_NAME: &str = "editkin";
/// cmd.exe refuses longer interactive lines (8191); stay clear of it.
const MAX_DIRECT_COMMAND_CHARS: usize = 7_800;
const CLI_TIMEOUT: Duration = Duration::from_secs(30);
/// `claude mcp get` starts the configured server for its health check.
const CLI_HEALTH_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SetupStep {
    Detect,
    PrepareRuntime,
    Probe,
    WriteConfig,
    HealthCheck,
}

impl SetupStep {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Detect => "detect",
            Self::PrepareRuntime => "prepare_runtime",
            Self::Probe => "probe",
            Self::WriteConfig => "write_config",
            Self::HealthCheck => "health_check",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum FailureCode {
    AgentAppNotFound,
    RuntimeFilesMissing,
    RuntimeProbeFailed,
    WorkspaceNotWritable,
    /// The folder token is unknown, already used, expired or from another window: choose the folder again.
    WorkspaceChoiceExpired,
    /// The folder is a drive root, the profile root, Windows, Program Files, ProgramData, an AppData root, or a
    /// network/device path.
    WorkspaceUnsafe,
    ConfigWriteRefused,
    ConfigAlreadyExistsDifferent,
    HealthCheckFailed,
    Unknown,
}

/// The `failure` member of the setup result (desktop/mediaTypes.ts AgentSetupFailure).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupFailure {
    pub step: SetupStep,
    pub code: FailureCode,
    /// The underlying message: at most DETAIL_LIMIT_BYTES, the user profile path shown as %USERPROFILE%.
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_path: Option<String>,
}

impl SetupFailure {
    pub fn new(
        step: SetupStep,
        code: FailureCode,
        raw_detail: &str,
        profile: Option<&Path>,
        log_path: Option<&Path>,
    ) -> Self {
        Self {
            step,
            code,
            detail: bounded_detail(&redact_user_profile(raw_detail, profile)),
            log_path: log_path.map(|path| path.to_string_lossy().to_string()),
        }
    }
}

// ---- detail hygiene ----------------------------------------------------------------------------------------------

/// What the user's home folder is shown as in details and logs: the spelling each system's own shell understands.
pub const PROFILE_PLACEHOLDER: &str = if cfg!(windows) { "%USERPROFILE%" } else { "~" };

/// Replaces the user profile path (any letter case; `\`, `/` and JSON-escaped `\\` spellings) with
/// PROFILE_PLACEHOLDER (`%USERPROFILE%` on Windows, `~` on macOS).
pub fn redact_user_profile(text: &str, profile: Option<&Path>) -> String {
    let Some(profile) = profile
        .and_then(Path::to_str)
        .map(|value| value.trim_end_matches(['\\', '/']))
        .filter(|value| value.len() >= 3)
    else {
        return text.to_string();
    };
    let mut variants = vec![
        profile.replace('\\', "\\\\"),
        profile.to_string(),
        profile.replace('\\', "/"),
    ];
    variants.sort_by_key(|variant| std::cmp::Reverse(variant.len()));
    variants.dedup();
    variants
        .iter()
        .fold(text.to_string(), |text, variant| {
            replace_path_ascii_case_insensitive(&text, variant, PROFILE_PLACEHOLDER)
        })
}

fn replace_path_ascii_case_insensitive(text: &str, needle: &str, replacement: &str) -> String {
    // ASCII lowercasing keeps every byte offset, so positions found in `haystack` are valid in `text`.
    let haystack = text.to_ascii_lowercase();
    let needle = needle.to_ascii_lowercase();
    let mut output = String::with_capacity(text.len());
    let (mut copied, mut search) = (0, 0);
    while let Some(found) = haystack[search..].find(&needle) {
        let start = search + found;
        let end = start + needle.len();
        let boundary = text[end..]
            .chars()
            .next()
            .is_none_or(|next| !(next.is_alphanumeric() || matches!(next, '_' | '-' | '.')));
        if boundary {
            output.push_str(&text[copied..start]);
            output.push_str(replacement);
            copied = end;
        }
        search = end;
    }
    output.push_str(&text[copied..]);
    output
}

fn floor_boundary(text: &str, mut index: usize) -> usize {
    index = index.min(text.len());
    while !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

fn ceil_boundary(text: &str, mut index: usize) -> usize {
    index = index.min(text.len());
    while !text.is_char_boundary(index) {
        index += 1;
    }
    index
}

/// Keeps the start and (mostly) the end of a long message within DETAIL_LIMIT_BYTES.
pub fn bounded_detail(text: &str) -> String {
    let text = text.trim();
    if text.len() <= DETAIL_LIMIT_BYTES {
        return text.to_string();
    }
    const MARKER: &str = "\n…（中間省略）…\n";
    let budget = DETAIL_LIMIT_BYTES - MARKER.len();
    let head = floor_boundary(text, budget * 2 / 5);
    let tail = ceil_boundary(text, text.len() - (budget - head));
    format!("{}{MARKER}{}", &text[..head], &text[tail..])
}

fn tail_bytes(bytes: &[u8], limit: usize) -> String {
    let text = String::from_utf8_lossy(bytes);
    let text = text.trim();
    if text.len() <= limit {
        return text.to_string();
    }
    format!("…{}", &text[ceil_boundary(text, text.len() - limit)..])
}

// ---- log ---------------------------------------------------------------------------------------------------------

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    // Howard Hinnant's days-to-civil algorithm (proleptic Gregorian, UTC).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_index + 2) / 5 + 1) as u32;
    let month = if month_index < 10 { month_index + 3 } else { month_index - 9 } as u32;
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// `YYYYMMDD-HHMMSS-mmmZ` in UTC; lexical order is chronological order.
pub fn utc_stamp(now: SystemTime) -> String {
    let since = now.duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = since.as_secs() as i64;
    let (year, month, day) = civil_from_days(seconds.div_euclid(86_400));
    let of_day = seconds.rem_euclid(86_400);
    format!(
        "{year:04}{month:02}{day:02}-{:02}{:02}{:02}-{:03}Z",
        of_day / 3_600,
        of_day % 3_600 / 60,
        of_day % 60,
        since.subsec_millis()
    )
}

/// Removes all but the newest `keep` regular `agent-connect-*.log` files. Nothing else in the folder is touched.
pub fn prune_connect_logs(directory: &Path, keep: usize) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    let mut logs = entries
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            name.starts_with(LOG_PREFIX)
                && name.ends_with(".log")
                && fs::symlink_metadata(entry.path())
                    .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
        })
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    logs.sort();
    let excess = logs.len().saturating_sub(keep);
    for path in logs.into_iter().take(excess) {
        let _ = fs::remove_file(path);
    }
}

/// Receives `{ step, state }` progress events (the connect command forwards them to a Tauri Channel).
pub type ProgressSink = Box<dyn FnMut(Value) + Send>;

/// The three steps the connection screen shows. Detection happens before a folder is chosen and is not one of them;
/// the runtime probe is part of preparing the runtime.
const PROGRESS_STEPS: [&str; 3] = ["prepare_runtime", "write_config", "health_check"];

fn progress_name(step: SetupStep) -> Option<&'static str> {
    match step {
        SetupStep::Detect => None,
        SetupStep::PrepareRuntime | SetupStep::Probe => Some("prepare_runtime"),
        SetupStep::WriteConfig => Some("write_config"),
        SetupStep::HealthCheck => Some("health_check"),
    }
}

/// One file per attempt. Logging is best effort: a log that cannot be written never fails the setup.
pub struct ConnectLog {
    file: Option<fs::File>,
    path: Option<PathBuf>,
    profile: Option<PathBuf>,
    started: Instant,
    progress: Option<ProgressSink>,
    progress_step: Option<&'static str>,
    progress_done: Vec<&'static str>,
}

impl ConnectLog {
    pub fn open(directory: Option<PathBuf>, target: &str, profile: Option<PathBuf>) -> Self {
        let stamp = utc_stamp(SystemTime::now());
        let mut opened = None;
        if let Some(directory) = directory.filter(|directory| fs::create_dir_all(directory).is_ok()) {
            for attempt in 0..5 {
                let name = if attempt == 0 {
                    format!("{LOG_PREFIX}{stamp}.log")
                } else {
                    format!("{LOG_PREFIX}{stamp}-{attempt}.log")
                };
                let path = directory.join(name);
                match fs::OpenOptions::new().write(true).create_new(true).open(&path) {
                    Ok(file) => {
                        opened = Some((file, path));
                        break;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(_) => break,
                }
            }
            prune_connect_logs(&directory, LOG_KEEP);
        }
        let (file, path) = opened.map_or((None, None), |(file, path)| (Some(file), Some(path)));
        let mut log = Self {
            file,
            path,
            profile,
            started: Instant::now(),
            progress: None,
            progress_step: None,
            progress_done: Vec::new(),
        };
        log.raw(&format!(
            "Editkin agent connect log\nEditkin {}\ntarget: {target}\nstarted (UTC): {stamp}\nplatform: {}\n\n",
            env!("CARGO_PKG_VERSION"),
            env::consts::OS
        ));
        log
    }

    fn raw(&mut self, text: &str) {
        let text = redact_user_profile(text, self.profile.as_deref());
        if let Some(file) = self.file.as_mut() {
            if file.write_all(text.as_bytes()).and_then(|()| file.flush()).is_err() {
                self.file = None;
            }
        }
    }

    pub fn line(&mut self, text: &str) {
        let elapsed = self.started.elapsed().as_millis();
        self.raw(&format!("[+{elapsed:>6} ms] {text}\n"));
    }

    pub fn step(&mut self, step: SetupStep) {
        self.line(&format!("== step: {} ==", step.as_str()));
        if let Some(name) = progress_name(step).filter(|name| self.progress_step != Some(*name)) {
            if let Some(previous) = self.progress_step.take() {
                self.emit_progress(previous, "done");
            }
            self.emit_progress(name, "running");
            self.progress_step = Some(name);
        }
    }

    pub fn set_progress(&mut self, sink: ProgressSink) {
        self.progress = Some(sink);
    }

    /// Ends the progress feed: on success every step not yet reported done is (an unchanged entry skips the write
    /// and its health check was the first `mcp get`); on failure the running step is reported failed.
    pub fn finish_progress(&mut self, succeeded: bool) {
        let current = self.progress_step.take();
        if succeeded {
            for name in PROGRESS_STEPS {
                if !self.progress_done.contains(&name) {
                    self.emit_progress(name, "done");
                }
            }
        } else if let Some(current) = current {
            self.emit_progress(current, "failed");
        }
    }

    fn emit_progress(&mut self, step: &'static str, state: &'static str) {
        if state == "done" {
            self.progress_done.push(step);
        }
        self.line(&format!("progress: {step} {state}"));
        if let Some(sink) = self.progress.as_mut() {
            sink(json!({ "step": step, "state": state }));
        }
    }

    pub fn command(&mut self, program: &str, args: &[String]) {
        self.line(&format!("$ {}", display_command(program, args)));
    }

    pub fn output(&mut self, run: &Result<CliRun, String>) {
        match run {
            Ok(run) => {
                let stdout = tail_bytes(&run.stdout, LOG_OUTPUT_TAIL_BYTES);
                let stderr = tail_bytes(&run.stderr, LOG_OUTPUT_TAIL_BYTES);
                self.line(&format!(
                    "  exit: {}\n  stdout (tail): {}\n  stderr (tail): {}",
                    if run.success { "0" } else { "non-zero" },
                    if stdout.is_empty() { "(empty)" } else { &stdout },
                    if stderr.is_empty() { "(empty)" } else { &stderr }
                ));
            }
            Err(error) => self.line(&format!("  did not complete: {error}")),
        }
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// For an attempt that changed nothing and has nothing worth keeping (a canceled folder picker).
    pub fn discard(mut self) {
        self.file = None;
        if let Some(path) = self.path.take() {
            let _ = fs::remove_file(path);
        }
    }
}

fn display_command(program: &str, args: &[String]) -> String {
    std::iter::once(program)
        .chain(args.iter().map(String::as_str))
        .map(|part| {
            if part.is_empty() || part.contains([' ', '\t']) {
                format!("\"{part}\"")
            } else {
                part.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

// ---- fallback commands -------------------------------------------------------------------------------------------

/// PowerShell treats these as double quotes inside "..." strings.
const POWERSHELL_DOUBLE_QUOTES: [char; 3] = ['\u{201C}', '\u{201D}', '\u{201E}'];

fn bare_token_char(character: char) -> bool {
    character.is_ascii_alphanumeric()
        || matches!(character, '_' | '-' | '.' | ':' | '/' | '\\' | '=' | '+')
        || (!character.is_ascii() && character.is_alphanumeric())
}

/// One argument written so that cmd.exe, Windows PowerShell 5.1 and PowerShell 7 all hand exactly `arg` to the
/// program (claude.exe directly, or through npm's claude.cmd / claude.ps1 shims). None when no such spelling exists:
/// `"` `%` `$` `` ` `` and PowerShell's curly quotes change meaning in at least one shell, a quoted value ending in `\`
/// is split differently by PowerShell 5.1 and 7, and without whitespace PowerShell drops the quotes so a cmd shim
/// would see `& | < > ( ) ^ !` bare.
pub fn universal_shell_token(arg: &str) -> Option<String> {
    if arg.is_empty() || arg.chars().any(char::is_control) {
        return None;
    }
    if arg.chars().all(bare_token_char) {
        return Some(arg.to_string());
    }
    if arg
        .chars()
        .any(|character| matches!(character, '"' | '%' | '$' | '`') || POWERSHELL_DOUBLE_QUOTES.contains(&character))
        || arg.ends_with('\\')
    {
        return None;
    }
    let has_whitespace = arg.contains([' ', '\t']);
    if !has_whitespace
        && arg
            .chars()
            .any(|character| matches!(character, '&' | '|' | '<' | '>' | '(' | ')' | '^' | '!'))
    {
        return None;
    }
    Some(format!("\"{arg}\""))
}

/// `claude mcp add ...` / `codex mcp add ...` as one pasteable line, or None when any argument has no universal spelling.
pub fn render_direct_command(program: &str, args: &[String]) -> Option<String> {
    let mut parts = vec![program.to_string()];
    for arg in args {
        parts.push(universal_shell_token(arg)?);
    }
    Some(parts.join(" ")).filter(|line| line.chars().count() <= MAX_DIRECT_COMMAND_CHARS)
}

/// A quoted argument inside a .cmd file: `%` doubled (batch expansion), trailing backslashes doubled (so the program's
/// CommandLineToArgvW-style parser does not read `\"` as a quote). `"` cannot occur in a Windows path.
pub fn batch_quote(arg: &str) -> Option<String> {
    if arg.contains('"') || arg.chars().any(char::is_control) {
        return None;
    }
    let escaped = arg.replace('%', "%%");
    let trailing = escaped.len() - escaped.trim_end_matches('\\').len();
    Some(format!("\"{escaped}{}\"", "\\".repeat(trailing)))
}

/// `\\?\C:\x` → `C:\x`, `\\?\UNC\host\share` → `\\host\share`; anything else unchanged.
pub fn plain_path_text(text: &str) -> String {
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{unc}");
    }
    match text.strip_prefix(r"\\?\") {
        Some(drive) if drive.as_bytes().get(1) == Some(&b':') => drive.to_string(),
        _ => text.to_string(),
    }
}

pub fn fallback_script_name(target: &str) -> &'static str {
    if target == "codex" {
        "Connect Editkin to Codex.cmd"
    } else {
        "Connect Editkin to Claude Code.cmd"
    }
}

/// The generated script: add; for Claude, on failure remove only `editkin` (user scope) and add again; then show
/// the agent's own `mcp get`. UTF-8 with `chcp 65001` (restored afterwards), CRLF. Pauses only when double-clicked.
pub fn fallback_script(target: &str, program: &[String], add_args: &[String]) -> Option<String> {
    let program = program
        .iter()
        .map(|part| batch_quote(part))
        .collect::<Option<Vec<_>>>()?
        .join(" ");
    let add = add_args
        .iter()
        .map(|arg| batch_quote(arg))
        .collect::<Option<Vec<_>>>()?
        .join(" ");
    let agent = if target == "codex" { "Codex" } else { "Claude Code" };
    let verify = "mcp get editkin";
    let mut lines = vec![
        "@echo off".to_string(),
        "setlocal DisableDelayedExpansion".to_string(),
        "set \"EDITKIN_PREVIOUS_CP=\"".to_string(),
        "for /f \"tokens=2 delims=:.\" %%P in ('chcp') do set \"EDITKIN_PREVIOUS_CP=%%P\"".to_string(),
        "chcp 65001 >nul".to_string(),
        format!("echo Editkin: connecting {agent} to Editkin (only the \"editkin\" entry is changed)."),
        format!("{program} {add}"),
        "if not errorlevel 1 goto editkin_verify".to_string(),
    ];
    if target == "claude" {
        lines.extend([
            "echo Editkin: replacing the existing \"editkin\" entry...".to_string(),
            format!("{program} mcp remove editkin -s user"),
            format!("{program} {add}"),
            "if errorlevel 1 goto editkin_failed".to_string(),
        ]);
    } else {
        lines.push("goto editkin_failed".to_string());
    }
    lines.extend([
        ":editkin_verify".to_string(),
        format!("{program} {verify}"),
        format!("echo Editkin: done. Start a new {agent} session to use Editkin."),
        "set \"EDITKIN_RESULT=0\"".to_string(),
        "goto editkin_end".to_string(),
        ":editkin_failed".to_string(),
        format!("echo Editkin: {agent} did not accept the setup. The messages above say why."),
        "set \"EDITKIN_RESULT=1\"".to_string(),
        ":editkin_end".to_string(),
        "if defined EDITKIN_PREVIOUS_CP chcp %EDITKIN_PREVIOUS_CP% >nul 2>&1".to_string(),
        "if /i not \"%~1\"==\"--no-pause\" pause".to_string(),
        "endlocal & exit /b %EDITKIN_RESULT%".to_string(),
    ]);
    Some(lines.join("\r\n") + "\r\n")
}

/// `cmd /d /c call "<script>" --no-pause`: identical meaning in cmd.exe, PowerShell 5.1 and 7 because the script name
/// contains a space (PowerShell keeps the quotes) and the path has none of `" % ^ $ `` and curly quotes.
pub fn script_invocation(script: &Path) -> Option<String> {
    let path = script.to_str()?;
    let unsafe_char = |character: char| {
        matches!(character, '"' | '%' | '^' | '$' | '`')
            || POWERSHELL_DOUBLE_QUOTES.contains(&character)
            || character.is_control()
    };
    (path.contains(' ') && !path.chars().any(unsafe_char))
        .then(|| format!("cmd /d /c call \"{path}\" --no-pause"))
}

// ---- reading `claude mcp get` ------------------------------------------------------------------------------------

/// `claude mcp get <name>` as printed by Claude Code (2.1.1xx quotes the name in the remove hint, 2.1.3xx does not).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ClaudeMcpGet {
    pub fields: BTreeMap<String, String>,
// ---- macOS (POSIX shells) ----------------------------------------------------------------------------------------

fn posix_bare_char(character: char) -> bool {
    character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.' | '/' | ':' | ',' | '+' | '@' | '=')
}

/// One argument as zsh and bash (macOS Terminal's shells) read it back exactly: left bare only when it holds nothing
/// but `[A-Za-z0-9_-./:,+@=]` and does not start with `=` (zsh expands a leading `=word`); otherwise inside single
/// quotes, where no character is special except `'`, written `'\''`. None only for control characters (a pasted line
/// break would run the line early).
pub fn posix_shell_token(arg: &str) -> Option<String> {
    if arg.chars().any(char::is_control) {
        return None;
    }
    if !arg.is_empty() && arg.chars().all(posix_bare_char) && !arg.starts_with('=') {
        return Some(arg.to_string());
    }
    Some(format!("'{}'", arg.replace('\'', r"'\''")))
}

/// `claude mcp add …` / `codex mcp add …` as one line for zsh or bash, with no JSON.
pub fn render_posix_command(program: &str, args: &[String]) -> Option<String> {
    let mut parts = vec![posix_shell_token(program)?];
    for arg in args {
        parts.push(posix_shell_token(arg)?);
    }
    Some(parts.join(" ")).filter(|line| line.chars().count() <= MAX_POSIX_COMMAND_CHARS)
}

/// A pasted command line well under every shell's limit.
const MAX_POSIX_COMMAND_CHARS: usize = 64 * 1024;

/// The macOS script: bash, LF, run by Terminal when double-clicked in Finder (`.command`). The same steps as the
/// Windows script: add; for Claude, on failure remove only `editkin` (user scope) and add again; then the agent's own
/// `mcp get`. Waits for Return only when double-clicked (no `--no-pause`).
pub fn posix_fallback_script(target: &str, program: &[String], add_args: &[String]) -> Option<String> {
    let program = program
        .iter()
        .map(|part| posix_shell_token(part))
        .collect::<Option<Vec<_>>>()?
        .join(" ");
    let add = add_args
        .iter()
        .map(|arg| posix_shell_token(arg))
        .collect::<Option<Vec<_>>>()?
        .join(" ");
    let agent = if target == "codex" { "Codex" } else { "Claude Code" };
    let mut lines = vec![
        "#!/bin/bash".to_string(),
        "# Generated by Editkin. Only the \"editkin\" MCP entry is changed.".to_string(),
        "status=0".to_string(),
        format!("echo 'Editkin: connecting {agent} to Editkin (only the \"editkin\" entry is changed).'"),
        format!("if ! {program} {add}; then"),
    ];
    if target == "claude" {
        lines.extend([
            "  echo 'Editkin: replacing the existing \"editkin\" entry...'".to_string(),
            format!("  {program} mcp remove editkin -s user"),
            format!("  {program} {add} || status=1"),
        ]);
    } else {
        lines.push("  status=1".to_string());
    }
    lines.extend([
        "fi".to_string(),
        "if [ \"$status\" -eq 0 ]; then".to_string(),
        format!("  {program} mcp get editkin"),
        format!("  echo 'Editkin: done. Start a new {agent} session to use Editkin.'"),
        "else".to_string(),
        format!("  echo 'Editkin: {agent} did not accept the setup. The messages above say why.'"),
        "fi".to_string(),
        "if [ \"${1:-}\" != \"--no-pause\" ]; then".to_string(),
        "  read -r -p 'Press Return to close this window. ' _ || true".to_string(),
        "fi".to_string(),
        "exit \"$status\"".to_string(),
    ]);
    Some(lines.join("\n") + "\n")
}

/// The shell a pasted fallback is written for: the system Editkin runs on. Both stay compiled (and unit-tested) on
/// every system; a build only constructs its own.
#[allow(dead_code)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FallbackShell {
    /// cmd.exe, Windows PowerShell 5.1 and PowerShell 7.
    Windows,
    /// zsh and bash (macOS Terminal).
    Posix,
}

impl FallbackShell {
    pub const CURRENT: Self = if cfg!(windows) { Self::Windows } else { Self::Posix };

    /// The result's `fallbackKind`, so the UI can say 「命令提示字元或 PowerShell」 or 「終端機」.
    pub fn kind(self) -> &'static str {
        match self {
            Self::Windows => "windows_shell",
            Self::Posix => "posix_shell",
        }
    }

    pub fn render_command(self, program: &str, args: &[String]) -> Option<String> {
        match self {
            Self::Windows => render_direct_command(program, args),
            Self::Posix => render_posix_command(program, args),
        }
    }

    pub fn script_name(self, target: &str) -> &'static str {
        match (self, target == "codex") {
            (Self::Windows, _) => fallback_script_name(target),
            (Self::Posix, true) => "Connect Editkin to Codex.command",
            (Self::Posix, false) => "Connect Editkin to Claude Code.command",
        }
    }

    pub fn script(self, target: &str, program: &[String], add_args: &[String]) -> Option<String> {
        match self {
            Self::Windows => fallback_script(target, program, add_args),
            Self::Posix => posix_fallback_script(target, program, add_args),
        }
    }

    /// The one line that runs the generated script when pasted.
    pub fn script_invocation(self, script: &Path) -> Option<String> {
        match self {
            Self::Windows => script_invocation(script),
            Self::Posix => posix_shell_token(script.to_str()?).map(|path| format!("{path} --no-pause")),
        }
    }
}

    pub environment: Option<BTreeMap<String, String>>,
    /// The server the remove hint names; it must be the one asked about.
    pub remove_name: Option<String>,
    pub remove_scope: Option<String>,
    /// Duplicate fields, malformed or unknown lines: never an exact match, still readable.
    pub irregular: bool,
}

fn unquote(token: &str) -> &str {
    token
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .or_else(|| token.strip_prefix('\'').and_then(|rest| rest.strip_suffix('\'')))
        .unwrap_or(token)
}

/// None only when the text is not a report about `server` (no header line).
pub fn parse_claude_mcp_get(text: &str, server: &str) -> Option<ClaudeMcpGet> {
    let text = text.replace("\r\n", "\n");
    let mut lines = text.lines().skip_while(|line| line.trim().is_empty());
    let header = lines.next()?.trim();
    if header != format!("{server}:") && header != format!("\"{server}\":") {
        return None;
    }
    let mut parsed = ClaudeMcpGet::default();
    let mut in_environment = false;
    for line in lines {
        let line = line.trim_end();
        if line.trim().is_empty() {
            in_environment = false;
            continue;
        }
        if let Some(hint) = line.trim_start().strip_prefix("To remove this server") {
            in_environment = false;
            let tokens = hint.split_whitespace().collect::<Vec<_>>();
            let named = tokens
                .iter()
                .position(|token| *token == "remove")
                .and_then(|index| tokens.get(index + 1))
                .map(|token| unquote(token));
            if named.is_some_and(|name| name != server) {
                parsed.irregular = true;
            }
            parsed.remove_name = named.map(str::to_string);
            parsed.remove_scope = tokens.iter().enumerate().find_map(|(index, token)| {
                if *token == "-s" || *token == "--scope" {
                    tokens.get(index + 1).map(|scope| unquote(scope).to_string())
                } else {
                    token.strip_prefix("--scope=").map(|scope| unquote(scope).to_string())
                }
            });
            continue;
        }
        if in_environment {
            if let Some(entry) = line.strip_prefix("    ") {
                match entry.split_once('=') {
                    Some((key, value)) if !key.is_empty() && !key.contains(char::is_whitespace) => {
                        let environment = parsed.environment.get_or_insert_with(BTreeMap::new);
                        if environment.insert(key.to_string(), value.to_string()).is_some() {
                            parsed.irregular = true;
                        }
                    }
                    _ => parsed.irregular = true,
                }
                continue;
            }
            in_environment = false;
        }
        if line == "  Environment:" {
            if parsed.environment.is_some() {
                parsed.irregular = true;
            }
            parsed.environment.get_or_insert_with(BTreeMap::new);
            in_environment = true;
            continue;
        }
        if let Some(field) = line.strip_prefix("  ").filter(|field| !field.starts_with(' ')) {
            if let Some((key, value)) = field.split_once(": ") {
                if parsed
                    .fields
                    .insert(key.to_string(), value.to_string())
                    .is_some()
                {
                    parsed.irregular = true;
                }
                continue;
            }
        }
        parsed.irregular = true;
    }
    Some(parsed)
}

/// What Editkin writes for one agent.
#[derive(Clone, Debug)]
pub struct ExpectedConfig {
    pub executable: PathBuf,
    pub launcher: PathBuf,
    pub environment: BTreeMap<String, String>,
}

impl ExpectedConfig {
    fn state_root(&self) -> PathBuf {
        PathBuf::from(
            self.environment
                .get("EDITKIN_AGENT_STATE_ROOT")
                .cloned()
                .unwrap_or_default(),
        )
    }

    fn environment_keys(&self) -> BTreeSet<String> {
        self.environment.keys().cloned().collect()
    }
}

/// Same existing file (after canonicalization) as `expected`.
pub fn exact_existing_path(value: &str, expected: &Path) -> bool {
    let candidate = Path::new(value);
    candidate.is_absolute()
        && fs::canonicalize(candidate)
            .ok()
            .zip(fs::canonicalize(expected).ok())
            .is_some_and(|(candidate, expected)| candidate == expected)
}

fn environment_matches(actual: &BTreeMap<String, String>, expected: &ExpectedConfig) -> bool {
    actual.len() == expected.environment.len()
        && expected.environment.iter().all(|(key, value)| {
            actual.get(key).is_some_and(|actual| {
                actual == value || (Path::new(value).is_absolute() && exact_existing_path(actual, Path::new(value)))
            })
        })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ClaudeEntryReport {
    pub connected: bool,
    pub status: String,
    /// Everything equals what Editkin would write: leave it alone.
    pub matches: bool,
    /// Connected and pointing at this Editkin (tolerant of report lines a newer Claude Code adds).
    pub usable: bool,
    pub differences: Vec<&'static str>,
}

pub fn assess_claude_entry(parsed: &ClaudeMcpGet, expected: &ExpectedConfig) -> ClaudeEntryReport {
    let status = parsed.fields.get("Status").cloned().unwrap_or_default();
    let connected = status.trim_start().starts_with('✓');
    let user_scope = parsed.fields.get("Scope").map_or_else(
        || parsed.remove_scope.as_deref() == Some("user"),
        |scope| scope.starts_with("User"),
    ) && parsed.remove_scope.as_deref().is_none_or(|scope| scope == "user")
        && parsed.remove_name.as_deref().is_none_or(|name| name == SERVER_NAME);
    let stdio = parsed.fields.get("Type").is_none_or(|kind| kind == "stdio");
    let command = parsed
        .fields
        .get("Command")
        .is_some_and(|value| exact_existing_path(value, &expected.executable));
    let args = parsed
        .fields
        .get("Args")
        .is_some_and(|value| exact_existing_path(value, &expected.launcher));
    let environment = parsed
        .environment
        .as_ref()
        .map(|environment| environment_matches(environment, expected));
    let mut differences = Vec::new();
    for (ok, label) in [
        (user_scope, "scope"),
        (stdio, "type"),
        (command, "command"),
        (args, "launcher"),
        (environment != Some(false), "environment"),
    ] {
        if !ok {
            differences.push(label);
        }
    }
    ClaudeEntryReport {
        matches: user_scope && stdio && command && args && environment == Some(true) && !parsed.irregular,
        usable: connected && user_scope && stdio && command && args && environment != Some(false),
        connected,
        status,
        differences,
    }
}

/// Codex `mcp get editkin --json`. `strict`: the exact closed-world shape Editkin writes (leave it alone);
/// otherwise tolerant of members a newer Codex adds, but never of forwarded host variables or a working directory.
pub fn codex_entry_matches(value: &Value, expected: &ExpectedConfig, strict: bool) -> bool {
    if strict
        && !codex_mcp_json_is_exact(
            value,
            &expected.executable,
            &expected.launcher,
            &expected.state_root(),
            &expected.environment_keys(),
        )
    {
        return false;
    }
    let transport = value.get("transport");
    value.get("name").and_then(Value::as_str) == Some(SERVER_NAME)
        && value.get("enabled").and_then(Value::as_bool) != Some(false)
        && transport.and_then(|t| t.get("type")).and_then(Value::as_str) == Some("stdio")
        && transport
            .and_then(|t| t.get("command"))
            .and_then(Value::as_str)
            .is_some_and(|command| exact_existing_path(command, &expected.executable))
        && transport
            .and_then(|t| t.get("args"))
            .and_then(Value::as_array)
            .is_some_and(|args| {
                args.len() == 1 && args[0].as_str().is_some_and(|arg| exact_existing_path(arg, &expected.launcher))
            })
        && transport
            .and_then(|t| t.get("env_vars"))
            .is_none_or(|vars| vars.as_array().is_some_and(Vec::is_empty))
        && transport.and_then(|t| t.get("cwd")).is_none_or(Value::is_null)
        && transport
            .and_then(|t| t.get("env"))
            .and_then(Value::as_object)
            .is_some_and(|environment| {
                let actual = environment
                    .iter()
                    .filter_map(|(key, value)| Some((key.clone(), value.as_str()?.to_string())))
                    .collect::<BTreeMap<_, _>>();
                actual.len() == environment.len() && environment_matches(&actual, expected)
            })
}

/// The exact closed-world JSON Codex reports for the entry Editkin writes.
pub fn codex_mcp_json_is_exact(
    value: &Value,
    executable: &Path,
    launcher: &Path,
    state_root: &Path,
    expected_environment_keys: &BTreeSet<String>,
) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    let object_keys = object.keys().map(String::as_str).collect::<BTreeSet<_>>();
    if object_keys
        != [
            "disabled_reason",
            "disabled_tools",
            "enabled",
            "enabled_tools",
            "name",
            "startup_timeout_sec",
            "tool_timeout_sec",
            "transport",
        ]
        .into_iter()
        .collect()
        || object.get("name").and_then(Value::as_str) != Some(SERVER_NAME)
        || object.get("enabled").and_then(Value::as_bool) != Some(true)
        || object.get("disabled_reason") != Some(&Value::Null)
        || object.get("enabled_tools") != Some(&Value::Null)
        || object.get("disabled_tools") != Some(&Value::Null)
        || object.get("startup_timeout_sec") != Some(&Value::Null)
        || object.get("tool_timeout_sec") != Some(&Value::Null)
    {
        return false;
    }
    let Some(transport) = object.get("transport").and_then(Value::as_object) else {
        return false;
    };
    let transport_keys = transport
        .keys()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    if transport_keys
        != ["args", "command", "cwd", "env", "env_vars", "type"]
            .into_iter()
            .collect()
        || transport.get("type").and_then(Value::as_str) != Some("stdio")
        || !transport
            .get("command")
            .and_then(Value::as_str)
            .is_some_and(|value| exact_existing_path(value, executable))
        || !transport
            .get("args")
            .and_then(Value::as_array)
            .is_some_and(|args| {
                args.len() == 1
                    && args[0]
                        .as_str()
                        .is_some_and(|value| exact_existing_path(value, launcher))
            })
        || !transport
            .get("env_vars")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty)
        || transport.get("cwd") != Some(&Value::Null)
    {
        return false;
    }
    let Some(environment) = transport.get("env").and_then(Value::as_object) else {
        return false;
    };
    if environment.keys().cloned().collect::<BTreeSet<_>>() != *expected_environment_keys
        || environment.values().any(|value| {
            value
                .as_str()
                .is_none_or(|value| value.is_empty() || value.chars().any(char::is_control))
        })
    {
        return false;
    }
    environment
        .get("EDITKIN_AGENT_STATE_ROOT")
        .and_then(Value::as_str)
        .is_some_and(|value| exact_existing_path(value, state_root))
}

/// Compatibility reader kept for the existing exactness tests: Some((exact, connected)) for any `mcp get` report
/// about `editkin` with a Status line, quoted or unquoted remove hint, `-s user` or `--scope user`.
#[cfg(test)]
pub fn claude_mcp_text_inspection(
    bytes: &[u8],
    executable: &Path,
    launcher: &Path,
    state_root: &Path,
    expected_environment_keys: &BTreeSet<String>,
) -> Option<(bool, bool)> {
    let parsed = parse_claude_mcp_get(std::str::from_utf8(bytes).ok()?, SERVER_NAME)?;
    let status = parsed.fields.get("Status")?;
    let connected = status.trim_start().starts_with('✓');
    let environment = parsed.environment.as_ref()?;
    let exact = !parsed.irregular
        && parsed.fields.get("Scope").map(String::as_str)
            == Some("User config (available in all your projects)")
        && parsed.fields.get("Type").map(String::as_str) == Some("stdio")
        && parsed.remove_scope.as_deref().is_none_or(|scope| scope == "user")
        && parsed
            .fields
            .get("Command")
            .is_some_and(|value| exact_existing_path(value, executable))
        && parsed
            .fields
            .get("Args")
            .is_some_and(|value| exact_existing_path(value, launcher))
        && environment.keys().cloned().collect::<BTreeSet<_>>() == *expected_environment_keys
        && environment
            .get("EDITKIN_AGENT_STATE_ROOT")
            .is_some_and(|value| exact_existing_path(value, state_root));
    Some((exact, connected))
}

// ---- writing the agent configuration -----------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CliRun {
    pub success: bool,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

fn cli_text(run: &CliRun) -> String {
    format!(
        "{}\n{}",
        String::from_utf8_lossy(&run.stdout).trim(),
        String::from_utf8_lossy(&run.stderr).trim()
    )
    .trim()
    .to_string()
}

fn run_text(run: &Result<CliRun, String>) -> String {
    match run {
        Ok(run) => cli_text(run),
        Err(error) => error.clone(),
    }
}

fn reports_absent(run: &CliRun) -> bool {
    !run.success && cli_text(run).to_ascii_lowercase().contains("no mcp server")
}

fn reports_already_exists(run: &Result<CliRun, String>) -> bool {
    run_text(run).to_ascii_lowercase().contains("already exists")
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfigChange {
    Added,
    Replaced,
    Unchanged,
}

impl ConfigChange {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Added => "added",
            Self::Replaced => "replaced",
            Self::Unchanged => "unchanged",
        }
    }
}

/// Whether an `editkin` entry existed before this attempt wrote anything.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PriorEntry {
    Absent,
    Present,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigSuccess {
    pub change: ConfigChange,
    /// "connected" (Claude's own health check passed) or "configured" (Codex has no connection check).
    pub health: &'static str,
    pub status_line: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigFailure {
    pub step: SetupStep,
    pub code: FailureCode,
    pub detail: String,
    pub prior: PriorEntry,
    /// The agent never accepted the entry, so a pasted fallback can still help.
    pub offer_fallback: bool,
}

fn config_failure(
    step: SetupStep,
    code: FailureCode,
    detail: String,
    prior: PriorEntry,
    offer_fallback: bool,
) -> ConfigFailure {
    ConfigFailure {
        step,
        code,
        detail,
        prior,
        offer_fallback,
    }
}

fn strings<const N: usize>(parts: [&str; N]) -> Vec<String> {
    parts.into_iter().map(str::to_string).collect()
}

/// Runs one CLI command through `runner` and records it in the log.
fn call(
    runner: &mut dyn FnMut(&[String], Duration) -> Result<CliRun, String>,
    log: &mut ConnectLog,
    program: &str,
    args: &[String],
    timeout: Duration,
) -> Result<CliRun, String> {
    log.command(program, args);
    let run = runner(args, timeout);
    log.output(&run);
    run
}

/// Writes (or keeps, or replaces) the agent's user-scoped `editkin` entry and reads it back.
/// `runner` executes `<agent cli> <args>`; the real one is run_agent_cli, tests pass a fake or an isolated CLI.
pub fn configure_agent_mcp(
    target: &str,
    runner: &mut dyn FnMut(&[String], Duration) -> Result<CliRun, String>,
    expected: &ExpectedConfig,
    add_args: &[String],
    log: &mut ConnectLog,
) -> Result<ConfigSuccess, ConfigFailure> {
    if target == "codex" {
        configure_codex(runner, expected, add_args, log)
    } else {
        configure_claude(runner, expected, add_args, log)
    }
}

fn configure_claude(
    runner: &mut dyn FnMut(&[String], Duration) -> Result<CliRun, String>,
    expected: &ExpectedConfig,
    add_args: &[String],
    log: &mut ConnectLog,
) -> Result<ConfigSuccess, ConfigFailure> {
    let get = strings(["mcp", "get", SERVER_NAME]);
    let remove = strings(["mcp", "remove", SERVER_NAME, "-s", "user"]);
    let mut prior = PriorEntry::Unknown;
    let mut replaced = false;
    log.step(SetupStep::WriteConfig);
    let before = call(runner, log, "claude", &get, CLI_HEALTH_TIMEOUT);
    match &before {
        Ok(run) if run.success => {
            prior = PriorEntry::Present;
            match parse_claude_mcp_get(&String::from_utf8_lossy(&run.stdout), SERVER_NAME) {
                Some(parsed) => {
                    let report = assess_claude_entry(&parsed, expected);
                    if report.matches && report.connected {
                        log.line("existing editkin entry already matches and is connected; nothing changed");
                        return Ok(ConfigSuccess {
                            change: ConfigChange::Unchanged,
                            health: "connected",
                            status_line: report.status,
                        });
                    }
                    if report.matches {
                        log.step(SetupStep::HealthCheck);
                        return Err(config_failure(
                            SetupStep::HealthCheck,
                            FailureCode::HealthCheckFailed,
                            format!(
                                "Claude Code already has exactly this Editkin entry, but its own connection check reports: {}",
                                if report.status.is_empty() { "(no status)" } else { &report.status }
                            ),
                            prior,
                            false,
                        ));
                    }
                    log.line(&format!(
                        "existing editkin entry differs ({}); replacing only that entry",
                        report.differences.join(", ")
                    ));
                }
                None => log.line("existing editkin entry could not be read; replacing only that entry"),
            }
            let removed = call(runner, log, "claude", &remove, CLI_TIMEOUT);
            if !removed.as_ref().is_ok_and(|run| run.success) {
                return Err(config_failure(
                    SetupStep::WriteConfig,
                    FailureCode::ConfigAlreadyExistsDifferent,
                    format!(
                        "Claude Code already has a different \"editkin\" entry and did not remove it (claude mcp remove editkin -s user):\n{}",
                        run_text(&removed)
                    ),
                    prior,
                    true,
                ));
            }
            replaced = true;
        }
        Ok(run) if reports_absent(run) => prior = PriorEntry::Absent,
        other => log.line(&format!(
            "could not tell whether an editkin entry exists: {}",
            run_text(other)
        )),
    }
    let mut added = call(runner, log, "claude", add_args, CLI_TIMEOUT);
    if !added.as_ref().is_ok_and(|run| run.success) {
        if !replaced && reports_already_exists(&added) {
            prior = PriorEntry::Present;
            log.line("Claude Code reports an existing editkin entry; replacing only that entry");
            let removed = call(runner, log, "claude", &remove, CLI_TIMEOUT);
            if !removed.as_ref().is_ok_and(|run| run.success) {
                return Err(config_failure(
                    SetupStep::WriteConfig,
                    FailureCode::ConfigAlreadyExistsDifferent,
                    format!(
                        "Claude Code already has an \"editkin\" entry and did not remove it:\n{}",
                        run_text(&removed)
                    ),
                    prior,
                    true,
                ));
            }
            replaced = true;
            added = call(runner, log, "claude", add_args, CLI_TIMEOUT);
        }
        if !added.as_ref().is_ok_and(|run| run.success) {
            return Err(config_failure(
                SetupStep::WriteConfig,
                FailureCode::ConfigWriteRefused,
                format!("claude mcp add did not accept the Editkin entry:\n{}", run_text(&added)),
                prior,
                true,
            ));
        }
    }
    log.step(SetupStep::HealthCheck);
    let verified = call(runner, log, "claude", &get, CLI_HEALTH_TIMEOUT);
    let change = if replaced { ConfigChange::Replaced } else { ConfigChange::Added };
    let health_failure = |detail: String| {
        config_failure(SetupStep::HealthCheck, FailureCode::HealthCheckFailed, detail, prior, false)
    };
    let run = match verified {
        Ok(run) if run.success => run,
        other => {
            return Err(health_failure(format!(
                "The entry was written, but claude mcp get editkin did not report it:\n{}",
                run_text(&other)
            )))
        }
    };
    let text = String::from_utf8_lossy(&run.stdout).to_string();
    let Some(parsed) = parse_claude_mcp_get(&text, SERVER_NAME) else {
        return Err(health_failure(format!(
            "The entry was written, but claude mcp get editkin printed a report Editkin could not read:\n{}",
            cli_text(&run)
        )));
    };
    let report = assess_claude_entry(&parsed, expected);
    if !report.connected {
        return Err(health_failure(format!(
            "The entry was written, but Claude Code's own connection check reports: {}",
            if report.status.is_empty() { "(no status)" } else { &report.status }
        )));
    }
    if !report.usable {
        return Err(health_failure(format!(
            "Claude Code connects to an \"editkin\" entry that is not the one Editkin wrote (differs in: {}):\n{}",
            report.differences.join(", "),
            text.trim()
        )));
    }
    Ok(ConfigSuccess {
        change,
        health: "connected",
        status_line: report.status,
    })
}

fn configure_codex(
    runner: &mut dyn FnMut(&[String], Duration) -> Result<CliRun, String>,
    expected: &ExpectedConfig,
    add_args: &[String],
    log: &mut ConnectLog,
) -> Result<ConfigSuccess, ConfigFailure> {
    let get = strings(["mcp", "get", SERVER_NAME, "--json"]);
    let mut prior = PriorEntry::Unknown;
    log.step(SetupStep::WriteConfig);
    let before = call(runner, log, "codex", &get, CLI_TIMEOUT);
    match &before {
        Ok(run) if run.success => {
            prior = PriorEntry::Present;
            if serde_json::from_slice::<Value>(&run.stdout)
                .is_ok_and(|value| codex_entry_matches(&value, expected, true))
            {
                log.line("existing editkin entry already matches; nothing changed");
                return Ok(ConfigSuccess {
                    change: ConfigChange::Unchanged,
                    health: "configured",
                    status_line: String::new(),
                });
            }
            log.line("existing editkin entry differs; codex mcp add replaces only that entry");
        }
        Ok(run) if reports_absent(run) => prior = PriorEntry::Absent,
        other => log.line(&format!(
            "could not tell whether an editkin entry exists: {}",
            run_text(other)
        )),
    }
    let added = call(runner, log, "codex", add_args, CLI_TIMEOUT);
    if !added.as_ref().is_ok_and(|run| run.success) {
        return Err(config_failure(
            SetupStep::WriteConfig,
            FailureCode::ConfigWriteRefused,
            format!("codex mcp add did not accept the Editkin entry:\n{}", run_text(&added)),
            prior,
            true,
        ));
    }
    log.step(SetupStep::HealthCheck);
    let verified = call(runner, log, "codex", &get, CLI_TIMEOUT);
    let readable = verified
        .as_ref()
        .ok()
        .filter(|run| run.success)
        .and_then(|run| serde_json::from_slice::<Value>(&run.stdout).ok());
    if !readable
        .as_ref()
        .is_some_and(|value| codex_entry_matches(value, expected, false))
    {
        return Err(config_failure(
            SetupStep::HealthCheck,
            FailureCode::HealthCheckFailed,
            format!(
                "codex mcp get editkin --json does not show the entry Editkin wrote:\n{}",
                run_text(&verified)
            ),
            prior,
            false,
        ));
    }
    Ok(ConfigSuccess {
        change: if prior == PriorEntry::Present {
            ConfigChange::Replaced
        } else {
            ConfigChange::Added
        },
        health: "configured",
        status_line: String::new(),
    })
}

// ---- Video Autopilot Skill (optional) ----------------------------------------------------------------------------

pub struct VaSkillStatus {
    pub installed: bool,
    /// The installed SKILL.md, or where Editkin will look once it is installed (given to the agent either way, so
    /// installing the Skill later needs no reconnect).
    pub skill_path: Option<PathBuf>,
    pub detail: Option<String>,
}

pub fn va_skill_status(app: &AppHandle) -> VaSkillStatus {
    let configured = env::var_os("EDITKIN_VIDEO_AUTOPILOT_SKILL");
    let candidate = crate::video_autopilot_skill_candidate(configured, app.path().home_dir().ok());
    match crate::video_autopilot_kit(app) {
        Ok(skill) => VaSkillStatus {
            installed: true,
            skill_path: Some(skill),
            detail: None,
        },
        Err(detail) => VaSkillStatus {
            installed: false,
            skill_path: candidate,
            detail: Some(detail),
        },
    }
}

impl VaSkillStatus {
    pub fn to_json(&self) -> Value {
        let mut value = json!({
            "installed": self.installed,
            "required": false,
            "kitUrl": crate::VIDEO_AUTOPILOT_KIT_URL,
        });
        if let Some(path) = &self.skill_path {
            value["skillPath"] = json!(path.to_string_lossy());
        }
        if let Some(detail) = &self.detail {
            value["detail"] = json!(detail);
        }
        value
    }
}

// ---- one attempt ---------------------------------------------------------------------------------------------------

fn user_profile(app: &AppHandle) -> Option<PathBuf> {
    env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| app.path().home_dir().ok())
}

pub fn agent_display_name(target: &str) -> &'static str {
    if target == "codex" {
        "Codex"
    } else {
        "Claude Code"
    }
}

fn legacy_cause(code: FailureCode) -> &'static str {
    match code {
        FailureCode::AgentAppNotFound => "cli_missing",
        FailureCode::WorkspaceNotWritable
        | FailureCode::WorkspaceChoiceExpired
        | FailureCode::WorkspaceUnsafe => "workspace",
/// The first manual step, in the words of the system's own terminal.
fn open_terminal_step() -> &'static str {
    match FallbackShell::CURRENT {
        FallbackShell::Windows => "開啟終端機（命令提示字元或 PowerShell 都可以）",
        FallbackShell::Posix => "打開「終端機」（應用程式 → 工具程式 → 終端機）",
    }
}

        _ => "unknown",
    }
}

/// Creates and removes one empty file: the MCP server writes projects into the chosen folder, and Editkin into its
/// own state folder, so an unwritable one is reported before anything is configured.
fn check_writable(directory: &Path) -> Result<(), String> {
    let mut nonce = [0_u8; 8];
    getrandom::fill(&mut nonce).map_err(|error| error.to_string())?;
    let probe = directory.join(format!(
        ".editkin-write-check-{}.tmp",
        nonce.iter().map(|byte| format!("{byte:02x}")).collect::<String>()
    ));
    let written = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .and_then(|mut file| file.write_all(b"editkin"));
    let _ = fs::remove_file(&probe);
    written.map_err(|error| format!("{}: {error}", directory.display()))
}

fn write_clipboard_verified(text: &str) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new().map_err(|error| error.to_string())?;
    clipboard
        .set_text(text.to_string())
        .map_err(|error| error.to_string())?;
    let readback = arboard::Clipboard::new()
        .and_then(|mut clipboard| clipboard.get_text())
        .map_err(|error| error.to_string())?;
    if readback == text {
        Ok(())
    } else {
        Err("the clipboard did not hold the command after writing it".into())
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Fallback {
    pub command: Option<String>,
    pub script_path: Option<PathBuf>,
    /// The clipboard was written and read back equal to `command`.
    pub clipboard_written: bool,
/// Writes the generated script; on macOS it is made executable (0755) so Finder runs a double-clicked `.command` in
/// Terminal and a pasted path runs it directly.
fn write_fallback_script(path: &Path, script: &str) -> std::io::Result<()> {
    fs::write(path, script.as_bytes())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

}

/// The result members a fallback adds. `status: command_copied` (the UI's "paste the copied command") exists only
/// when the clipboard was verified to hold `fallbackCommand`; the clipboard is written before this is called.
pub fn fallback_result_fields(fallback: &Fallback) -> Vec<(&'static str, Value)> {
    let mut fields = Vec::new();
    if let Some(command) = &fallback.command {
        fields.push(("fallbackCommand", json!(command)));
    }
    if let Some(path) = &fallback.script_path {
        fields.push(("fallbackScriptPath", json!(path.to_string_lossy())));
    }
    fields.push(("clipboardWritten", json!(fallback.clipboard_written && fallback.command.is_some())));
    if fallback.clipboard_written && fallback.command.is_some() {
        fields.push(("status", json!("command_copied")));
        fields.push(("health", json!("manual_step")));
    }
    fields
    if fallback.command.is_some() || fallback.script_path.is_some() {
        // "windows_shell": paste into 命令提示字元／PowerShell, double-click the .cmd; "posix_shell": paste into
        // 「終端機」, double-click the .command.
        fields.push(("fallbackKind", json!(FallbackShell::CURRENT.kind())));
    }
}

struct Prepared {
    runtime_tool_count: Option<usize>,
    plan_schema: Option<String>,
    live_binding: Option<String>,
    pointer_identity: Option<String>,
}

pub struct AgentConnectAttempt {
    target: String,
    name: &'static str,
    log: ConnectLog,
    profile: Option<PathBuf>,
    va: VaSkillStatus,
    cli: Option<crate::AgentCli>,
}

impl AgentConnectAttempt {
    pub fn begin(app: &AppHandle, target: &str) -> Self {
        let profile = user_profile(app);
        let logs = crate::application_data_root(app).ok().map(|root| root.join("logs"));
        let mut log = ConnectLog::open(logs, target, profile.clone());
        let va = va_skill_status(app);
        log.line(&format!(
            "Video Autopilot Skill: {}",
            if va.installed {
                "installed".to_string()
            } else {
                format!(
                    "not installed (optional; connecting does not need it){}",
                    va.detail.as_deref().map(|detail| format!(": {detail}")).unwrap_or_default()
                )
            }
        ));
        Self {
            target: target.to_string(),
            name: agent_display_name(target),
            log,
            profile,
            va,
            cli: None,
        }
    }

    /// The agent CLI must exist before a folder is chosen; None means go ahead.
    pub fn detect(&mut self) -> Option<Value> {
        self.log.step(SetupStep::Detect);
        match crate::locate_agent_cli(&self.target) {
            Some(cli) => {
                let shown = std::iter::once(cli.command.to_string_lossy().to_string())
                    .chain(cli.prefix_args.iter().cloned())
                    .collect::<Vec<_>>();
                self.log.line(&format!("{} CLI: {}", self.name, display_command(&shown[0], &shown[1..])));
                self.cli = Some(cli);
                None
            }
            None => {
                let command = if self.target == "codex" { "codex" } else { "claude" };
                Some(self.failure_result(
                    SetupStep::Detect,
                    FailureCode::AgentAppNotFound,
                    &format!(
                        "{} CLI ({command}) was not found: no {command}.exe on PATH{}",
                        self.name,
                        if self.target == "claude" {
                            " and no @anthropic-ai/claude-code/bin/claude.exe under a PATH folder"
                        } else {
                            " with node.exe and @openai/codex/bin/codex.js beside it"
                        }
                    ),
                    None,
                    None,
                    &[],
                ))
            }
        }
    }

    /// The folder picker was canceled: nothing changed and nothing is worth keeping.
    pub fn discard(self) {
        self.log.discard();
    }

    /// Live `{ step, state }` events for the connection screen's three steps.
    pub fn report_progress(&mut self, sink: ProgressSink) {
        self.log.set_progress(sink);
    }

    /// The folder behind a token from suggest_agent_workspace / pick_agent_workspace (never a raw path).
    pub fn workspace_from_token(&mut self, token: &str, window: &str) -> Result<AgentWorkspace, Value> {
        self.log.step(SetupStep::PrepareRuntime);
        let choice = match workspace_choices().redeem(token, window, Instant::now()) {
            Ok(choice) => choice,
            Err(WorkspaceTokenError::Expired) => {
                return Err(self.failure_result(
                    SetupStep::PrepareRuntime,
                    FailureCode::WorkspaceChoiceExpired,
                    "The folder choice is unknown, already used, expired (10 minutes) or from another window",
                    None,
                    None,
                    &[],
                ))
            }
        };
        self.log.line(&format!("chosen folder: {}", choice.path.display()));
        let code = if workspace_safety(&choice.path).is_err() {
            FailureCode::WorkspaceUnsafe
        } else {
            FailureCode::WorkspaceNotWritable
        };
        prepare_chosen_workspace(&choice)
            .map_err(|message| self.failure_result(SetupStep::PrepareRuntime, code, &message, None, None, &[]))
    }

    /// A folder from the setup's own picker that may not be handed to an agent.
    pub fn workspace_unsafe(mut self, message: &str) -> Value {
        self.log.step(SetupStep::PrepareRuntime);
        self.failure_result(SetupStep::PrepareRuntime, FailureCode::WorkspaceUnsafe, message, None, None, &[])
    }

    pub fn workspace_rejected(mut self, message: &str) -> Value {
        self.log.step(SetupStep::PrepareRuntime);
        self.failure_result(
            SetupStep::PrepareRuntime,
            FailureCode::WorkspaceNotWritable,
            message,
            None,
            None,
            &[],
        )
    }

    fn failure_result(
        &mut self,
        step: SetupStep,
        code: FailureCode,
        raw_detail: &str,
        workspace: Option<&AgentWorkspace>,
        prepared: Option<&Prepared>,
        extra: &[(&str, Value)],
    ) -> Value {
        self.log.line(&format!(
            "FAILED at {}: {} — {raw_detail}",
            step.as_str(),
            serde_json::to_value(code).ok().and_then(|code| code.as_str().map(str::to_string)).unwrap_or_default()
        ));
        self.log.finish_progress(false);
        let failure = SetupFailure::new(step, code, raw_detail, self.profile.as_deref(), self.log.path());
        let name = self.name;
        let command = if self.target == "codex" { "codex" } else { "claude" };
        let (message, repair_steps): (String, Vec<String>) = match code {
            FailureCode::AgentAppNotFound => (
                format!("這台電腦找不到 {name}，或它不在系統路徑（PATH）裡。"),
                vec![
                    format!("先安裝並登入 {name}，確認在終端機輸入 {command} 能打開它"),
                    format!("回到 Editkin，再按一次「連接 {name}」"),
                ],
            ),
            FailureCode::WorkspaceNotWritable => (
                if step == SetupStep::PrepareRuntime && raw_detail.contains("Editkin 的設定資料夾") {
                    "Editkin 無法寫入自己的 AI 串接設定資料夾，沒有變更任何 AI 設定。".to_string()
                } else {
                    "Editkin 無法使用所選的工作資料夾（不存在、無法存取或不能寫入），沒有變更任何 AI 設定。".to_string()
                },
                vec![
                    "重新按連接，選擇已存在、而且可以寫入的工作資料夾".into(),
                    "確認要剪輯的專案與素材都在所選資料夾範圍內".into(),
                ],
            ),
            FailureCode::WorkspaceChoiceExpired => (
                "選擇的資料夾已失效（只能用一次，十分鐘內有效），請再選一次資料夾；沒有變更任何 AI 設定。".into(),
                vec!["回到上一步，再選一次工作資料夾".into()],
            ),
            FailureCode::WorkspaceUnsafe => (
                "這個資料夾不能交給 AI 使用（整個磁碟、使用者資料夾本身或系統資料夾），請選擇或建立一個子資料夾；沒有變更任何 AI 設定。".into(),
                vec![
                    "回到上一步，選擇像「文件\\Editkin 作品」或「D:\\EditkinWork」這樣的子資料夾".into(),
                ],
            ),
            FailureCode::RuntimeFilesMissing => (
                "Editkin 的安裝不完整：找不到 AI 串接需要的程式檔案，沒有變更任何 AI 設定。".into(),
                vec![
                    "重新安裝最新版 Editkin".into(),
                    format!("裝好後回到 Editkin，再按一次「連接 {name}」"),
                ],
            ),
            FailureCode::RuntimeProbeFailed => (
                format!("Editkin 的 AI 串接程式無法啟動，所以沒有變更 {name} 的設定。"),
                vec![
                    "按「查看原因」看程式回報的錯誤".into(),
                    "重新開啟 Editkin 再試一次；仍然失敗時，把記錄檔附在回報裡".into(),
                ],
            ),
            FailureCode::ConfigWriteRefused => (
                format!("{name} 沒有接受 Editkin 的設定。"),
                vec![
                    open_terminal_step().into(),
                    "貼上已複製的備援指令並按 Enter".into(),
                    format!("重新開啟 {name} 或建立新 session，輸入 /mcp 確認 editkin"),
                ],
            ),
            FailureCode::ConfigAlreadyExistsDifferent => (
                format!("{name} 裡已經有另一個名為 editkin 的設定，Editkin 無法替換它。"),
                vec![
                    format!("{}，貼上已複製的備援指令並按 Enter（它只會替換 editkin 這一項）", open_terminal_step()),
                    format!("重新開啟 {name} 或建立新 session，輸入 /mcp 確認 editkin"),
                ],
            ),
            FailureCode::HealthCheckFailed => (
                format!("{name} 已收到設定，但沒有通過 {name} 自己的連線檢查；Editkin 不會把它誤報為已連線。"),
                vec![
                    format!("完全關閉並重新開啟 {name}"),
                    "在新 session 輸入 /mcp，查看 editkin 的錯誤訊息".into(),
                    "回到 Editkin 按「返回重試」重新驗證".into(),
                ],
            ),
            FailureCode::Unknown => (
                format!("Editkin 這次沒能設定 {name}。"),
                vec![
                    "按「返回重試」再試一次".into(),
                    "還是不行：重新開啟 Editkin 再試；仍然失敗時，把記錄檔附在回報裡".into(),
                ],
            ),
        };
        let mut result = json!({
            "canceled": false,
            "target": self.target,
            "status": "failed",
            "health": "failed",
            "apiKeyRequired": false,
            "usesCurrentSession": false,
            "runtimeVerified": prepared.is_some_and(|prepared| prepared.runtime_tool_count.is_some()),
            "cause": legacy_cause(code),
            "message": message,
            "detail": failure.detail,
            "repairSteps": repair_steps,
            "failure": serde_json::to_value(&failure).unwrap_or(Value::Null),
            "vaSkill": self.va.to_json(),
            "clipboardWritten": false,
        });
        if let Some(path) = self.log.path() {
            result["logPath"] = json!(path.to_string_lossy());
        }
        if let Some(workspace) = workspace {
            result["workspace"] = json!(workspace.path());
        }
        if let Some(prepared) = prepared {
            if let Some(count) = prepared.runtime_tool_count {
                result["runtimeToolCount"] = json!(count);
            }
            if let Some(identity) = &prepared.pointer_identity {
                result["generationPointerIdentity"] = json!(identity);
            }
        }
        for (key, value) in extra {
            result[*key] = value.clone();
        }
        result
    }

    fn offer_fallback(
        &mut self,
        cli: &crate::AgentCli,
        state_root: &Path,
        setup: &crate::agent_setup::AgentSetupInvocation,
        prior: PriorEntry,
    ) -> Fallback {
        let add_args = &setup.args;
        // `claude mcp add` refuses an existing entry, so the one-liner is offered only when none existed.
        let direct = setup
            .direct_command
            .clone()
            .filter(|_| self.target == "codex" || prior == PriorEntry::Absent);
        // Canonical paths are verbatim (`\\?\C:\…`); a .cmd file needs the ordinary spelling.
        let program = std::iter::once(cli.command.to_string_lossy().to_string())
            .chain(cli.prefix_args.iter().cloned())
            .map(|part| plain_path_text(&part))
            .collect::<Vec<_>>();
        let shell = FallbackShell::CURRENT;
        let script_path = state_root.join(shell.script_name(&self.target));
        let script_written = match shell.script(&self.target, &program, add_args) {
            Some(script) => match write_fallback_script(&script_path, &script) {
                Ok(()) => true,
                Err(error) => {
                    self.log.line(&format!("fallback script not written: {error}"));
                    false
                }
            },
            None => {
                self.log.line("fallback script not written: an argument cannot be written in a script");
                false
            }
        };
        let script_command = script_written
            .then(|| shell.script_invocation(&script_path))
            .flatten();
        let command = direct.clone().or(script_command);
        let clipboard_written = match &command {
            Some(text) => match write_clipboard_verified(text) {
                Ok(()) => true,
                Err(error) => {
                    self.log.line(&format!("clipboard not written: {error}"));
                    false
                }
            },
            None => false,
        };
        self.log.line(&format!(
            "fallback: {}; script: {}; clipboard holds it: {clipboard_written}",
            match (&direct, &command) {
                (Some(_), _) => "direct command".to_string(),
                (None, Some(_)) => "script invocation".to_string(),
                (None, None) => "none available".to_string(),
            },
            if script_written { script_path.display().to_string() } else { "none".into() }
        ));
        if let Some(command) = &command {
            self.log.line(&format!("fallback command: {command}"));
        }
        Fallback {
            command,
            script_path: script_written.then_some(script_path),
            clipboard_written,
        }
    }

    pub fn run(mut self, app: &AppHandle, workspace: &AgentWorkspace) -> Value {
        let Some(cli) = self.cli.clone() else {
            return self.failure_result(
                SetupStep::Detect,
                FailureCode::AgentAppNotFound,
                "detect() did not run before run()",
                Some(workspace),
                None,
                &[],
            );
        };
        self.log.step(SetupStep::PrepareRuntime);
        self.log.line(&format!("workspace: {}", workspace.path().display()));
        if let Err(error) = check_writable(workspace.path()) {
            return self.failure_result(
                SetupStep::PrepareRuntime,
                FailureCode::WorkspaceNotWritable,
                &format!("所選工作資料夾無法寫入：{error}"),
                Some(workspace),
                None,
                &[],
            );
        }
        let contract = match crate::editkin_agent_setup_contract().and_then(|contract| {
            let launcher = crate::editkin_agent_launcher_contract(&contract)?.clone();
            let starter = crate::editkin_agent_starter_prompt(&contract)?;
            Ok((contract, launcher, starter))
        }) {
            Ok(contract) => contract,
            Err(error) => {
                return self.failure_result(SetupStep::PrepareRuntime, FailureCode::Unknown, &error, Some(workspace), None, &[])
            }
        };
        let (contract, launcher_contract, starter_prompt) = contract;
        let runtime = match crate::runtime_paths(app) {
            Ok(runtime) => runtime,
            Err(error) => {
                return self.failure_result(
                    SetupStep::PrepareRuntime,
                    FailureCode::RuntimeFilesMissing,
                    &format!("Editkin runtime paths unavailable: {error}"),
                    Some(workspace),
                    None,
                    &[],
                )
            }
        };
        let missing = [
            ("node", &runtime.node),
            ("agent launcher", &runtime.agent_launcher),
            ("agent setup contract", &runtime.agent_contract),
            ("MCP entrypoint", &runtime.mcp),
            ("MCP identity", &runtime.mcp_identity),
        ]
        .into_iter()
        .filter(|(_, path)| !path.is_file())
        .map(|(label, path)| format!("{label}: {}", path.display()))
        .collect::<Vec<_>>();
        if !missing.is_empty() {
            return self.failure_result(
                SetupStep::PrepareRuntime,
                FailureCode::RuntimeFilesMissing,
                &format!("Editkin runtime files are missing:\n{}", missing.join("\n")),
                Some(workspace),
                None,
                &[],
            );
        }
        let state_directory_name = launcher_contract
            .get("stateDirectoryName")
            .and_then(Value::as_str)
            .unwrap_or("agent-runtime-v3")
            .to_string();
        let data_root = match crate::application_data_root(app) {
            Ok(root) => root,
            Err(error) => {
                return self.failure_result(SetupStep::PrepareRuntime, FailureCode::Unknown, &error, Some(workspace), None, &[])
            }
        };
        if let Err(error) = fs::create_dir_all(&data_root)
            .map_err(|error| format!("{}: {error}", data_root.display()))
            .and_then(|()| check_writable(&data_root))
        {
            return self.failure_result(
                SetupStep::PrepareRuntime,
                FailureCode::WorkspaceNotWritable,
                &format!("Editkin 的設定資料夾無法寫入：{error}"),
                Some(workspace),
                None,
                &[],
            );
        }
        let agent_state_root = data_root.join(&state_directory_name);
        // The Skill is optional: when it is missing the agent still gets the path Editkin will read once it is
        // installed (the MCP checks it per tool call), so installing it later needs no reconnect.
        self.va = va_skill_status(app);
        let Some(skill_path) = self.va.skill_path.clone() else {
            return self.failure_result(
                SetupStep::PrepareRuntime,
                FailureCode::Unknown,
                "The user home folder is unknown, so the Video Autopilot Skill location cannot be given to the agent",
                Some(workspace),
                None,
                &[],
            );
        };
        let mut environment = match crate::base_agent_environment(app, &runtime, &agent_state_root, &skill_path) {
            Ok(environment) => environment,
            Err(error) => {
                return self.failure_result(SetupStep::PrepareRuntime, FailureCode::Unknown, &error, Some(workspace), None, &[])
            }
        };
        let expected_keys = contract
            .get("envKeys")
            .and_then(Value::as_array)
            .map(|keys| keys.iter().filter_map(Value::as_str).map(str::to_string).collect::<BTreeSet<_>>())
            .unwrap_or_default();
        // Held through the probe so the start-up repair cannot swap the generation under this attempt.
        let _generation = generation_lock();
        let generation = match activate_product_agent_generation(
            &agent_state_root,
            &product_generation_paths(&runtime),
            crate::EDITKIN_AGENT_SETUP_CONTRACT.as_bytes(),
        ) {
            Ok(generation) => generation,
            Err(error) => {
                return self.failure_result(
                    SetupStep::PrepareRuntime,
                    FailureCode::RuntimeFilesMissing,
                    &format!("Editkin could not prepare its agent runtime files: {error}"),
                    Some(workspace),
                    None,
                    &[],
                )
            }
        };
        self.log.line(&format!("generation pointer: {}", generation.pointer_identity));
        if let Some(binding) = environment.iter_mut().find(|(key, _)| key == "EDITKIN_AGENT_STATE_ROOT") {
            binding.1 = generation.state_root.to_string_lossy().to_string();
        }
        let setup = match crate::agent_setup::build_agent_setup_invocation(
            &self.target,
            &runtime.node,
            &runtime.agent_launcher,
            workspace,
            environment,
            &expected_keys,
        ) {
            Ok(setup) => setup,
            Err(error) => {
                let rollback = rollback_note(&generation);
                return self.failure_result(
                    SetupStep::PrepareRuntime,
                    FailureCode::Unknown,
                    &format!("{error}; {rollback}"),
                    Some(workspace),
                    None,
                    &[],
                );
            }
        };
        let mut prepared = Prepared {
            runtime_tool_count: None,
            plan_schema: None,
            live_binding: None,
            pointer_identity: Some(generation.pointer_identity.clone()),
        };

        self.log.step(SetupStep::Probe);
        self.log.line(&format!(
            "starting {} {} (live autopilot contract {})",
            runtime.node.display(),
            runtime.agent_launcher.display(),
            if self.va.installed { "required" } else { "skipped: Video Autopilot Skill not installed" }
        ));
        let probe = crate::agent_runtime_probe::probe_current_editkin_mcp(
            &runtime.node,
            &runtime.agent_launcher,
            &setup.environment,
            self.va.installed,
        );
        self.log.line(&format!(
            "MCP stderr (tail):\n{}",
            if probe.stderr_tail.is_empty() { "(empty)" } else { &probe.stderr_tail }
        ));
        let runtime_probe = match probe.result {
            Ok(runtime_probe) => runtime_probe,
            Err(error) => {
                let rollback = rollback_note(&generation);
                let detail = if probe.stderr_tail.is_empty() {
                    format!("{error}\n(the MCP printed nothing on stderr); {rollback}")
                } else {
                    format!("{error}\n--- MCP stderr (tail) ---\n{}\n--- {rollback}", probe.stderr_tail)
                };
                prepared.pointer_identity = None;
                return self.failure_result(SetupStep::Probe, FailureCode::RuntimeProbeFailed, &detail, Some(workspace), Some(&prepared), &[]);
            }
        };
        self.log.line(&format!("probe passed: {} tools", runtime_probe.tool_count));
        prepared.runtime_tool_count = Some(runtime_probe.tool_count);
        prepared.plan_schema = runtime_probe.plan_schema.clone();
        prepared.live_binding = runtime_probe.live_invocation_binding.clone();

        let expected = ExpectedConfig {
            executable: runtime.node.clone(),
            launcher: runtime.agent_launcher.clone(),
            environment: setup.environment.iter().cloned().collect(),
        };
        let mut runner = |args: &[String], timeout: Duration| {
            crate::run_agent_cli_with_timeout(&cli, args, timeout).map(|output| CliRun {
                success: output.success,
                stdout: output.stdout,
                stderr: output.stderr,
            })
        };
        let configured = configure_agent_mcp(&self.target, &mut runner, &expected, &setup.args, &mut self.log);
        let name = self.name;
        match configured {
            Ok(success) => {
                self.log.line(&format!(
                    "SUCCESS: {} ({}){}",
                    success.change.as_str(),
                    success.health,
                    if success.status_line.is_empty() { String::new() } else { format!(", {}", success.status_line) }
                ));
                self.log.finish_progress(true);
                remember_workspace(&data_root, workspace.path());
                // A connect re-activates the generation from the installed files, so any start-up repair failure
                // ("reconnect after the update") is resolved.
                *runtime_repair_state().lock().unwrap_or_else(|error| error.into_inner()) =
                    json!({ "state": "ok", "repaired": true });
                let message = match (success.change, success.health) {
                    (ConfigChange::Unchanged, _) => format!("{name} 已經連著這台電腦目前的 Editkin，不需要變更。開新 session 貼上開工指令即可。"),
                    (ConfigChange::Replaced, _) => format!("已把 {name} 原本的 editkin 設定換成這台電腦目前的 Editkin（其他 MCP 伺服器沒有變動）。重新開啟或建立新 session 後，貼上開工指令即可使用。"),
                    (ConfigChange::Added, "connected") => format!("{name} 已連上最新版 Editkin MCP。重新開啟或建立新 session 後，貼上開工指令即可使用自己的訂閱額度。"),
                    (ConfigChange::Added, _) => format!("{name} 已設定最新版 Editkin MCP；本機 runtime 已通過真握手。請建立新 session，再用 /mcp 或首次工具呼叫確認已連線。"),
                };
                let mut result = json!({
                    "canceled": false,
                    "target": self.target,
                    "workspace": workspace.path(),
                    "status": if success.change == ConfigChange::Unchanged { "already_installed" } else { "installed" },
                    "health": success.health,
                    "apiKeyRequired": false,
                    "usesCurrentSession": false,
                    "runtimeVerified": true,
                    "generationPointerIdentity": generation.pointer_identity.as_str(),
                    "runtimeToolCount": runtime_probe.tool_count,
                    "autopilotPlanSchema": runtime_probe.plan_schema,
                    "liveInvocationBinding": runtime_probe.live_invocation_binding,
                    "starterPrompt": starter_prompt,
                    "clientRestartRequired": success.change != ConfigChange::Unchanged,
                    "configChange": success.change.as_str(),
                    "replacedExisting": success.change == ConfigChange::Replaced,
                    "vaSkill": self.va.to_json(),
                    "clipboardWritten": false,
                    "repairSteps": [
                        format!("重新開啟 {name} 或建立新 session"),
                        "在新 session 輸入 /mcp，確認 editkin 已連線",
                    ],
                    "verification": format!(
                        "已真實啟動最新 v3 generation launcher（{} tools{}），並由 {name} mcp get editkin 讀回 user-scoped 設定",
                        runtime_probe.tool_count,
                        if runtime_probe.plan_schema.is_some() { "／v4 live identity" } else { "；Video Autopilot Skill 未安裝，live contract 略過" }
                    ),
                    "message": message,
                });
                if let Some(path) = self.log.path() {
                    result["logPath"] = json!(path.to_string_lossy());
                }
                result
            }
            Err(failure) => {
                let fallback = failure
                    .offer_fallback
                    .then(|| self.offer_fallback(&cli, &generation.state_root, &setup, failure.prior));
                let mut extra = vec![
                    ("starterPrompt", json!(starter_prompt)),
                    ("clientRestartRequired", json!(true)),
                ];
                if let Some(schema) = &prepared.plan_schema {
                    extra.push(("autopilotPlanSchema", json!(schema)));
                }
                if let Some(binding) = &prepared.live_binding {
                    extra.push(("liveInvocationBinding", json!(binding)));
                }
                if let Some(fallback) = &fallback {
                    extra.extend(fallback_result_fields(fallback));
                }
                let mut result = self.failure_result(
                    failure.step,
                    failure.code,
                    &failure.detail,
                    Some(workspace),
                    Some(&prepared),
                    &extra,
                );
                let copied = fallback.as_ref().is_some_and(|fallback| fallback.clipboard_written);
                if failure.offer_fallback && !copied {
                    // Never tell anyone to paste a command that is not on the clipboard.
                    let mut steps = vec![format!("按「查看原因」看 {name} 回報的錯誤")];
                    if fallback.as_ref().is_some_and(|fallback| fallback.command.is_some()) {
                        steps.push("沒有自動複製成功：手動複製下方的備援指令，貼到終端機執行".into());
                    } else if fallback.as_ref().is_some_and(|fallback| fallback.script_path.is_some()) {
                        steps.push(match FallbackShell::CURRENT {
                            FallbackShell::Windows => "在檔案總管中雙擊下方的備援指令檔（.cmd）".into(),
                            FallbackShell::Posix => "在 Finder 中雙擊下方的備援指令檔（.command），它會在「終端機」裡執行".into(),
                        });
                    }
                    steps.push("回到 Editkin 按「返回重試」再試一次；仍然失敗時，把記錄檔附在回報裡".into());
                    result["repairSteps"] = json!(steps);
                }
                result
            }
        }
    }
}

// ---- the work folder ---------------------------------------------------------------------------------------------

/// The suggested folder under Documents when no connection has chosen one yet.
pub const DEFAULT_WORKSPACE_NAME: &str = "Editkin 作品";
const REMEMBERED_WORKSPACE_FILE: &str = "agent-connect-workspace.json";
const REMEMBERED_WORKSPACE_SCHEMA: &str = "editkin.agent-connect-workspace/v1";

fn remember_workspace(data_root: &Path, workspace: &Path) {
    let body = json!({ "schema": REMEMBERED_WORKSPACE_SCHEMA, "path": workspace.to_string_lossy() });
    let _ = fs::write(data_root.join(REMEMBERED_WORKSPACE_FILE), body.to_string());
}

/// The folder the last successful connection used, if it still exists.
pub fn remembered_workspace(data_root: &Path) -> Option<PathBuf> {
    let path = data_root.join(REMEMBERED_WORKSPACE_FILE);
    let metadata = fs::symlink_metadata(&path).ok()?;
    if !metadata.is_file() || metadata.len() > 16 * 1024 {
        return None;
    }
    let value: Value = serde_json::from_slice(&fs::read(&path).ok()?).ok()?;
    if value.get("schema").and_then(Value::as_str) != Some(REMEMBERED_WORKSPACE_SCHEMA) {
        return None;
    }
    let remembered = PathBuf::from(value.get("path").and_then(Value::as_str)?);
    (remembered.is_absolute() && remembered.is_dir()).then_some(remembered)
}

fn folder_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

fn same_folder(left: &Path, right: &Path) -> bool {
    let text = |path: &Path| {
        let text = plain_path_text(&path.to_string_lossy())
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_string();
        if cfg!(windows) {
            text.to_lowercase()
        } else {
            text
        }
    };
    text(left) == text(right)
}

fn inside_folder(path: &Path, folder: &Path) -> bool {
    let text = |path: &Path| {
        let text = plain_path_text(&path.to_string_lossy()).replace('/', "\\");
        let text = text.trim_end_matches('\\').to_string();
        if cfg!(windows) {
            text.to_lowercase()
        } else {
            text
        }
    };
    let (path, folder) = (text(path), text(folder));
    path == folder || path.starts_with(&format!("{folder}\\"))
}

/// Why `path` may not be the folder an AI agent works in, or None when it may. A work folder grants the agent
/// everything below it, so whole drives, the profile root, Windows, Program Files, ProgramData and the AppData roots
/// are refused, as are network and device paths; ordinary subfolders such as `Documents\Editkin 作品` or
/// `D:\EditkinWork` are fine. `lookup` reads environment variables (injected for tests).
pub fn unsafe_workspace_reason(path: &Path, lookup: &dyn Fn(&str) -> Option<String>) -> Option<String> {
    let text = path.to_string_lossy();
    if text.chars().any(char::is_control) || !path.is_absolute() {
        return Some("工作資料夾必須是完整路徑".into());
    }
    if path
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Some("工作資料夾路徑不能包含「..」".into());
    }
    let plain = plain_path_text(&text);
    #[cfg(windows)]
    {
        // The shared text rule (`crate::local_path_text_problem`), plus the workspace-only rule of a drive-letter path.
        let bytes = plain.as_bytes();
        let drive = bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'\\' | b'/');
        match crate::local_path_text_problem(&plain) {
            // A `:` after the drive names a stream, not a folder.
            Some(crate::LocalPathProblem::AlternateStream) => return Some("工作資料夾必須是完整路徑".into()),
            problem if !drive || problem.is_some() => {
                return Some("工作資料夾必須在這台電腦的磁碟上，不能是網路或裝置路徑".into());
            }
            _ => {}
        }
    }
    let plain = PathBuf::from(plain);
    if plain.parent().is_none() {
        return Some("不能把整個磁碟當成工作資料夾，請選擇或建立一個子資料夾".into());
    }
    let variable = |name: &str| lookup(name).filter(|value| !value.trim().is_empty()).map(PathBuf::from);
    if let Some(profile) = variable("USERPROFILE").or_else(|| variable("HOME")) {
        if same_folder(&plain, &profile) {
            return Some("不能把整個使用者資料夾當成工作資料夾，請選擇其中的子資料夾".into());
        }
        if same_folder(&plain, &profile.join("AppData")) {
    #[cfg(not(windows))]
    {
        if let Some(reason) = posix_workspace_refusal(&plain.to_string_lossy(), lookup("HOME").as_deref()) {
            return Some(reason.into());
        }
    }
            return Some("不能使用 AppData 資料夾當成工作資料夾".into());
        }
    }
    for name in ["APPDATA", "LOCALAPPDATA"] {
        if variable(name).is_some_and(|root| same_folder(&plain, &root)) {
            return Some("不能使用 AppData 資料夾當成工作資料夾".into());
        }
    }
    for name in ["SystemRoot", "windir", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData"] {
        if variable(name).is_some_and(|root| inside_folder(&plain, &root)) {
            return Some("不能使用 Windows、Program Files 或 ProgramData 裡的資料夾當成工作資料夾".into());
        }
    }
    None
}

fn environment_lookup(name: &str) -> Option<String> {
    env::var(name).ok()
}

/// The real environment's verdict, with the canonical spelling checked too (a link may lead somewhere refused).
pub fn workspace_safety(path: &Path) -> Result<(), String> {
/// macOS work-folder rules on the path text (POSIX `/` paths), compiled and tested on every system. Refused: the
/// disk root; the top-level `/System`, `/Library`, `/Applications`, `/usr`, `/bin`, `/sbin`, `/private`, `/Users`,
/// `/Volumes` (and `/etc`, `/var`, `/tmp`, `/opt`, `/cores`, `/dev`) folders themselves; anything inside the sealed
/// system trees `/System`, `/usr`, `/bin`, `/sbin`, `/dev`; a whole volume (`/Volumes/<name>`); the home folder itself
/// and anything in `~/Library`. Allowed: ordinary subfolders such as `~/Movies/Editkin 作品`, `~/Documents/…` or
/// `/Volumes/T7/EditkinWork`. Compared case-insensitively, as APFS is by default. `home` is `$HOME`.
#[cfg_attr(windows, allow(dead_code))]
pub fn posix_workspace_refusal(path: &str, home: Option<&str>) -> Option<&'static str> {
    const POSIX_WHOLE_DISK: &str = "不能把整個磁碟當成工作資料夾，請選擇或建立一個子資料夾";
    const POSIX_SYSTEM_FOLDER: &str =
        "不能使用系統資料夾（例如 /System、/Library、/Applications、/usr）當成工作資料夾，請選擇或建立一個子資料夾";
    const POSIX_HOME_FOLDER: &str = "不能把整個使用者資料夾當成工作資料夾，請選擇其中的子資料夾";
    const POSIX_LIBRARY_FOLDER: &str = "不能使用「資源庫」（~/Library）裡的資料夾當成工作資料夾";
    fn components(path: &str) -> Option<Vec<String>> {
        if !path.starts_with('/') || path.chars().any(char::is_control) {
            return None;
        }
        let mut parts = Vec::new();
        for part in path.split('/') {
            match part {
                "" | "." => continue,
                ".." => return None,
                other => parts.push(other.to_lowercase()),
            }
        }
        Some(parts)
    }
    let Some(parts) = components(path) else {
        return Some("工作資料夾必須是完整路徑，而且不能包含「..」");
    };
    const TOP_LEVEL: [&str; 15] = [
        "system", "library", "applications", "usr", "bin", "sbin", "private", "users", "volumes", "etc", "var", "tmp",
        "opt", "cores", "dev",
    ];
    const SEALED: [&str; 5] = ["system", "usr", "bin", "sbin", "dev"];
    match parts.as_slice() {
        [] => return Some(POSIX_WHOLE_DISK),
        [top] if TOP_LEVEL.contains(&top.as_str()) => return Some(POSIX_SYSTEM_FOLDER),
        [volumes, _] if volumes == "volumes" => return Some(POSIX_WHOLE_DISK),
        [top, ..] if SEALED.contains(&top.as_str()) => return Some(POSIX_SYSTEM_FOLDER),
        _ => {}
    }
    if let Some(home) = home.and_then(components).filter(|home| !home.is_empty()) {
        if parts == home {
            return Some(POSIX_HOME_FOLDER);
        }
        let library = home.iter().cloned().chain(["library".to_string()]).collect::<Vec<_>>();
        if parts.len() >= library.len() && parts[..library.len()] == library[..] {
            return Some(POSIX_LIBRARY_FOLDER);
        }
    }
    None
}

    let lookup = environment_lookup;
    if let Some(reason) = unsafe_workspace_reason(path, &lookup) {
        return Err(format!("{reason}；未變更 AI 設定"));
    }
    if let Ok(canonical) = fs::canonicalize(path) {
        if let Some(reason) = unsafe_workspace_reason(&canonical, &lookup) {
            return Err(format!("{reason}；未變更 AI 設定"));
        }
    }
    Ok(())
}

/// How long a natively chosen folder stays usable by the setup command.
pub const WORKSPACE_CHOICE_TTL: Duration = Duration::from_secs(10 * 60);
const WORKSPACE_CHOICE_LIMIT: usize = 16;
/// Only the main window may choose a folder and use the choice.
pub const WORKSPACE_CHOICE_WINDOW: &str = "main";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorkspaceChoice {
    pub path: PathBuf,
    /// Only the suggested default may be created by the setup; a picked folder must still exist.
    pub create_if_missing: bool,
    window: String,
    expires: Instant,
}

/// Folders chosen natively (suggestion or picker), each behind an opaque, random, single-use token that expires
/// and belongs to the window that asked. The webview never hands the setup a path.
#[derive(Default)]
pub struct WorkspaceChoices {
    entries: std::sync::Mutex<BTreeMap<String, WorkspaceChoice>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WorkspaceTokenError {
    /// Unknown, already used, expired or from another window: choose the folder again.
    Expired,
}

impl WorkspaceChoices {
    pub fn issue(&self, path: PathBuf, create_if_missing: bool, window: &str, now: Instant) -> Result<String, String> {
        let mut nonce = [0_u8; 16];
        getrandom::fill(&mut nonce).map_err(|error| error.to_string())?;
        let token = nonce.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        let mut entries = self.entries.lock().unwrap_or_else(|error| error.into_inner());
        entries.retain(|_, choice| choice.expires > now);
        while entries.len() >= WORKSPACE_CHOICE_LIMIT {
            let oldest = entries
                .iter()
                .min_by_key(|(_, choice)| choice.expires)
                .map(|(token, _)| token.clone());
            match oldest {
                Some(oldest) => entries.remove(&oldest),
                None => break,
            };
        }
        entries.insert(
            token.clone(),
            WorkspaceChoice {
                path,
                create_if_missing,
                window: window.to_string(),
                expires: now + WORKSPACE_CHOICE_TTL,
            },
        );
        Ok(token)
    }

    /// Single use: the token is consumed by the first attempt, whether or not that attempt may use it.
    pub fn redeem(&self, token: &str, window: &str, now: Instant) -> Result<WorkspaceChoice, WorkspaceTokenError> {
        if token.len() != 32 || !token.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()) {
            return Err(WorkspaceTokenError::Expired);
        }
        let choice = self
            .entries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(token)
            .ok_or(WorkspaceTokenError::Expired)?;
        if choice.expires <= now || choice.window != window || window != WORKSPACE_CHOICE_WINDOW {
            return Err(WorkspaceTokenError::Expired);
        }
        Ok(choice)
    }
}

/// The app's one store of chosen folders.
pub fn workspace_choices() -> &'static WorkspaceChoices {
    static CHOICES: std::sync::OnceLock<WorkspaceChoices> = std::sync::OnceLock::new();
    CHOICES.get_or_init(WorkspaceChoices::default)
}

/// A redeemed choice made ready: checked again, the suggested default created when missing, canonicalized.
pub fn prepare_chosen_workspace(choice: &WorkspaceChoice) -> Result<AgentWorkspace, String> {
    workspace_safety(&choice.path)?;
    if !choice.path.exists() {
        if !choice.create_if_missing {
            return Err(format!("所選的工作資料夾已不存在：{}；未變更 AI 設定", choice.path.display()));
        }
        fs::create_dir_all(&choice.path)
            .map_err(|error| format!("無法建立工作資料夾 {}：{error}；未變更 AI 設定", choice.path.display()))?;
    }
    let workspace = crate::agent_setup::selected_agent_workspace(Some(&choice.path))?
        .ok_or_else(|| "無法確認所選工作資料夾；未變更 AI 設定".to_string())?;
    workspace_safety(workspace.path())?;
    Ok(workspace)
}

fn chosen_workspace_json(token: &str, path: &Path) -> Value {
    json!({
        "token": token,
        "displayName": folder_name(path),
        "displayPath": path.to_string_lossy(),
    })
}

/// The folder to suggest, as a token: the folder the last successful connection used (if it still exists and is
/// allowed), else `Documents\Editkin 作品` on Windows and `~/Movies/Editkin 作品` on macOS (the Mac's place for
/// video). Nothing is created until a setup redeems the token.
#[tauri::command(async)]
pub fn suggest_agent_workspace(app: AppHandle, webview: tauri::Webview) -> Result<Value, String> {
    let remembered = crate::application_data_root(&app)
        .ok()
        .and_then(|root| remembered_workspace(&root))
        .filter(|path| workspace_safety(path).is_ok());
    let (path, is_remembered) = match remembered {
        Some(path) => (path, true),
        None => {
            let documents = if cfg!(target_os = "macos") {
                app.path()
                    .video_dir()
                    .or_else(|_| app.path().home_dir().map(|home| home.join("Movies")))
                    .map_err(|error| format!("找不到「影片」資料夾：{error}"))?
            } else {
                app.path()
                    .document_dir()
                    .or_else(|_| app.path().home_dir().map(|home| home.join("Documents")))
                    .map_err(|error| format!("找不到「文件」資料夾：{error}"))?
            };
            (documents.join(DEFAULT_WORKSPACE_NAME), false)
        }
    };
    workspace_safety(&path)?;
    let token = workspace_choices().issue(path.clone(), !is_remembered, webview.label(), Instant::now())?;
    let mut value = chosen_workspace_json(&token, &path);
    value["exists"] = json!(path.is_dir());
    value["remembered"] = json!(is_remembered);
    Ok(value)
}

fn local_start_directory(start: &str) -> Option<PathBuf> {
    // The shared text rule before the folder is looked at: no network, device, stream or relative start folder.
    if crate::local_path_text_problem(start).is_some() {
        return None;
    }
    let path = PathBuf::from(start);
    if path.is_dir() {
        return Some(path);
    }
    path.parent().filter(|parent| parent.is_dir()).map(Path::to_path_buf)
}

/// Only the native folder picker. A chosen folder comes back as a token; an unsafe one is refused with a reason.
#[tauri::command(async)]
pub fn pick_agent_workspace(webview: tauri::Webview, start_path: Option<String>, ui_locale: Option<String>) -> Value {
    let mut dialog = rfd::FileDialog::new().set_title(crate::native_dialog_labels::text(
        ui_locale.as_deref(),
        crate::native_dialog_labels::DialogText::AgentFolder,
    ));
    if let Some(start) = start_path.as_deref().and_then(local_start_directory) {
        dialog = dialog.set_directory(start);
    }
    let Some(path) = dialog.pick_folder() else {
        return json!({ "canceled": true });
    };
    let path = PathBuf::from(plain_path_text(&path.to_string_lossy()));
    if let Err(message) = workspace_safety(&path) {
        return json!({
            "canceled": false,
            "refused": true,
            "code": "WORKSPACE_UNSAFE",
            "message": message,
            "displayName": folder_name(&path),
            "displayPath": path.to_string_lossy(),
        });
    }
    match workspace_choices().issue(path.clone(), false, webview.label(), Instant::now()) {
        Ok(token) => {
            let mut value = chosen_workspace_json(&token, &path);
            value["canceled"] = json!(false);
            value
        }
        Err(message) => json!({ "canceled": false, "refused": true, "code": "UNKNOWN", "message": message,
            "displayName": folder_name(&path), "displayPath": path.to_string_lossy() }),
    }
}

// ---- official pages ----------------------------------------------------------------------------------------------

/// The only pages 「連接 AI」 opens in the system browser, matched exactly (scheme, host, path; no query/fragment).
pub const EXTERNAL_URL_ALLOWLIST: [&str; 4] = [
    "https://code.claude.com/docs/en/setup",
    "https://github.com/openai/codex",
    "https://github.com/Hao0321/video-autopilot-kit",
    "https://github.com/Hao0321/Editkin/releases",
];

pub fn allowed_external_url(url: &str) -> bool {
    EXTERNAL_URL_ALLOWLIST.contains(&url)
}

/// Opens one allow-listed page in the system browser. Anything else is refused before any process starts.
#[tauri::command(async)]
pub fn open_external_url(url: String) -> Result<(), String> {
    if !allowed_external_url(&url) {
        return Err("Editkin 只開啟固定的官方說明頁；已拒絕這個網址".into());
    }
    if crate::integration_state_root().is_some() {
        // The isolated integration runtime never launches a browser.
        return Ok(());
    }
    let mut command = if cfg!(windows) {
        let windows = env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        std::process::Command::new(windows.join("explorer.exe"))
    } else if cfg!(target_os = "macos") {
        std::process::Command::new("open")
    } else {
        std::process::Command::new("xdg-open")
    };
    command
        .arg(&url)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("無法開啟瀏覽器：{error}"))
}

// ---- finding the agent CLI after a fresh install -----------------------------------------------------------------

/// `%NAME%` replaced through `lookup`; unknown names and lone `%` stay as written.
pub fn expand_percent_variables(text: &str, lookup: &dyn Fn(&str) -> Option<String>) -> String {
    let mut output = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('%') {
        output.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        match after.find('%') {
            Some(end) if end > 0 && !after[..end].contains(['\\', '/', ';']) => match lookup(&after[..end]) {
                Some(value) => {
                    output.push_str(&value);
                    rest = &after[end + 1..];
                }
                None => {
                    output.push('%');
                    rest = after;
                }
            },
            _ => {
                output.push('%');
                rest = after;
            }
        }
    }
    output.push_str(rest);
    output
}

/// A PATH-style list (as stored in the registry) as absolute folders.
pub fn path_list_directories(list: &str, lookup: &dyn Fn(&str) -> Option<String>) -> Vec<PathBuf> {
    list.split(';')
        .map(|entry| expand_percent_variables(entry.trim().trim_matches('"'), lookup))
        .filter(|entry| !entry.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .collect()
}

/// npm's global prefix: NPM_CONFIG_PREFIX, else `prefix=` in the user's .npmrc, else `%APPDATA%\npm`.
pub fn npm_global_prefixes(lookup: &dyn Fn(&str) -> Option<String>, user_npmrc: Option<&str>) -> Vec<PathBuf> {
    let mut prefixes = Vec::new();
    for name in ["NPM_CONFIG_PREFIX", "npm_config_prefix"] {
        if let Some(value) = lookup(name).filter(|value| !value.trim().is_empty()) {
            prefixes.push(PathBuf::from(expand_percent_variables(value.trim(), lookup)));
        }
    }
    if let Some(npmrc) = user_npmrc {
        for line in npmrc.lines() {
            if let Some((key, value)) = line.split_once('=') {
                if key.trim().eq_ignore_ascii_case("prefix") && !value.trim().is_empty() {
                    prefixes.push(PathBuf::from(expand_percent_variables(value.trim().trim_matches('"'), lookup)));
                }
            }
        }
    }
    if let Some(appdata) = lookup("APPDATA") {
        prefixes.push(PathBuf::from(appdata).join("npm"));
    }
    prefixes.retain(|path| path.is_absolute());
    prefixes
}

/// Absolute folders in order, each once (case-insensitively on Windows).
pub fn merge_search_directories(lists: Vec<Vec<PathBuf>>) -> Vec<PathBuf> {
    let mut seen = BTreeSet::new();
    let mut merged = Vec::new();
    for directory in lists.into_iter().flatten() {
        if !directory.is_absolute() {
            continue;
        }
        let text = directory.to_string_lossy().trim_end_matches(['\\', '/']).to_string();
        let key = if cfg!(windows) { text.to_lowercase() } else { text };
        if seen.insert(key) {
            merged.push(directory);
        }
    }
    merged
}

#[cfg(windows)]
fn registry_path(user: bool) -> Option<String> {
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_NOEXPAND, RRF_RT_REG_EXPAND_SZ,
        RRF_RT_REG_SZ,
    };
    let (root, subkey) = if user {
        (HKEY_CURRENT_USER, "Environment")
    } else {
        (HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment")
    };
    let subkey = subkey.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let value = "Path".encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | RRF_NOEXPAND;
    let mut bytes = 0_u32;
    // SAFETY: valid NUL-terminated names; a null buffer asks only for the size.
    let status = unsafe {
        RegGetValueW(root, subkey.as_ptr(), value.as_ptr(), flags, std::ptr::null_mut(), std::ptr::null_mut(), &mut bytes)
    };
    if status != 0 || bytes == 0 || bytes > 256 * 1024 {
        return None;
    }
    let mut buffer = vec![0_u16; (bytes as usize).div_ceil(2) + 1];
    let mut capacity = (buffer.len() * 2) as u32;
    // SAFETY: `buffer` holds `capacity` bytes.
    let status = unsafe {
        RegGetValueW(
            root,
            subkey.as_ptr(),
            value.as_ptr(),
            flags,
            std::ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut capacity,
        )
    };
    if status != 0 {
        return None;
    }
    let end = buffer.iter().position(|unit| *unit == 0).unwrap_or(buffer.len());
    Some(String::from_utf16_lossy(&buffer[..end]))
}

#[cfg(not(windows))]
fn registry_path(_user: bool) -> Option<String> {
    None
}

/// Where an agent CLI may be installed right now.
/// - Windows: Editkin's own PATH, then the user and machine PATH as stored in the registry now (an installer that
///   ran after Editkin started only updates those), then `%USERPROFILE%\.local\bin`, npm's global prefix and
///   `%ProgramFiles%\nodejs`.
/// - macOS: Editkin's own PATH (launchd's short one when started from Finder), then what the login shell reports
///   (its PATH, `command -v claude/codex/node`, `npm config get prefix`), then `~/.local/bin`, `/opt/homebrew/bin`,
///   `/usr/local/bin`, `~/.npm-global/bin`, npm prefixes from the environment or `~/.npmrc`, `~/.claude/local`,
///   nvm and Volta.
pub fn agent_cli_search_directories() -> Vec<PathBuf> {
    let lookup = |name: &str| env::var(name).ok().filter(|value| !value.is_empty());
    let process = env::var_os("PATH")
        .map(|value| env::split_paths(&value).filter(|directory| directory.is_absolute()).collect::<Vec<_>>())
        .unwrap_or_default();
    let home = lookup(if cfg!(windows) { "USERPROFILE" } else { "HOME" });
    let npmrc = home
        .as_ref()
        .and_then(|home| fs::read(Path::new(home).join(".npmrc")).ok())
        .filter(|bytes| bytes.len() <= 64 * 1024)
        .map(|bytes| String::from_utf8_lossy(&bytes).to_string());
    if cfg!(windows) {
        let registry = [registry_path(true), registry_path(false)]
            .into_iter()
            .flatten()
            .flat_map(|list| path_list_directories(&list, &lookup))
            .collect::<Vec<_>>();
        let mut standard = home
            .iter()
            .map(|home| PathBuf::from(home).join(".local").join("bin"))
            .collect::<Vec<_>>();
        standard.extend(npm_global_prefixes(&lookup, npmrc.as_deref()));
        standard.extend(lookup("ProgramFiles").map(|programs| PathBuf::from(programs).join("nodejs")));
        merge_search_directories(vec![process, registry, standard])
    } else {
        let login = login_shell_directories().into_iter().map(PathBuf::from).collect();
        let prefixes = posix_npm_prefixes(&lookup, npmrc.as_deref(), home.as_deref());
        let mut standard = posix_standard_cli_directories(home.as_deref(), &prefixes);
        standard.extend(home.as_deref().map(version_manager_directories).unwrap_or_default());
        merge_search_directories(vec![process, login, standard.into_iter().map(PathBuf::from).collect()])
    }
}

/// What a candidate CLI file is, from its first bytes (and, on macOS, its execute permission). Only macOS uses it;
/// it stays compiled and tested everywhere.
#[cfg_attr(windows, allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CliFileKind {
    /// A native executable: run it directly.
    Binary,
    /// `#!…node`: run it through an absolute node.
    NodeScript,
    /// Another script (e.g. a shell wrapper): not run.
    OtherScript,
    /// Not executable: not run.
    NotExecutable,
}

#[cfg_attr(windows, allow(dead_code))]
pub fn classify_cli_head(head: &[u8], executable: bool) -> CliFileKind {
    if let Some(shebang) = head.strip_prefix(b"#!") {
        let line = shebang.split(|byte| *byte == b'\n').next().unwrap_or_default();
        let line = String::from_utf8_lossy(line);
        if line.split(|character: char| character == '/' || character.is_whitespace()).any(|word| word == "node") {
            return CliFileKind::NodeScript;
        }
        return CliFileKind::OtherScript;
    }
    if executable {
        CliFileKind::Binary
    } else {
        CliFileKind::NotExecutable
    }
}

/// The kind of the (already resolved, regular) file at `path`.
#[cfg_attr(windows, allow(dead_code))]
pub fn cli_file_kind(path: &Path) -> CliFileKind {
    use std::io::Read;
    let mut head = [0_u8; 256];
    let read = fs::File::open(path).and_then(|mut file| file.read(&mut head)).unwrap_or(0);
    #[cfg(unix)]
    let executable = {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(path).is_ok_and(|metadata| metadata.permissions().mode() & 0o111 != 0)
    };
    #[cfg(not(unix))]
    let executable = true;
    classify_cli_head(&head[..read], executable)
}

/// npm prefixes on macOS: NPM_CONFIG_PREFIX / npm_config_prefix, then `prefix=` lines in `~/.npmrc` (`~/` expanded).
pub fn posix_npm_prefixes(lookup: &dyn Fn(&str) -> Option<String>, user_npmrc: Option<&str>, home: Option<&str>) -> Vec<String> {
    let expand = |value: &str| -> String {
        let value = value.trim().trim_matches('"');
        match (value.strip_prefix("~/"), home) {
            (Some(rest), Some(home)) => format!("{}/{rest}", home.trim_end_matches('/')),
            _ => value.to_string(),
        }
    };
    let mut prefixes = Vec::new();
    for name in ["NPM_CONFIG_PREFIX", "npm_config_prefix"] {
        if let Some(value) = lookup(name).filter(|value| !value.trim().is_empty()) {
            prefixes.push(expand(&value));
        }
    }
    for line in user_npmrc.unwrap_or_default().lines() {
        if let Some((key, value)) = line.split_once('=') {
            if key.trim().eq_ignore_ascii_case("prefix") && !value.trim().is_empty() {
                prefixes.push(expand(value));
            }
        }
    }
    prefixes.retain(|prefix| prefix.starts_with('/'));
    prefixes
}

/// The standard macOS install folders of Claude Code, Codex and node, in search order.
pub fn posix_standard_cli_directories(home: Option<&str>, npm_prefixes: &[String]) -> Vec<String> {
    let home = home.map(|home| home.trim_end_matches('/')).filter(|home| home.starts_with('/'));
    let mut directories = Vec::new();
    if let Some(home) = home {
        directories.push(format!("{home}/.local/bin"));
    }
    directories.push("/opt/homebrew/bin".to_string());
    directories.push("/usr/local/bin".to_string());
    if let Some(home) = home {
        directories.push(format!("{home}/.npm-global/bin"));
    }
    directories.extend(npm_prefixes.iter().map(|prefix| format!("{}/bin", prefix.trim_end_matches('/'))));
    if let Some(home) = home {
        directories.push(format!("{home}/.claude/local"));
        directories.push(format!("{home}/.claude/local/node_modules/.bin"));
    }
    directories
}

/// Node version managers keep global npm installs out of every standard folder: `~/.volta/bin` and each nvm
/// `~/.nvm/versions/node/<version>/bin`, newest version first.
fn version_manager_directories(home: &str) -> Vec<String> {
    let home = home.trim_end_matches('/');
    let mut directories = vec![format!("{home}/.volta/bin")];
    let mut versions = fs::read_dir(Path::new(home).join(".nvm").join("versions").join("node"))
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|entry| entry.file_name().to_string_lossy().to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    versions.sort_by_key(|version| {
        version
            .trim_start_matches('v')
            .split('.')
            .map(|part| part.parse::<u64>().unwrap_or(0))
            .collect::<Vec<_>>()
    });
    versions.reverse();
    directories.extend(versions.iter().map(|version| format!("{home}/.nvm/versions/node/{version}/bin")));
    directories
}

/// What a login shell prints for LOGIN_SHELL_PROBE, as folders: the folders of `command -v` hits first, then its
/// PATH, then `<npm prefix>/bin`.
pub fn parse_login_shell_report(report: &str) -> Vec<String> {
    let (mut commands, mut path, mut npm) = (Vec::new(), Vec::new(), Vec::new());
    for line in report.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(list) = line.strip_prefix("PATH=") {
            path.extend(list.split(':').filter(|entry| entry.starts_with('/')).map(str::to_string));
        } else if let Some(command) = line.strip_prefix("CMD=").filter(|command| command.starts_with('/')) {
            if let Some((parent, _)) = command.rsplit_once('/') {
                commands.push(if parent.is_empty() { "/".to_string() } else { parent.to_string() });
            }
        } else if let Some(prefix) = line.strip_prefix("NPM_PREFIX=") {
            let prefix = prefix.trim().trim_end_matches('/');
            if prefix.starts_with('/') {
                npm.push(format!("{prefix}/bin"));
            }
        }
    }
    commands.into_iter().chain(path).chain(npm).collect()
}

/// Run by the user's login shell, as Terminal starts it: aliases from .zshrc do not apply (non-interactive), so only
/// absolute `command -v` answers count.
const LOGIN_SHELL_PROBE: &str = "printf 'PATH=%s\\n' \"$PATH\"; \
for c in claude codex node; do p=$(command -v \"$c\" 2>/dev/null) && printf 'CMD=%s\\n' \"$p\"; done; \
p=$(npm config get prefix 2>/dev/null) && printf 'NPM_PREFIX=%s\\n' \"$p\"; printf 'END\\n'; exit 0";
const LOGIN_SHELL_TIMEOUT: Duration = Duration::from_secs(8);
const LOGIN_SHELL_CACHE: Duration = Duration::from_secs(15);

fn run_login_shell_probe() -> Option<String> {
    use std::io::{BufRead, BufReader};
    let shell = ["/bin/zsh", "/bin/bash"].into_iter().find(|shell| Path::new(shell).is_file())?;
    let mut child = std::process::Command::new(shell)
        .args(["-lc", LOGIN_SHELL_PROBE])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut report = String::new();
        // Stop at END: a program the profile started in the background may keep the pipe open.
        for line in BufReader::new(stdout).lines().map_while(Result::ok).take(4096) {
            if line == "END" {
                break;
            }
            report.push_str(&line);
            report.push('\n');
        }
        let _ = sender.send(report);
    });
    let report = receiver.recv_timeout(LOGIN_SHELL_TIMEOUT).ok();
    let _ = child.kill();
    let _ = child.wait();
    report
}

/// The login shell's folders, asked at most once every 15 seconds (one connect screen checks both CLIs).
fn login_shell_directories() -> Vec<String> {
    static CACHE: std::sync::Mutex<Option<(Instant, Vec<String>)>> = std::sync::Mutex::new(None);
    let mut cache = CACHE.lock().unwrap_or_else(|error| error.into_inner());
    if let Some((asked, directories)) = cache.as_ref() {
        if asked.elapsed() < LOGIN_SHELL_CACHE {
            return directories.clone();
        }
    }
    let directories = run_login_shell_probe()
        .map(|report| parse_login_shell_report(&report))
        .unwrap_or_default();
    *cache = Some((Instant::now(), directories.clone()));
    directories
}

// ---- keeping the connection valid across Editkin updates ------------------------------------------------------

/// Serialises generation activation between the start-up repair and a connect.
fn generation_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|error| error.into_inner())
}

/// The installed runtime as the generation records it (the same roles a connect activates).
pub fn product_generation_paths(runtime: &crate::RuntimePaths) -> ProductAgentGenerationPaths {
    ProductAgentGenerationPaths {
        resource_root: runtime.resource_root.clone(),
        embedded_contract: runtime.agent_contract.clone(),
        entrypoint: runtime.mcp.clone(),
        entrypoint_identity: runtime.mcp_identity.clone(),
        ffmpeg: runtime.ffmpeg.clone(),
        ffprobe: runtime.ffprobe.clone(),
        gpu_compositor: runtime.gpu_compositor.clone(),
        launcher: runtime.agent_launcher.clone(),
        native_core: runtime.native_core.clone(),
        node: runtime.node.clone(),
        node_manifest: runtime.node_manifest.clone(),
        whisper: runtime.whisper_cli.clone(),
        color: runtime.color_root.clone(),
        creative_pack: runtime.creative_pack_root.clone(),
        fonts: runtime.font_root.clone(),
        personal_music: runtime.personal_music_root.clone(),
        personal_visual: runtime.personal_visual_root.clone(),
        plugins: runtime.plugin_roots.first().cloned().unwrap_or_default(),
    }
}

/// Re-activates a generation that still records an older release's files. Touches only Editkin's agent state
/// folder: Claude Code's / Codex's configuration points at node.exe + the stable launcher and stays as it is.
pub fn repair_agent_generation_now(app: &AppHandle) -> Result<crate::agent_setup::GenerationRepair, String> {
    let contract = crate::editkin_agent_setup_contract()?;
    let state_directory = crate::editkin_agent_launcher_contract(&contract)?
        .get("stateDirectoryName")
        .and_then(Value::as_str)
        .unwrap_or("agent-runtime-v3")
        .to_string();
    let state_root = crate::application_data_root(app)?.join(state_directory);
    let runtime = crate::runtime_paths(app)?;
    let _generation = generation_lock();
    crate::agent_setup::repair_product_agent_generation(
        &state_root,
        &product_generation_paths(&runtime),
        crate::EDITKIN_AGENT_SETUP_CONTRACT.as_bytes(),
    )
}

fn runtime_repair_state() -> &'static std::sync::Mutex<Value> {
    static STATE: std::sync::OnceLock<std::sync::Mutex<Value>> = std::sync::OnceLock::new();
    STATE.get_or_init(|| std::sync::Mutex::new(json!({ "state": "pending" })))
}

/// `{ state: "pending" | "ok" | "failed", failure? }` of the start-up repair, for inspect_agent_connections.
/// `failed` carries the same structured failure as a setup (step prepare_runtime, code RUNTIME_PROBE_FAILED):
/// the UI's 「更新後要重新連一次」 with one connect button.
pub fn agent_runtime_repair_status() -> Value {
    runtime_repair_state().lock().unwrap_or_else(|error| error.into_inner()).clone()
}

/// Runs the repair once at start-up without blocking the window. Silent on success.
pub fn repair_agent_generation_in_background(app: AppHandle) {
    let spawned = std::thread::Builder::new()
        .name("agent-generation-repair".into())
        .spawn(move || {
            let outcome = repair_agent_generation_now(&app);
            let status = match outcome {
                Ok(crate::agent_setup::GenerationRepair::Repaired { pointer_identity }) => {
                    let mut log = ConnectLog::open(
                        crate::application_data_root(&app).ok().map(|root| root.join("logs")),
                        "startup-repair",
                        user_profile(&app),
                    );
                    log.line(&format!(
                        "the active generation recorded files from another release; re-activated from the installed files (pointer {pointer_identity}); agent configuration untouched"
                    ));
                    json!({ "state": "ok", "repaired": true })
                }
                Ok(_) => json!({ "state": "ok", "repaired": false }),
                Err(error) => {
                    let profile = user_profile(&app);
                    let mut log = ConnectLog::open(
                        crate::application_data_root(&app).ok().map(|root| root.join("logs")),
                        "startup-repair",
                        profile.clone(),
                    );
                    log.line(&format!("re-activating the agent generation after an update failed: {error}"));
                    let failure = SetupFailure::new(
                        SetupStep::PrepareRuntime,
                        FailureCode::RuntimeProbeFailed,
                        &format!("Editkin could not refresh its agent runtime after an update: {error}"),
                        profile.as_deref(),
                        log.path(),
                    );
                    json!({
                        "state": "failed",
                        "message": "Editkin 更新後要重新連一次 AI。",
                        "failure": serde_json::to_value(&failure).unwrap_or(Value::Null),
                    })
                }
            };
            *runtime_repair_state().lock().unwrap_or_else(|error| error.into_inner()) = status;
        });
    if let Err(error) = spawned {
        *runtime_repair_state().lock().unwrap_or_else(|error| error.into_inner()) =
            json!({ "state": "failed", "message": format!("Editkin 更新後要重新連一次 AI。（{error}）") });
    }
}

fn rollback_note(generation: &crate::agent_setup::ProductAgentGenerationActivation) -> String {
    rollback_product_agent_generation(generation)
        .map(|()| "generation rollback complete".to_string())
        .unwrap_or_else(|error| format!("generation rollback failed: {error}"))
}

#[cfg(test)]
#[path = "agent_connect_tests.rs"]
mod tests;
