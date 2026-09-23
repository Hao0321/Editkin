use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    io::Read,
    path::Path,
};

pub const REMOTE_AGENT_TRUTH_LABEL: &str =
    "WINDOWS_INTERNAL_AGENT_LAUNCH_CANDIDATE_NOT_REAL_PHONE_OR_MAC_VERIFIED";
pub const REMOTE_AGENT_TIMEOUT_SECONDS: u64 = 300;
pub const REMOTE_AGENT_OUTPUT_LIMIT_BYTES: usize = 128 * 1024;

pub struct CodexClosedMcp<'a> {
    pub command: &'a Path,
    pub launcher: &'a Path,
    pub environment: &'a [(String, String)],
}

fn toml_basic_string(value: &str, label: &str) -> Result<String, String> {
    if value.is_empty() || value.chars().any(char::is_control) {
        return Err(format!("{label} 不可為空或包含控制字元"));
    }
    let mut encoded = String::with_capacity(value.len() + 2);
    encoded.push('"');
    for character in value.chars() {
        match character {
            '\\' => encoded.push_str("\\\\"),
            '"' => encoded.push_str("\\\""),
            _ => encoded.push(character),
        }
    }
    encoded.push('"');
    Ok(encoded)
}

fn codex_closed_mcp_overrides(config: &CodexClosedMcp<'_>) -> Result<Vec<OsString>, String> {
    let command = config
        .command
        .to_str()
        .ok_or("Codex Editkin command path 不是 UTF-8")?;
    let launcher = config
        .launcher
        .to_str()
        .ok_or("Codex Editkin launcher path 不是 UTF-8")?;
    if !config.command.is_absolute()
        || !config.command.is_file()
        || !config.launcher.is_absolute()
        || !config.launcher.is_file()
    {
        return Err("Codex closed-world MCP 只接受存在的絕對 command／launcher 檔案".into());
    }
    let mut seen = BTreeSet::new();
    let mut fields = Vec::with_capacity(config.environment.len());
    for (key, value) in config.environment {
        if key.is_empty()
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
            || !seen.insert(key)
        {
            return Err("Codex closed-world MCP environment key 不合法或重複".into());
        }
        fields.push(format!(
            "{key}={}",
            toml_basic_string(value, "Codex MCP environment value")?
        ));
    }
    if fields.is_empty() {
        return Err("Codex closed-world MCP environment 不可為空".into());
    }
    let values = [
        format!(
            "mcp_servers.editkin.command={}",
            toml_basic_string(command, "Codex MCP command")?
        ),
        format!(
            "mcp_servers.editkin.args=[{}]",
            toml_basic_string(launcher, "Codex MCP launcher")?
        ),
        format!("mcp_servers.editkin.env={{{}}}", fields.join(",")),
        concat!(
            "mcp_servers.editkin.enabled_tools=[",
            "\"get_remote_setup_status\",",
            "\"list_remote_provider_connectors\",",
            "\"prepare_remote_setup\",",
            "]"
        )
        .to_string(),
        "mcp_servers.editkin.default_tools_approval_mode=\"auto\"".to_string(),
        "mcp_servers.editkin.required=true".to_string(),
    ];
    let mut result = Vec::with_capacity(values.len() * 2);
    for value in values {
        result.push(OsString::from("-c"));
        result.push(OsString::from(value));
    }
    Ok(result)
}

