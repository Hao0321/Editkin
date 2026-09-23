use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    io::{BufRead, BufReader, Write},
    path::Path,
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

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
    pub plan_schema: String,
    pub live_invocation_binding: String,
}

fn send_message(stdin: &mut impl Write, message: Value) -> Result<(), String> {
    serde_json::to_writer(&mut *stdin, &message).map_err(|error| error.to_string())?;
    stdin.write_all(b"\n").map_err(|error| error.to_string())?;
    stdin.flush().map_err(|error| error.to_string())
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
        let line = responses
            .recv_timeout(remaining)
            .map_err(|_| format!("Editkin MCP request {id} timed out"))??;
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

pub fn probe_current_editkin_mcp(
    node: &Path,
    mcp: &Path,
    environment: &[(String, String)],
) -> Result<AgentRuntimeProbe, String> {
    if !node.is_file() || !mcp.is_file() {
        return Err("Editkin MCP runtime is incomplete".to_string());
    }
    let mut command = Command::new(node);
    command
        .arg(mcp)
        .envs(environment.iter().map(|(key, value)| (key, value)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .hidden();
    let mut child = command
        .spawn()
        .map_err(|error| format!("Unable to start the bundled Editkin MCP: {error}"))?;
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
            plan_schema: plan_schema.to_string(),
            live_invocation_binding: binding.to_string(),
        })
    })();
    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
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
}
