use serde_json::{json, Value};
use std::{
    collections::{BTreeSet, VecDeque},
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

/// The last bytes of the probed server's stderr kept for the setup failure and log. A launcher that throws before
/// answering prints its reason here; without it a user only ever saw "timed out".
const PROBE_STDERR_TAIL_BYTES: usize = 16 * 1024;

#[cfg(windows)]
trait HiddenCommand {
    fn hidden(&mut self) -> &mut Self;
}

#[cfg(windows)]
impl HiddenCommand for Command {
    fn hidden(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        self.creation_flags(0x08000000)
    }
}

#[cfg(not(windows))]
trait HiddenCommand {
    fn hidden(&mut self) -> &mut Self;
}

#[cfg(not(windows))]
impl HiddenCommand for Command {
    fn hidden(&mut self) -> &mut Self {
        self
    }
}

#[derive(Debug, Clone)]
pub struct AgentRuntimeProbe {
    pub tool_count: usize,
    /// None when the live Video Autopilot contract was not required (the Skill is not installed). Connecting an
    /// agent to Editkin never needs the Skill; only the autopilot tools do, and they say so when called.
    pub plan_schema: Option<String>,
    pub live_invocation_binding: Option<String>,
}

/// The probe result plus the tail of the server's stderr, kept whether the probe passed or not.
pub struct AgentRuntimeProbeReport {
    pub result: Result<AgentRuntimeProbe, String>,
    pub stderr_tail: String,
}

fn send_message(stdin: &mut impl Write, message: Value) -> Result<(), String> {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let closed = |error: std::io::Error| {
        format!("Editkin MCP exited before answering request {id} (its input closed: {error})")
    };
    serde_json::to_writer(&mut *stdin, &message).map_err(|error| closed(error.into()))?;
    stdin.write_all(b"\n").map_err(closed)?;
    stdin.flush().map_err(closed)
}

fn receive_response(
    responses: &mpsc::Receiver<Result<String, String>>,
    id: u64,
    deadline: Instant,
) -> Result<Value, String> {
    loop {
        let remaining = deadline
            .checked_duration_since(Instant::now())
            .ok_or_else(|| format!("Editkin MCP request {id} timed out"))?;
        let line = responses.recv_timeout(remaining).map_err(|error| match error {
            mpsc::RecvTimeoutError::Timeout => format!("Editkin MCP request {id} timed out"),
            mpsc::RecvTimeoutError::Disconnected => {
                format!("Editkin MCP exited before answering request {id}")
            }
        })??;
        let message: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if message.get("id").and_then(Value::as_u64) != Some(id) {
            continue;
        }
        if let Some(error) = message.get("error") {
            return Err(format!("Editkin MCP request {id} failed: {error}"));
        }
        return Ok(message);
    }
}

fn required_fields(tool: &Value) -> BTreeSet<&str> {
    tool.pointer("/inputSchema/required")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect()
}

fn text_tool_payload(response: &Value) -> Result<Value, String> {
    let result = response
        .get("result")
        .ok_or("MCP tool call omitted result")?;
    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        return Err(format!(
            "Editkin MCP contract call returned an error: {result}"
        ));
    }
    let text = result
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .find(|entry| entry.get("type").and_then(Value::as_str) == Some("text"))
        .and_then(|entry| entry.get("text"))
        .and_then(Value::as_str)
        .ok_or("Editkin MCP contract call omitted text content")?;
    serde_json::from_str(text)
        .map_err(|error| format!("Editkin MCP contract payload is invalid: {error}"))
}

fn spawn_stderr_tail(mut pipe: impl Read + Send + 'static) -> mpsc::Receiver<Vec<u8>> {
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut tail = VecDeque::new();
        let mut buffer = [0_u8; 4096];
        loop {
            match pipe.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    tail.extend(&buffer[..count]);
                    let excess = tail.len().saturating_sub(PROBE_STDERR_TAIL_BYTES);
                    tail.drain(..excess);
                }
            }
        }
        let _ = sender.send(tail.into_iter().collect());
    });
    receiver
}

/// Starts the configured launcher exactly as an agent would and checks it serves Editkin's MCP.
/// `require_autopilot_contract` additionally demands a GREEN live Video Autopilot contract; pass it only when the
/// Skill is installed, because that contract is built from the Skill and connecting must not depend on it.
pub fn probe_current_editkin_mcp(
    node: &Path,
    mcp: &Path,
    environment: &[(String, String)],
    require_autopilot_contract: bool,
) -> AgentRuntimeProbeReport {
    if !node.is_file() || !mcp.is_file() {
        return AgentRuntimeProbeReport {
            result: Err(format!(
                "Editkin MCP runtime is incomplete (node: {}, launcher: {})",
                if node.is_file() { "present" } else { "missing" },
                if mcp.is_file() { "present" } else { "missing" }
            )),
            stderr_tail: String::new(),
        };
    }
    let mut command = Command::new(node);
    command
        .arg(mcp)
        .envs(environment.iter().map(|(key, value)| (key, value)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .hidden();
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return AgentRuntimeProbeReport {
                result: Err(format!("Unable to start the bundled Editkin MCP: {error}")),
                stderr_tail: String::new(),
            }
        }
    };
    let stderr_tail = child.stderr.take().map(spawn_stderr_tail);
    let result = probe_running_child(&mut child, require_autopilot_contract);
    let _ = child.kill();
    let _ = child.wait();
    let stderr_tail = stderr_tail
        .and_then(|receiver| receiver.recv_timeout(Duration::from_secs(2)).ok())
        .map(|bytes| String::from_utf8_lossy(&bytes).trim().to_string())
        .unwrap_or_default();
    AgentRuntimeProbeReport {
        result,
        stderr_tail,
    }
}