fn claude_closed_mcp_config(config: &CodexClosedMcp<'_>) -> Result<String, String> {
    let command = config
        .command
        .to_str()
        .ok_or("Claude Editkin command path 不是 UTF-8")?;
    let launcher = config
        .launcher
        .to_str()
        .ok_or("Claude Editkin launcher path 不是 UTF-8")?;
    if !config.command.is_absolute()
        || !config.command.is_file()
        || !config.launcher.is_absolute()
        || !config.launcher.is_file()
    {
        return Err("Claude closed-world MCP 只接受存在的絕對 command／launcher 檔案".into());
    }
    let mut environment = BTreeMap::new();
    for (key, value) in config.environment {
        if key.is_empty()
            || !key
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
            || value.is_empty()
            || value.chars().any(char::is_control)
            || environment.insert(key, value).is_some()
        {
            return Err("Claude closed-world MCP environment key/value 不合法或重複".into());
        }
    }
    if environment.is_empty() {
        return Err("Claude closed-world MCP environment 不可為空".into());
    }
    serde_json::to_string(&json!({
        "mcpServers": {
            "editkin": {
                "type": "stdio",
                "command": command,
                "args": [launcher],
                "env": environment,
            }
        }
    }))
    .map_err(|error| format!("Claude closed-world MCP JSON 產生失敗：{error}"))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RemoteAgentTarget {
    Codex,
    Claude,
}

impl RemoteAgentTarget {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "codex" => Ok(Self::Codex),
            "claude" => Ok(Self::Claude),
            _ => Err("Remote AI 只支援 Codex 或 Claude Code".into()),
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::Claude => "Claude Code",
        }
    }

    pub fn login_probe_args(self) -> Vec<String> {
        match self {
            Self::Codex => ["login", "status"].map(str::to_string).to_vec(),
            Self::Claude => [
                "--setting-sources",
                "",
                "--strict-mcp-config",
                "--mcp-config",
                "{}",
                "--disable-slash-commands",
                "--no-chrome",
                "auth",
                "status",
                "--json",
            ]
            .map(str::to_string)
            .to_vec(),
        }
    }

    /// The prompt is always supplied through stdin. No shell is involved and
    /// no prompt-derived text is ever appended to the command line.
    pub fn launch_args(
        self,
        workspace: &Path,
        codex_mcp: Option<&CodexClosedMcp<'_>>,
    ) -> Result<Vec<OsString>, String> {
        let workspace = workspace
            .to_str()
            .filter(|value| !value.trim().is_empty() && !value.chars().any(char::is_control))
            .ok_or("Remote AI 工作資料夾無法安全傳給 CLI")?;
        let mut values = match self {
            Self::Codex => vec![
                "--ask-for-approval".into(),
                "never".into(),
                "--search".into(),
                "--sandbox".into(),
                "read-only".into(),
                "--disable".into(),
                "plugins".into(),
                "--disable".into(),
                "shell_tool".into(),
                "--disable".into(),
                "unified_exec".into(),
                "--disable".into(),
                "apps".into(),
                "--disable".into(),
                "in_app_browser".into(),
                "--disable".into(),
                "browser_use".into(),
                "--disable".into(),
                "computer_use".into(),
                "--disable".into(),
                "codex_hooks".into(),
                "--disable".into(),
                "shell_snapshot".into(),
                "--disable".into(),
                "image_generation".into(),
                "--disable".into(),
                "multi_agent".into(),
                "--disable".into(),
                "tool_suggest".into(),
                "--disable".into(),
                "tool_search".into(),
                "--disable".into(),
                "workspace_dependencies".into(),
                "--disable".into(),
                "skill_mcp_dependency_install".into(),
                "--disable".into(),
                "tool_call_mcp_elicitation".into(),
                "--disable".into(),
                "unavailable_dummy_tools".into(),
                "exec".into(),
                "--ignore-user-config".into(),
                "--json".into(),
                "--ephemeral".into(),
                "--ignore-rules".into(),
                "--cd".into(),
                workspace.into(),
                "--skip-git-repo-check".into(),
            ],
            Self::Claude => {
                let tools = [
                    "WebSearch",
                    "WebFetch",
                    "mcp__editkin__get_remote_setup_status",
                    "mcp__editkin__list_remote_provider_connectors",
                    "mcp__editkin__prepare_remote_setup",
                ]
                .join(",");
                vec![
                    "--setting-sources".into(),
                    "".into(),
                    "--settings".into(),
                    r#"{"autoMemoryEnabled":false,"disableAllHooks":true,"disableAgentView":true,"disableDeepLinkRegistration":"disable"}"#.into(),
                    "--strict-mcp-config".into(),
                    "--mcp-config".into(),
                    claude_closed_mcp_config(
                        codex_mcp.ok_or("BLOCK_SCOPE_NOT_CLOSED: missing Claude MCP config")?,
                    )?,
                    "--disable-slash-commands".into(),
                    "--no-chrome".into(),
                    "--print".into(),
                    "--verbose".into(),
                    "--input-format".into(),
                    "text".into(),
                    "--output-format".into(),
                    "stream-json".into(),
                    "--permission-mode".into(),
                    "dontAsk".into(),
                    "--no-session-persistence".into(),
                    "--tools".into(),
                    tools.clone(),
                    "--allowedTools".into(),
                    tools,
                    "--max-turns".into(),
                    "8".into(),
                ]
            }
        };
        let mut result = values.drain(..).map(OsString::from).collect::<Vec<_>>();
        if self == Self::Codex {
            let config = codex_mcp.ok_or("BLOCK_SCOPE_NOT_CLOSED: missing Codex MCP override")?;
            result.extend(codex_closed_mcp_overrides(config)?);
            result.push(OsString::from("-"));
        }
        Ok(result)
    }
}

