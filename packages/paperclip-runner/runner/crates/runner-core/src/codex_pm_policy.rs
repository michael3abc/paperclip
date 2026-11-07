//! Per-process admission for Core's restrictive Codex PM hook. No host trust is changed.
use crate::{codex_provider::CodexProviderConfig, local_runner::LocalRunnerError};
use serde_json::{json, Value};

const HOOK_KEY: &str = "/<session-flags>/config.toml:pre_tool_use:0:0";

fn expected_command(config: &CodexProviderConfig) -> Result<String, LocalRunnerError> {
    let invalid = || LocalRunnerError::invalid("codex_pm_launch_policy_invalid");
    if config.provider != "codex"
        || !config.read_only
        || config.externally_sandboxed
        || config.approval_policy != "never"
        || config.include_skill_instructions != Some(false)
    {
        return Err(invalid());
    }
    let raw = config
        .args
        .iter()
        .rev()
        .find(|arg| arg.starts_with("hooks.PreToolUse="))
        .ok_or_else(invalid)?;
    let doc = raw
        .parse::<toml_edit::DocumentMut>()
        .map_err(|_| invalid())?;
    let groups = doc["hooks"]["PreToolUse"].as_array().ok_or_else(invalid)?;
    if groups.len() != 1 {
        return Err(invalid());
    }
    let group = groups
        .get(0)
        .and_then(|v| v.as_inline_table())
        .ok_or_else(invalid)?;
    if group.get("matcher").and_then(|v| v.as_str()) != Some(".*") {
        return Err(invalid());
    }
    let handlers = group
        .get("hooks")
        .and_then(|v| v.as_array())
        .ok_or_else(invalid)?;
    if handlers.len() != 1 {
        return Err(invalid());
    }
    let handler = handlers
        .get(0)
        .and_then(|v| v.as_inline_table())
        .ok_or_else(invalid)?;
    if handler.get("type").and_then(|v| v.as_str()) != Some("command")
        || handler.get("timeout").and_then(|v| v.as_integer()) != Some(3)
    {
        return Err(invalid());
    }
    let command = handler
        .get("command")
        .and_then(|v| v.as_str())
        .ok_or_else(invalid)?;
    if !command.contains("PM_TOOL_DENIED: delegate execution to a Paperclip worker") {
        return Err(invalid());
    }
    Ok(command.to_owned())
}

fn owned_hook(result: &Value, command: &str) -> Result<Value, LocalRunnerError> {
    let invalid = || LocalRunnerError::invalid("codex_pm_hook_missing_or_mismatched");
    let rows = result
        .get("data")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    let matches: Vec<&Value> = rows
        .iter()
        .filter_map(|row| row.get("hooks").and_then(Value::as_array))
        .flatten()
        .filter(|hook| hook["key"] == HOOK_KEY)
        .collect();
    if matches.len() != 1 {
        return Err(invalid());
    }
    let hook = matches[0];
    let hash = hook["currentHash"].as_str().unwrap_or("");
    if hook["source"] != "sessionFlags"
        || hook["command"] != command
        || hook["matcher"] != ".*"
        || hook["eventName"] != "preToolUse"
        || hook["handlerType"] != "command"
        || hook["async"] != false
        || hook["enabled"] != true
        || hook["timeoutSec"] != 3
        || !hash.starts_with("sha256:")
        || hash.len() != 71
        || !hash[7..]
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err(invalid());
    }
    Ok(hook.clone())
}

pub(crate) fn admit_owned_hook(
    config: &CodexProviderConfig,
    mut request: impl FnMut(&str, Value) -> Result<Value, LocalRunnerError>,
) -> Result<(), LocalRunnerError> {
    if config.provider_version != "codex-pm-v1" {
        return Ok(());
    }
    let command = expected_command(config)?;
    let hook = owned_hook(&request("hooks/list", json!({"cwds": []}))?, &command)?;
    if hook["trustStatus"] != "trusted" {
        request(
            "config/value/write",
            json!({
                "keyPath": format!("hooks.state.{}.trusted_hash", serde_json::to_string(HOOK_KEY).unwrap()),
                "value": hook["currentHash"], "mergeStrategy": "replace",
            }),
        )?;
    }
    let readback = owned_hook(&request("hooks/list", json!({"cwds": []}))?, &command)?;
    if readback["trustStatus"] != "trusted" || readback["currentHash"] != hook["currentHash"] {
        return Err(LocalRunnerError::invalid(
            "codex_pm_hook_trust_not_confirmed",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config() -> CodexProviderConfig {
        serde_json::from_value(json!({ "provider": "codex", "driver": "codex_app_server",
            "providerVersion": "codex-pm-v1", "command": "/bin/false", "cwd": "/workspace",
            "readOnly": true, "includeSkillInstructions": false,
            "args": ["-c", "hooks.PreToolUse=[{matcher=\".*\",hooks=[{type=\"command\",command=\"PM_TOOL_DENIED: delegate execution to a Paperclip worker\",timeout=3}]}]", "app-server"]
        })).unwrap()
    }
    fn hook(trusted: bool) -> Value {
        json!({"key": HOOK_KEY, "source": "sessionFlags", "command": expected_command(&config()).unwrap(),
            "matcher": ".*", "eventName": "preToolUse", "handlerType": "command", "async": false,
            "enabled": true, "timeoutSec": 3, "currentHash": format!("sha256:{}", "a".repeat(64)),
            "trustStatus": if trusted { "trusted" } else { "untrusted" }})
    }
    #[test]
    fn scopes_trust_to_the_exact_hook_and_requires_readback() {
        let mut calls = Vec::new();
        let mut trusted = false;
        admit_owned_hook(&config(), |method, params| {
            calls.push(method.to_owned());
            if method == "config/value/write" {
                assert_eq!(params["value"], hook(false)["currentHash"]);
                assert_eq!(
                    params["keyPath"],
                    format!(
                        "hooks.state.{}.trusted_hash",
                        serde_json::to_string(HOOK_KEY).unwrap()
                    )
                );
                trusted = true;
                return Ok(json!({}));
            }
            Ok(json!({"data": [{"hooks": [hook(trusted)]}]}))
        })
        .unwrap();
        assert_eq!(calls, ["hooks/list", "config/value/write", "hooks/list"]);
        assert!(admit_owned_hook(&config(), |_, _| Ok(
            json!({"data": [{"hooks": [hook(false)]}]})
        ))
        .is_err());
    }
    #[test]
    fn rejects_foreign_or_changed_hooks_without_a_write() {
        for (field, value) in [
            ("source", json!("user")),
            ("command", json!("foreign")),
            ("enabled", json!(false)),
            ("currentHash", json!("unknown")),
        ] {
            let mut changed = hook(false);
            changed[field] = value;
            assert!(admit_owned_hook(&config(), |method, _| {
                assert_eq!(method, "hooks/list");
                Ok(json!({"data": [{"hooks": [changed]}]}))
            })
            .is_err());
        }
        let mut unsafe_config = config();
        unsafe_config.read_only = false;
        assert!(admit_owned_hook(&unsafe_config, |_, _| panic!("must reject before RPC")).is_err());
        let mut ordinary = config();
        ordinary.provider_version = "codex-app-server-v1".into();
        admit_owned_hook(&ordinary, |_, _| {
            panic!("ordinary worker must not change trust")
        })
        .unwrap();
    }
}