fn probe_running_child(
    child: &mut std::process::Child,
    require_autopilot_contract: bool,
) -> Result<AgentRuntimeProbe, String> {
    let mut stdin = child.stdin.take().ok_or("Editkin MCP stdin unavailable")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Editkin MCP stdout unavailable")?;
    let (sender, responses) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if sender
                .send(line.map_err(|error| error.to_string()))
                .is_err()
            {
                break;
            }
        }
    });

    let result = (|| {
        let deadline = Instant::now() + Duration::from_secs(20);
        send_message(
            &mut stdin,
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": { "name": "editkin-desktop-readiness", "version": "1" }
                }
            }),
        )?;
        let initialized = receive_response(&responses, 1, deadline)?;
        if initialized
            .pointer("/result/serverInfo/name")
            .and_then(Value::as_str)
            != Some("editkin")
        {
            return Err("Bundled MCP server identity is not Editkin".to_string());
        }
        send_message(
            &mut stdin,
            json!({ "jsonrpc": "2.0", "method": "notifications/initialized", "params": {} }),
        )?;
        send_message(
            &mut stdin,
            json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }),
        )?;
        let tools_response = receive_response(&responses, 2, deadline)?;
        let tools = tools_response
            .pointer("/result/tools")
            .and_then(Value::as_array)
            .ok_or("Editkin MCP tools/list omitted tools")?;
        let names = tools
            .iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str))
            .collect::<BTreeSet<_>>();
        for required in [
            "get_autopilot_contract",
            "start_ai_editing_session",
            "audit_autopilot_plan",
            "apply_autopilot_plan",
            "render_project",
            "get_remote_setup_status",
            "prepare_remote_setup",
            "configure_remote_access",
            "verify_remote_access",
        ] {
            if !names.contains(required) {
                return Err(format!(
                    "Bundled Editkin MCP is missing required tool: {required}"
                ));
            }
        }
        if tools.len() < 35 {
            return Err(format!(
                "Bundled Editkin MCP exposes only {} tools; expected at least 35",
                tools.len()
            ));
        }
        let audit = tools
            .iter()
            .find(|tool| tool.get("name").and_then(Value::as_str) == Some("audit_autopilot_plan"))
            .ok_or("Bundled Editkin MCP omitted audit_autopilot_plan")?;
        let apply = tools
            .iter()
            .find(|tool| tool.get("name").and_then(Value::as_str) == Some("apply_autopilot_plan"))
            .ok_or("Bundled Editkin MCP omitted apply_autopilot_plan")?;
        if !["projectPath", "plan"]
            .into_iter()
            .all(|field| required_fields(audit).contains(field))
        {
            return Err("Bundled Editkin MCP audit schema is stale".to_string());
        }
        if !["projectPath", "plan", "auditReceipt"]
            .into_iter()
            .all(|field| required_fields(apply).contains(field))
        {
            return Err(
                "Bundled Editkin MCP apply schema is stale or bypasses the accepted audit receipt"
                    .to_string(),
            );
        }
        if !require_autopilot_contract {
            // The server answered the handshake and lists the current tools: that is a working connection.
            // get_autopilot_contract is built from the Video Autopilot Skill, which is optional for connecting.
            return Ok(AgentRuntimeProbe {
                tool_count: tools.len(),
                plan_schema: None,
                live_invocation_binding: None,
            });
        }

        send_message(
            &mut stdin,
            json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": { "name": "get_autopilot_contract", "arguments": {} }
            }),
        )?;
        let contract_response = receive_response(&responses, 3, deadline)?;
        let payload = text_tool_payload(&contract_response)?;
        if payload.get("status").and_then(Value::as_str) != Some("GREEN") {
            return Err(format!(
                "Bundled Editkin MCP live contract is not GREEN: {payload}"
            ));
        }
        let plan_schema = payload
            .pointer("/contract/planSchema")
            .and_then(Value::as_str)
            .ok_or("Bundled Editkin MCP contract omitted planSchema")?;
        if plan_schema != "hao.video-autopilot.edit-plan/v4" {
            return Err(format!(
                "Bundled Editkin MCP plan schema is stale: {plan_schema}"
            ));
        }
        let binding = payload
            .pointer("/liveInvocation/bindingSha256")
            .and_then(Value::as_str)
            .ok_or("Bundled Editkin MCP contract omitted liveInvocation binding")?;
        let required_binding = payload
            .pointer("/requiredPlanSource/invocationBindingSha256")
            .and_then(Value::as_str)
            .ok_or("Bundled Editkin MCP contract omitted requiredPlanSource binding")?;
        if binding.len() != 64
            || !binding.bytes().all(|byte| byte.is_ascii_hexdigit())
            || binding != required_binding
        {
            return Err(
                "Bundled Editkin MCP live invocation identity is invalid or unbound".to_string(),
            );
        }
        Ok(AgentRuntimeProbe {
            tool_count: tools.len(),
            plan_schema: Some(plan_schema.to_string()),
            live_invocation_binding: Some(binding.to_string()),
        })
    })();
    drop(stdin);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_schema_requires_project_binding_and_one_time_audit_receipt() {
        let audit = json!({ "inputSchema": { "required": ["projectPath", "plan"] } });
        let apply =
            json!({ "inputSchema": { "required": ["projectPath", "plan", "auditReceipt"] } });
        assert_eq!(
            required_fields(&audit),
            BTreeSet::from(["plan", "projectPath"])
        );
        assert!(required_fields(&apply).contains("auditReceipt"));
    }

    #[test]
    fn old_apply_schema_is_detectably_incomplete() {
        let old_apply = json!({ "inputSchema": { "required": ["projectPath", "plan"] } });
        assert!(!required_fields(&old_apply).contains("auditReceipt"));
    }

    /// An Editkin-shaped MCP whose get_autopilot_contract fails the way the real one does without the Skill.
    const SERVER_WITHOUT_SKILL: &str = r#"
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
const named = ["get_autopilot_contract", "start_ai_editing_session", "audit_autopilot_plan", "apply_autopilot_plan",
  "render_project", "get_remote_setup_status", "prepare_remote_setup", "configure_remote_access", "verify_remote_access"];