pub fn login_probe_is_ready(
    target: RemoteAgentTarget,
    success: bool,
    stdout: &[u8],
    stderr: &[u8],
) -> bool {
    if !success || stdout.len() > 64 * 1024 || !stderr.is_empty() {
        return false;
    }
    match target {
        RemoteAgentTarget::Codex => {
            let normalized = String::from_utf8_lossy(stdout).trim().to_ascii_lowercase();
            matches!(
                normalized.as_str(),
                "logged in using chatgpt"
                    | "logged in using an api key"
                    | "logged in using api key"
                    | "authenticated"
            )
        }
        RemoteAgentTarget::Claude => {
            serde_json::from_slice::<Value>(stdout)
                .ok()
                .and_then(|value| value.get("loggedIn").and_then(Value::as_bool))
                == Some(true)
        }
    }
}

pub fn remote_agent_task_prompt() -> &'static str {
    concat!(
        "你是由 Editkin 使用者明確同意後啟動的 bounded Remote 設定助手。",
        "只處理 Editkin Remote，不剪片、不修改專案；不得要求、讀取、複製、顯示或保存 API key、token、cookie、密碼與登入資料。Editkin 只檢查並立即丟棄 CLI 回報的 loggedIn 狀態；Claude CLI 仍會讀取自己的既有登入。",
        "先呼叫 Editkin MCP 的 get_remote_setup_status，再呼叫唯讀 list_remote_provider_connectors。",
        "若狀態是 LAN_DEFAULT，只能從 Editkin closed registry 選擇 connector，依使用者地區、既有帳戶、公開價格、免費額度與延遲研究，再呼叫 prepare_remote_setup 建立一份綁定 connector identity 與 exact plan digest、含來源、價格、配額、權限與預計異動的 proposal v2。disabled 或 unsupported connector 只能研究，不能核准或執行。",
        "若狀態是 PROPOSAL_EXPIRED，重新查核後必須帶入狀態中的 exact expectedExpiredProposalRevision 才能更新；不得跳過 CAS。",
        "若狀態已有 PROPOSAL_READY_NOT_APPROVED、legacy confirmation、桌面候選或正式設定，不得覆寫、設定或驗證，只提醒使用者回 Editkin 檢視目前狀態。",
        "本次只有研究階段：不得呼叫 configure_remote_access 或 verify_remote_access，不得登入供應商、執行 shell 或 provider CLI、部署、付款、建立公開資源或修改正式設定。",
        "完成有效 proposal 後清楚說明尚未核准、尚未登入、尚未部署、尚未連線，然後停止。",
        "任何工具被拒絕、MCP 不可用或登入狀態不確定都要 fail closed。"
    )
}

