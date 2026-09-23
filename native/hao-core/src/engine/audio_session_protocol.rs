//! Closed, bounded JSON-lines vocabulary shared by the native IPC server.
use serde::Deserialize;
use std::path::{Path, PathBuf};
pub const COMMAND_SCHEMA: &str = "editkin.audio-session-command/v1";
pub const EVENT_SCHEMA: &str = "editkin.audio-session-event/v1";
pub const MAX_COMMAND_BYTES: usize = 16 * 1024;
pub const MAX_EVENT_BYTES: usize = 128 * 1024;
pub const PIPE_QUEUE: usize = 8;
pub const MAX_SAFE_ID: u64 = 9_007_199_254_740_991;

#[derive(Debug, Deserialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum WireCommand {
    Replace {
        schema: String,
        request_id: u64,
        generation: u64,
        plan_path: PathBuf,
        plan_sha256: String,
        autoplay: bool,
    },
    Pause {
        schema: String,
        request_id: u64,
        generation: u64,
    },
    Resume {
        schema: String,
        request_id: u64,
        generation: u64,
    },
    Snapshot {
        schema: String,
        request_id: u64,
    },
    Close {
        schema: String,
        request_id: u64,
    },
}
impl WireCommand {
    pub fn request(&self) -> u64 {
        match self {
            Self::Replace { request_id, .. }
            | Self::Pause { request_id, .. }
            | Self::Resume { request_id, .. }
            | Self::Snapshot { request_id, .. }
            | Self::Close { request_id, .. } => *request_id,
        }
    }
    fn validate(&self) -> Result<(), String> {
        let (schema, generation) = match self {
            Self::Replace {
                schema,
                generation,
                plan_path,
                plan_sha256,
                ..
            } => {
                if !local_absolute(plan_path)
                    || plan_path.as_os_str().len() > 8192
                    || !valid_sha(plan_sha256)
                {
                    return Err("invalid plan path/hash".into());
                }
                (schema, Some(*generation))
            }
            Self::Pause {
                schema, generation, ..
            }
            | Self::Resume {
                schema, generation, ..
            } => (schema, Some(*generation)),
            Self::Snapshot { schema, .. } | Self::Close { schema, .. } => (schema, None),
        };
        if schema != COMMAND_SCHEMA
            || self.request() == 0
            || self.request() > MAX_SAFE_ID
            || generation.is_some_and(|g| g == 0 || g > MAX_SAFE_ID)
        {
            return Err("invalid protocol schema/request/generation".into());
        }
        Ok(())
    }
}
pub fn valid_sha(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
pub fn local_absolute(path: &Path) -> bool {
    if !path.is_absolute() {
        return false;
    }
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        matches!(path.components().next(),Some(Component::Prefix(p)) if matches!(p.kind(),Prefix::Disk(_)|Prefix::VerbatimDisk(_)))
    }
    #[cfg(not(windows))]
    {
        true
    }
}
#[derive(Default)]
pub struct Lines {
    pending: Vec<u8>,
}
impl Lines {
    pub fn push(
        &mut self,
        bytes: &[u8],
        mut emit: impl FnMut(WireCommand) -> Result<(), String>,
    ) -> Result<(), String> {
        for &b in bytes {
            if b == b'\n' {
                let command: WireCommand = serde_json::from_slice(&self.pending)
                    .map_err(|_| "invalid command JSON or fields")?;
                self.pending.clear();
                command.validate()?;
                emit(command)?;
            } else {
                if self.pending.len() >= MAX_COMMAND_BYTES {
                    return Err("command exceeds 16 KiB".into());
                }
                self.pending.push(b);
            }
        }
        Ok(())
    }
    pub fn finish(&self) -> Result<(), String> {
        if self.pending.is_empty() {
            Ok(())
        } else {
            Err("unterminated command at input EOF".into())
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fragmented_utf8_is_parsed_once_with_closed_schema() {
        let path = std::env::current_dir().unwrap().join("中文 & plan.json");
        let value = serde_json::json!({"schema":COMMAND_SCHEMA,"op":"replace","requestId":1,
            "generation":9,"planPath":path,"planSha256":"a".repeat(64),"autoplay":true});
        let mut bytes = serde_json::to_vec(&value).unwrap();
        bytes.push(b'\n');
        let mut lines = Lines::default();
        let mut requests = vec![];
        for b in bytes {
            lines
                .push(&[b], |c| {
                    requests.push(c.request());
                    Ok(())
                })
                .unwrap();
        }
        assert_eq!(requests, vec![1]);
        lines.finish().unwrap();
    }
    #[test]
    fn malformed_unknown_overflow_and_partial_commands_are_rejected() {
        for value in [
            serde_json::json!({"schema":COMMAND_SCHEMA,"op":"snapshot","requestId":0}),
            serde_json::json!({"schema":COMMAND_SCHEMA,"op":"snapshot","requestId":1,"shell":"cmd"}),
            serde_json::json!({"schema":"old","op":"snapshot","requestId":1}),
            serde_json::json!({"schema":COMMAND_SCHEMA,"op":"pause","requestId":1,"generation":9007199254740992u64}),
            serde_json::json!({"schema":COMMAND_SCHEMA,"op":"execute","requestId":1}),
        ] {
            let mut bytes = serde_json::to_vec(&value).unwrap();
            bytes.push(b'\n');
            assert!(
                Lines::default()
                    .push(&bytes, |_| panic!("invalid command executed"))
                    .is_err()
            );
        }
        let mut lines = Lines::default();
        assert!(
            lines
                .push(&vec![b'x'; MAX_COMMAND_BYTES + 1], |_| Ok(()))
                .is_err()
        );
        let mut lines = Lines::default();
        lines.push(b"{", |_| Ok(())).unwrap();
        assert!(lines.finish().is_err());
    }
    #[test]
    fn network_and_relative_authority_are_not_admitted() {
        assert!(!local_absolute(Path::new("relative.json")));
        #[cfg(windows)]
        {
            assert!(!local_absolute(Path::new(r"\\server\share\plan.json")));
        }
        assert!(!valid_sha(&"A".repeat(64)));
    }
}