const required = { audit_autopilot_plan: ["projectPath", "plan"], apply_autopilot_plan: ["projectPath", "plan", "auditReceipt"] };
const tools = named.map((name) => ({ name, inputSchema: { type: "object", required: required[name] ?? [] } }));
for (let i = tools.length; i < 40; i++) tools.push({ name: `filler_${i}`, inputSchema: { type: "object" } });
process.stderr.write("fake editkin mcp: started without the Video Autopilot Skill\n");
require("readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: { serverInfo: { name: "editkin", version: "test" }, capabilities: {} } });
  else if (m.method === "tools/list") send({ jsonrpc: "2.0", id: m.id, result: { tools } });
  else if (m.method === "tools/call") send({ jsonrpc: "2.0", id: m.id, result: { isError: true, content: [{ type: "text", text: "這台電腦還沒有安裝 Video Autopilot Kit（找不到 ~/.codex/skills/video-autopilot/SKILL.md）。" }] } });
});
"#;

    fn node() -> std::path::PathBuf {
        std::path::PathBuf::from(
            std::env::var_os("EDITKIN_TEST_NODE").expect("test runtime must be explicitly configured"),
        )
    }

    fn script(name: &str, body: &str) -> std::path::PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "editkin-probe-test-{}-{name}-{}",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join(format!("{name}.cjs"));
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn connecting_does_not_need_the_video_autopilot_skill_but_the_live_contract_does() {
        let server = script("no-skill", SERVER_WITHOUT_SKILL);
        let without = probe_current_editkin_mcp(&node(), &server, &[], false);
        let probe = without.result.expect("a working server without the Skill is a working connection");
        assert_eq!(probe.tool_count, 40);
        assert_eq!(probe.plan_schema, None);
        assert_eq!(probe.live_invocation_binding, None);
        assert!(without.stderr_tail.contains("started without the Video Autopilot Skill"));
        let with = probe_current_editkin_mcp(&node(), &server, &[], true);
        assert!(with.result.unwrap_err().contains("contract call returned an error"));
        let _ = std::fs::remove_dir_all(server.parent().unwrap());
    }

    #[test]
    fn a_launcher_that_dies_reports_why_through_its_stderr() {
        // #102-#105: the launcher threw before answering and users only ever saw a generic failure.
        let launcher = script(
            "dies",
            "process.stderr.write('Error: Host configuration did not select the generation-bound stable launcher\\n'); process.exit(1);",
        );
        let report = probe_current_editkin_mcp(&node(), &launcher, &[], false);
        let error = report.result.unwrap_err();
        assert!(error.contains("exited before answering request 1"), "{error}");
        assert!(report
            .stderr_tail
            .contains("did not select the generation-bound stable launcher"));
        let missing = probe_current_editkin_mcp(&node(), &launcher.with_extension("missing"), &[], false);
        assert!(missing.result.unwrap_err().contains("launcher: missing"));
        let _ = std::fs::remove_dir_all(launcher.parent().unwrap());
    }
}