pub struct RemoteVerificationContext<'a> {
    pub configuration_id: &'a str,
    pub probe_id: &'a str,
    pub runtime_instance_id: &'a str,
    pub process_id: u32,
    pub runtime_started_at_ms: u128,
    pub launch_started_at_ms: u128,
    pub now_ms: u128,
}

pub fn remote_verification_matches(value: &Value, context: &RemoteVerificationContext<'_>) -> bool {
    let expected_keys = [
        "configurationId",
        "endpointKind",
        "jitterMs",
        "latencyMs",
        "latencyP50Ms",
        "processId",
        "probeId",
        "reconnectVerified",
        "requiresActiveMobileProof",
        "routeEvidence",
        "runtimeInstanceId",
        "schema",
        "startedAtMs",
        "status",
        "successfulTlsConnections",
        "verified",
        "verifiedAt",
        "verifiedAtMs",
    ]
    .into_iter()
    .collect::<BTreeSet<_>>();
    let actual_keys = value
        .as_object()
        .map(|object| object.keys().map(String::as_str).collect::<BTreeSet<_>>())
        .unwrap_or_default();
    let verified_at = value
        .get("verifiedAtMs")
        .and_then(Value::as_u64)
        .map(u128::from)
        .unwrap_or(0);
    actual_keys == expected_keys
        && verified_at >= context.launch_started_at_ms
        && verified_at > context.runtime_started_at_ms
        && verified_at <= context.now_ms.saturating_add(60_000)
        && context.now_ms.saturating_sub(verified_at) <= 15 * 60 * 1_000
        && value.get("schema").and_then(Value::as_str)
            == Some("editkin.remote-route-verification/v3")
        && value.get("configurationId").and_then(Value::as_str) == Some(context.configuration_id)
        && value.get("probeId").and_then(Value::as_str) == Some(context.probe_id)
        && value.get("runtimeInstanceId").and_then(Value::as_str)
            == Some(context.runtime_instance_id)
        && value.get("processId").and_then(Value::as_u64) == Some(u64::from(context.process_id))
        && value.get("startedAtMs").and_then(Value::as_u64)
            == u64::try_from(context.runtime_started_at_ms).ok()
        && value.get("status").and_then(Value::as_str) == Some("PARTIAL")
        && value.get("verified").and_then(Value::as_bool) == Some(false)
        && value
            .get("verifiedAt")
            .and_then(Value::as_str)
            .is_some_and(|value| !value.trim().is_empty())
        && value.get("endpointKind").and_then(Value::as_str) == Some("editkin-tunnel")
        && value
            .get("successfulTlsConnections")
            .and_then(Value::as_u64)
            == Some(2)
        && value
            .get("latencyMs")
            .and_then(Value::as_array)
            .is_some_and(|latencies| {
                latencies.len() == 2
                    && latencies.iter().all(|latency| {
                        latency
                            .as_f64()
                            .is_some_and(|latency| latency.is_finite() && latency >= 0.0)
                    })
            })
        && value.get("routeEvidence").and_then(Value::as_str)
            == Some("two-pinned-independent-tls-connections-succeeded")
        && value.get("reconnectVerified").and_then(Value::as_bool) == Some(false)
        && value
            .get("requiresActiveMobileProof")
            .and_then(Value::as_bool)
            == Some(true)
        && value
            .get("latencyP50Ms")
            .and_then(Value::as_f64)
            .is_some_and(|latency| latency.is_finite() && latency >= 0.0)
        && value
            .get("jitterMs")
            .and_then(Value::as_f64)
            .is_some_and(|jitter| jitter.is_finite() && jitter >= 0.0)
}

#[derive(Debug)]
pub struct BoundedCapture {
    pub bytes: Vec<u8>,
    pub observed_bytes: u64,
    pub truncated: bool,
    pub read_error: Option<String>,
}

pub fn read_bounded(mut reader: Box<dyn Read + Send>, limit: usize) -> BoundedCapture {
    let mut kept = Vec::with_capacity(limit.min(16 * 1024));
    let mut observed = 0_u64;
    let mut buffer = [0_u8; 8 * 1024];
    let mut read_error = None;
    loop {
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Err(error) => {
                read_error = Some(error.to_string());
                break;
            }
            Ok(count) => {
                observed = observed.saturating_add(count as u64);
                if kept.len() < limit {
                    let remaining = limit - kept.len();
                    kept.extend_from_slice(&buffer[..count.min(remaining)]);
                }
            }
        }
    }
    BoundedCapture {
        truncated: observed > kept.len() as u64,
        bytes: kept,
        observed_bytes: observed,
        read_error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{self, Cursor};

    struct FailingReader;

    impl Read for FailingReader {
        fn read(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::other("fixture read failure"))
        }
    }

    #[test]
    fn launch_contract_uses_stdin_and_bounded_permissions() {
        let workspace = Path::new(r"C:\Editkin Work & Media");
        let root = std::env::temp_dir().join(format!(
            "editkin-codex-closed-world-{}-Unicode-測試",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let command = std::env::current_exe().unwrap();
        let launcher = root.join("launcher 測試.mjs");
        std::fs::write(&launcher, b"fixture").unwrap();
        let environment = vec![
            ("EDITKIN_WORKSPACE".to_string(), r"C:\剪輯\素材".to_string()),
            ("SAFE_VALUE".to_string(), "quote\"and\\slash".to_string()),
        ];
        let config = CodexClosedMcp {
            command: &command,
            launcher: &launcher,
            environment: &environment,
        };
        let codex = RemoteAgentTarget::Codex
            .launch_args(workspace, Some(&config))
            .unwrap();
        let codex = codex
            .iter()
            .map(|value| value.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        assert!(codex.iter().any(|value| value == "--ignore-user-config"));
        assert!(codex.iter().any(|value| value == "--ignore-rules"));
        assert!(codex
            .windows(2)
            .any(|pair| pair == ["--disable", "plugins"]));
        assert!(codex
            .windows(2)
            .any(|pair| pair == ["--sandbox", "read-only"]));
        assert!(codex
            .windows(2)
            .any(|pair| pair == ["--disable", "shell_tool"]));
        assert!(codex
            .windows(2)
            .any(|pair| pair == ["--disable", "unified_exec"]));
        let disabled = codex
            .windows(2)
            .filter_map(|pair| (pair[0] == "--disable").then_some(pair[1].as_str()))
            .collect::<BTreeSet<_>>();
        assert_eq!(
            disabled,
            [
                "apps",
                "browser_use",
                "codex_hooks",
                "computer_use",
                "image_generation",
                "in_app_browser",
                "multi_agent",
                "plugins",
                "shell_snapshot",
                "shell_tool",
                "skill_mcp_dependency_install",
                "tool_call_mcp_elicitation",
                "tool_suggest",
                "tool_search",
                "unified_exec",
                "unavailable_dummy_tools",
                "workspace_dependencies",
            ]
            .into_iter()
            .collect()
        );
        assert!(codex
            .windows(2)
            .any(|pair| pair == ["--ask-for-approval", "never"]));
        let search_position = codex.iter().position(|value| value == "--search").unwrap();
        let exec_position = codex.iter().position(|value| value == "exec").unwrap();
        assert!(
            search_position < exec_position,
            "--search must remain a global Codex option"
        );
        assert_eq!(codex.last().map(String::as_str), Some("-"));
        assert_eq!(
            codex
                .iter()
                .filter(|value| value.starts_with("mcp_servers.editkin."))
                .count(),
            6
        );
        assert!(!codex.iter().any(|value| {
            value.starts_with("mcp_servers.") && !value.starts_with("mcp_servers.editkin.")
        }));
        let encoded = codex.join("\n");
        assert!(encoded.contains("get_remote_setup_status"));
        assert!(encoded.contains("list_remote_provider_connectors"));
        assert!(encoded.contains("prepare_remote_setup"));
        assert!(!encoded.contains("verify_remote_access"));
        assert!(!encoded.contains("configure_remote_access"));
        assert!(encoded.contains("Unicode-測試"));
        assert!(encoded.contains(r#"quote\"and\\slash"#));
        assert!(!encoded.contains(remote_agent_task_prompt()));
        assert!(!encoded.to_ascii_lowercase().contains("auth.json"));
        assert!(!encoded.to_ascii_lowercase().contains("api_key"));
        let claude = RemoteAgentTarget::Claude
            .launch_args(workspace, Some(&config))
            .unwrap();
        let claude = claude
            .iter()
            .map(|value| value.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        assert!(claude
            .windows(2)
            .any(|pair| pair == ["--permission-mode", "dontAsk"]));
        assert!(claude
            .windows(2)
            .any(|pair| pair == ["--output-format", "stream-json"]));
        assert!(claude.iter().any(|value| value == "--verbose"));
        assert!(claude
            .windows(2)
            .any(|pair| pair == ["--setting-sources", ""]));
        let settings_position = claude
            .iter()
            .position(|value| value == "--settings")
            .unwrap();
        let settings: Value = serde_json::from_str(&claude[settings_position + 1]).unwrap();
        assert_eq!(
            settings,
            json!({
                "autoMemoryEnabled": false,
                "disableAllHooks": true,
                "disableAgentView": true,
                "disableDeepLinkRegistration": "disable",
            })
        );
        assert!(claude.iter().any(|value| value == "--strict-mcp-config"));
        assert!(claude
            .iter()
            .any(|value| value == "--disable-slash-commands"));
        assert!(claude.iter().any(|value| value == "--no-chrome"));
        assert!(!claude.iter().any(|value| value == "--add-dir"));
        let config_position = claude
            .iter()
            .position(|value| value == "--mcp-config")
            .unwrap();
        let closed_config: Value = serde_json::from_str(&claude[config_position + 1]).unwrap();
        assert_eq!(
            closed_config["mcpServers"]
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            vec!["editkin"]
        );
        let encoded_claude = claude.join("\n").to_ascii_lowercase();
        assert!(!encoded_claude.contains("plugin"));
        assert!(!encoded_claude.contains("auth.json"));
        assert!(!encoded_claude.contains("api_key"));
        assert!(!claude
            .iter()
            .any(|value| value.contains("configure_remote_access")));
        assert!(claude
            .iter()
            .any(|value| value.contains("mcp__editkin__list_remote_provider_connectors")));
        assert!(!claude
            .iter()
            .any(|value| value.contains("verify_remote_access")));
        assert!(!claude.iter().any(|value| value.contains("Bash")));

        let claude_login = RemoteAgentTarget::Claude.login_probe_args();
        assert!(claude_login
            .windows(2)
            .any(|pair| pair == ["--setting-sources", ""]));
        assert!(claude_login
            .iter()
            .any(|value| value == "--strict-mcp-config"));
        assert!(claude_login
            .windows(2)
            .any(|pair| pair == ["--mcp-config", "{}"]));
        let _ = std::fs::remove_file(&launcher);
        let _ = std::fs::remove_dir(&root);
    }

    #[test]
    fn codex_toml_encoder_rejects_empty_control_and_duplicate_values() {
        assert!(toml_basic_string("", "fixture").is_err());
        assert!(toml_basic_string("line\nbreak", "fixture").is_err());
        assert!(toml_basic_string("nul\0byte", "fixture").is_err());
        assert_eq!(
            toml_basic_string("C:\\路徑\\\"quoted\"", "fixture").unwrap(),
            r#""C:\\路徑\\\"quoted\"""#
        );

        let executable = std::env::current_exe().unwrap();
        let environment = vec![
            ("DUPLICATE".to_string(), "one".to_string()),
            ("DUPLICATE".to_string(), "two".to_string()),
        ];
        let config = CodexClosedMcp {
            command: &executable,
            launcher: &executable,
            environment: &environment,
        };
        assert!(codex_closed_mcp_overrides(&config).is_err());
    }

    #[test]
    fn login_readiness_fails_closed_without_exact_success_evidence() {
        assert!(login_probe_is_ready(
            RemoteAgentTarget::Codex,
            true,
            b"Logged in using ChatGPT",
            b""
        ));
        assert!(!login_probe_is_ready(
            RemoteAgentTarget::Codex,
            false,
            b"Logged in using ChatGPT",
            b""
        ));
        assert!(!login_probe_is_ready(
            RemoteAgentTarget::Codex,
            true,
            b"Logged in using ChatGPT",
            b"configuration warning"
        ));
        for false_positive in [
            b"Not logged in".as_slice(),
            b"Unauthenticated".as_slice(),
            b"Logged in failed".as_slice(),
            b"Authenticated with warning".as_slice(),
        ] {
            assert!(!login_probe_is_ready(
                RemoteAgentTarget::Codex,
                true,
                false_positive,
                b""
            ));
        }
        assert!(login_probe_is_ready(
            RemoteAgentTarget::Codex,
            true,
            b"Authenticated",
            b""
        ));
        assert!(login_probe_is_ready(
            RemoteAgentTarget::Claude,
            true,
            br#"{"loggedIn":true,"email":"never returned by Editkin"}"#,
            b""
        ));
        assert!(!login_probe_is_ready(
            RemoteAgentTarget::Claude,
            true,
            br#"{"loggedIn":false}"#,
            b""
        ));
        assert!(!login_probe_is_ready(
            RemoteAgentTarget::Claude,
            true,
            b"not-json",
            b""
        ));
    }

    #[test]
    fn output_reader_drains_but_keeps_only_the_fixed_budget() {
        let capture = read_bounded(Box::new(Cursor::new(vec![b'x'; 2048])), 128);
        assert_eq!(capture.bytes.len(), 128);
        assert_eq!(capture.observed_bytes, 2048);
        assert!(capture.truncated);
        let failed = read_bounded(Box::new(FailingReader), 128);
        assert!(failed.bytes.is_empty());
        assert!(!failed.truncated);
        assert!(failed
            .read_error
            .as_deref()
            .is_some_and(|error| error.contains("fixture")));
    }

    #[test]
    fn post_state_verification_requires_fresh_runtime_bound_receipt() {
        let context = RemoteVerificationContext {
            configuration_id: "configuration",
            probe_id: "probe",
            runtime_instance_id: "runtime",
            process_id: 42,
            runtime_started_at_ms: 1_000,
            launch_started_at_ms: 1_100,
            now_ms: 1_300,
        };
        let receipt = serde_json::json!({
            "schema": "editkin.remote-route-verification/v3",
            "configurationId": "configuration",
            "status": "PARTIAL",
            "verified": false,
            "verifiedAt": "2026-09-05T00:00:00.000Z",
            "verifiedAtMs": 1200,
            "probeId": "probe",
            "runtimeInstanceId": "runtime",
            "processId": 42,
            "startedAtMs": 1000,
            "endpointKind": "editkin-tunnel",
            "successfulTlsConnections": 2,
            "latencyMs": [30, 34],
            "latencyP50Ms": 32.0,
            "jitterMs": 4.0,
            "routeEvidence": "two-pinned-independent-tls-connections-succeeded",
            "reconnectVerified": false,
            "requiresActiveMobileProof": true
        });
        assert!(remote_verification_matches(&receipt, &context));
        let mut stale = receipt.clone();
        stale["verifiedAtMs"] = Value::from(1_050_u64);
        assert!(!remote_verification_matches(&stale, &context));
        let mut wrong_runtime = receipt;
        wrong_runtime["runtimeInstanceId"] = Value::from("other");
        assert!(!remote_verification_matches(&wrong_runtime, &context));
    }
}
