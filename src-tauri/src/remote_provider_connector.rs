use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

const REGISTRY_BYTES: &str = include_str!("../../src/shared/remoteProviderConnectorRegistry.json");
const REGISTRY_SCHEMA: &str = "editkin.remote-provider-connector-registry/v1";
pub const ACTION_PLAN_SCHEMA: &str = "editkin.remote-provider-action-plan/v1";
const ACTION_APPROVAL_SCHEMA: &str = "editkin.remote-provider-action-approval/v1";
const ACTION_RECEIPT_SCHEMA: &str = "editkin.remote-provider-action-receipt/v1";
const ACTION_CONSENT_REVISION: &str = "editkin.remote-provider-action-consent/v1";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RegistryDocument {
    schema: String,
    registry_revision: String,
    connectors: Vec<RemoteProviderConnectorManifest>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RemoteProviderConnectorManifest {
    pub connector_id: String,
    pub connector_revision: String,
    pub provider_id: String,
    pub provider_display_name: String,
    pub product_name: String,
    pub transport: String,
    pub availability: String,
    pub approval_enabled: bool,
    pub attested: bool,
    pub execution_owner: String,
    pub auth_mode: String,
    pub stable_https_name: bool,
    pub supported_public_ports: Vec<u16>,
    pub allowed_plan_operations: Vec<String>,
    pub limitations: Vec<String>,
    pub source_urls: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct ConnectorBinding<'a> {
    pub connector_id: &'a str,
    pub connector_revision: &'a str,
    pub manifest_sha256: &'a str,
    pub availability: &'a str,
    pub attested: bool,
    pub approval_enabled: bool,
    pub execution_owner: &'a str,
}

fn sha256_json(value: &Value) -> Result<String, String> {
    let bytes = serde_json::to_vec(value)
        .map_err(|error| format!("Remote connector identity encode 失敗：{error}"))?;
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

fn lower_hex_64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn lower_hex_32(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn connector_manifest_digest(
    registry_revision: &str,
    manifest: &RemoteProviderConnectorManifest,
) -> Result<String, String> {
    sha256_json(&json!([
        REGISTRY_SCHEMA,
        registry_revision,
        manifest.connector_id,
        manifest.connector_revision,
        manifest.provider_id,
        manifest.provider_display_name,
        manifest.product_name,
        manifest.transport,
        manifest.availability,
        manifest.approval_enabled,
        manifest.attested,
        manifest.execution_owner,
        manifest.auth_mode,
        manifest.stable_https_name,
        manifest.supported_public_ports,
        manifest.allowed_plan_operations,
        manifest.limitations,
        manifest.source_urls,
    ]))
}

fn approval_available(manifest: &RemoteProviderConnectorManifest) -> bool {
    manifest.availability == "enabled" && manifest.approval_enabled && manifest.attested
}

fn valid_registry_text(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value == value.trim()
        && value.encode_utf16().count() <= max
        && !value.chars().any(|character| character.is_control())
}

fn parse_registry(registry_bytes: &str) -> Result<RegistryDocument, String> {
    let registry = serde_json::from_str::<RegistryDocument>(registry_bytes)
        .map_err(|error| format!("Embedded Remote connector registry 格式不合法：{error}"))?;
    if registry.schema != REGISTRY_SCHEMA
        || registry.registry_revision.len() > 64
        || registry.connectors.is_empty()
        || registry.connectors.len() > 16
    {
        return Err("Embedded Remote connector registry header 不合法".into());
    }
    let mut connector_ids = BTreeSet::new();
    for connector in &registry.connectors {
        let id_ok = (2..=63).contains(&connector.connector_id.len())
            && connector
                .connector_id
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');
        let revision_ok = (2..=64).contains(&connector.connector_revision.len())
            && connector.connector_revision.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-' || byte == b'.'
            });
        let provider_ok = (2..=63).contains(&connector.provider_id.len())
            && connector.provider_id.bytes().all(|byte| {
                byte.is_ascii_lowercase()
                    || byte.is_ascii_digit()
                    || matches!(byte, b'.' | b'_' | b'-')
            });
        let unique_ports = connector
            .supported_public_ports
            .iter()
            .copied()
            .collect::<BTreeSet<_>>()
            .len()
            == connector.supported_public_ports.len();
        let unique_operations = connector
            .allowed_plan_operations
            .iter()
            .collect::<BTreeSet<_>>()
            .len()
            == connector.allowed_plan_operations.len();
        let known_operations = connector.allowed_plan_operations.iter().all(|operation| {
            matches!(
                operation.as_str(),
                "inspect-status"
                    | "request-provider-owned-login"
                    | "create-or-resume-single-funnel"
                    | "cancel-single-funnel"
                    | "reconcile-single-funnel"
            )
        });
        let urls_safe = !connector.source_urls.is_empty()
            && connector.source_urls.len() <= 8
            && connector.source_urls.iter().all(|url| {
                url.starts_with("https://")
                    && !url.contains(['?', '#', '@', '\\'])
                    && !url.chars().any(char::is_whitespace)
            });
        if !id_ok
            || connector.connector_id.contains("fake")
            || !revision_ok
            || !provider_ok
            || !connector_ids.insert(connector.connector_id.as_str())
            || !valid_registry_text(&connector.provider_display_name, 80)
            || !valid_registry_text(&connector.product_name, 120)
            || connector.transport != "https-tunnel"
            || !matches!(
                connector.availability.as_str(),
                "enabled" | "research-only-disabled" | "unsupported-temporary"
            )
            || connector.execution_owner != "native-typed-connector"
            || !matches!(
                connector.auth_mode.as_str(),
                "provider-owned-browser" | "none"
            )
            || connector.supported_public_ports.len() > 8
            || connector.supported_public_ports.contains(&0)
            || !unique_ports
            || connector.allowed_plan_operations.is_empty()
            || connector.allowed_plan_operations.len() > 8
            || !unique_operations
            || !known_operations
            || connector.limitations.is_empty()
            || connector.limitations.len() > 16
            || connector
                .limitations
                .iter()
                .any(|value| !valid_registry_text(value, 240))
            || !urls_safe
            || (connector.auth_mode == "none"
                && connector
                    .allowed_plan_operations
                    .iter()
                    .any(|value| value == "request-provider-owned-login"))
            || (connector.approval_enabled && !approval_available(connector))
        {
            return Err("Embedded Remote connector registry 未通過 closed-world 驗證".into());
        }
    }
    Ok(registry)
}

fn registry() -> Result<RegistryDocument, String> {
    parse_registry(REGISTRY_BYTES)
}

pub fn list_connector_status() -> Result<Value, String> {
    let registry = registry()?;
    let connectors = registry
        .connectors
        .iter()
        .map(|connector| {
            Ok(json!({
                "connectorId": connector.connector_id,
                "connectorRevision": connector.connector_revision,
                "manifestSha256": connector_manifest_digest(&registry.registry_revision, connector)?,
                "providerId": connector.provider_id,
                "providerDisplayName": connector.provider_display_name,
                "productName": connector.product_name,
                "transport": connector.transport,
                "availability": connector.availability,
                "approvalAvailable": approval_available(connector),
                "attested": connector.attested,
                "executionOwner": connector.execution_owner,
                "authMode": connector.auth_mode,
                "stableHttpsName": connector.stable_https_name,
                "supportedPublicPorts": connector.supported_public_ports,
                "limitations": connector.limitations,
                "sourceUrls": connector.source_urls,
            }))
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(json!({
        "schema": "editkin.remote-provider-connector-list/v1",
        "status": "RESEARCH_ONLY_NO_EXTERNAL_ACTION",
        "connectors": connectors,
        "externalMutationToolAvailable": false,
        "nextAction": "目前沒有已 attested 且 enabled 的 connector；只能研究 proposal，不能核准、登入或部署"
    }))
}

pub fn validate_connector_binding(
    binding: ConnectorBinding<'_>,
    provider_id: &str,
    provider_display_name: &str,
    product_name: &str,
    approval_available_in_proposal: bool,
) -> Result<(), String> {
    let registry = registry()?;
    let connector = registry
        .connectors
        .iter()
        .find(|candidate| candidate.connector_id == binding.connector_id)
        .ok_or("Remote proposal connector 不在 embedded closed registry")?;
    let digest = connector_manifest_digest(&registry.registry_revision, connector)?;
    if connector.connector_revision != binding.connector_revision
        || digest != binding.manifest_sha256
        || connector.availability != binding.availability
        || connector.attested != binding.attested
        || connector.approval_enabled != binding.approval_enabled
        || connector.execution_owner != binding.execution_owner
        || connector.provider_id != provider_id
        || connector.provider_display_name != provider_display_name
        || connector.product_name != product_name
        || approval_available(connector) != approval_available_in_proposal
    {
        return Err("Remote proposal connector binding 與 embedded closed registry 不一致".into());
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum ProviderActionState {
    ApprovedNotStarted,
    ProviderAuthRequired,
    ProviderActionRunning,
    AwaitingDesktopApproval,
    FailedNoMutation,
    CanceledNoMutation,
    ProviderActionReconciliationRequired,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProviderMutationTruth {
    None,
    Confirmed,
    Unknown,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderActionApprovalReceipt {
    schema: &'static str,
    approval_id: String,
    action_id: String,
    idempotency_key: String,
    proposal_revision: String,
    proposal_digest: String,
    connector_id: String,
    connector_revision: String,
    connector_manifest_sha256: String,
    plan_digest: String,
    consent_revision: &'static str,
    provider_owned_login: bool,
    secrets_accepted_by_editkin: bool,
    approved_at_ms: u64,
    expires_at_ms: u64,
    receipt_digest: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderActionReceipt {
    schema: &'static str,
    action_id: String,
    idempotency_key: String,
    approval_receipt_digest: String,
    state: ProviderActionState,
    mutation_truth: String,
    attempt: u32,
    previous_receipt_digest: Option<String>,
    observed_at_ms: u64,
    receipt_digest: String,
}

fn issue_action_approval(
    connector: &RemoteProviderConnectorManifest,
    proposal_revision: &str,
    proposal_digest: &str,
    connector_manifest_sha256: &str,
    plan_digest: &str,
    approval_id: &str,
    action_id: &str,
    approved_at_ms: u64,
) -> Result<ProviderActionApprovalReceipt, String> {
    if !approval_available(connector) {
        return Err("Remote connector 尚未 enabled + attested，不可發出 action approval".into());
    }
    if !lower_hex_64(proposal_digest)
        || !lower_hex_64(connector_manifest_sha256)
        || !lower_hex_64(plan_digest)
        || !lower_hex_32(approval_id)
        || !lower_hex_32(action_id)
        || proposal_revision.is_empty()
    {
        return Err("Remote action approval identity 不合法".into());
    }
    let idempotency_key = sha256_json(&json!([
        "editkin.remote-provider-action-idempotency/v1",
        proposal_digest,
        connector.connector_id,
        connector.connector_revision,
        connector_manifest_sha256,
        plan_digest,
    ]))?;
    let expires_at_ms = approved_at_ms.saturating_add(10 * 60 * 1_000);
    let unsigned = json!([
        ACTION_APPROVAL_SCHEMA,
        approval_id,
        action_id,
        idempotency_key,
        proposal_revision,
        proposal_digest,
        connector.connector_id,
        connector.connector_revision,
        connector_manifest_sha256,
        plan_digest,
        ACTION_CONSENT_REVISION,
        true,
        false,
        approved_at_ms,
        expires_at_ms,
    ]);
    Ok(ProviderActionApprovalReceipt {
        schema: ACTION_APPROVAL_SCHEMA,
        approval_id: approval_id.into(),
        action_id: action_id.into(),
        idempotency_key,
        proposal_revision: proposal_revision.into(),
        proposal_digest: proposal_digest.into(),
        connector_id: connector.connector_id.clone(),
        connector_revision: connector.connector_revision.clone(),
        connector_manifest_sha256: connector_manifest_sha256.into(),
        plan_digest: plan_digest.into(),
        consent_revision: ACTION_CONSENT_REVISION,
        provider_owned_login: true,
        secrets_accepted_by_editkin: false,
        approved_at_ms,
        expires_at_ms,
        receipt_digest: sha256_json(&unsigned)?,
    })
}

fn action_receipt_digest(receipt: &ProviderActionReceipt) -> Result<String, String> {
    sha256_json(&json!([
        receipt.schema,
        receipt.action_id,
        receipt.idempotency_key,
        receipt.approval_receipt_digest,
        receipt.state,
        receipt.mutation_truth,
        receipt.attempt,
        receipt.previous_receipt_digest,
        receipt.observed_at_ms,
    ]))
}

fn begin_action_receipt(
    approval: &ProviderActionApprovalReceipt,
    observed_at_ms: u64,
) -> Result<ProviderActionReceipt, String> {
    if observed_at_ms < approval.approved_at_ms || observed_at_ms > approval.expires_at_ms {
        return Err("Remote action approval 尚未生效或已過期".into());
    }
    let mut receipt = ProviderActionReceipt {
        schema: ACTION_RECEIPT_SCHEMA,
        action_id: approval.action_id.clone(),
        idempotency_key: approval.idempotency_key.clone(),
        approval_receipt_digest: approval.receipt_digest.clone(),
        state: ProviderActionState::ApprovedNotStarted,
        mutation_truth: "none".into(),
        attempt: 0,
        previous_receipt_digest: None,
        observed_at_ms,
        receipt_digest: String::new(),
    };
    receipt.receipt_digest = action_receipt_digest(&receipt)?;
    Ok(receipt)
}

fn transition_action_receipt(
    current: &ProviderActionReceipt,
    next: ProviderActionState,
    mutation_truth: ProviderMutationTruth,
    observed_at_ms: u64,
) -> Result<ProviderActionReceipt, String> {
    if action_receipt_digest(current)? != current.receipt_digest {
        return Err("Remote action receipt hash chain 已遭竄改".into());
    }
    let allowed = matches!(
        (current.state, next),
        (
            ProviderActionState::ApprovedNotStarted,
            ProviderActionState::ProviderAuthRequired
                | ProviderActionState::ProviderActionRunning
                | ProviderActionState::CanceledNoMutation
        ) | (
            ProviderActionState::ProviderAuthRequired,
            ProviderActionState::ProviderActionRunning | ProviderActionState::CanceledNoMutation
        ) | (
            ProviderActionState::ProviderActionRunning,
            ProviderActionState::AwaitingDesktopApproval
                | ProviderActionState::FailedNoMutation
                | ProviderActionState::ProviderActionReconciliationRequired
        ) | (
            ProviderActionState::ProviderActionReconciliationRequired,
            ProviderActionState::AwaitingDesktopApproval
                | ProviderActionState::FailedNoMutation
                | ProviderActionState::CanceledNoMutation
        )
    );
    if !allowed || observed_at_ms < current.observed_at_ms {
        return Err("Remote provider action state transition 不合法或已重播".into());
    }
    let truth_valid = match next {
        ProviderActionState::ProviderActionReconciliationRequired => {
            mutation_truth == ProviderMutationTruth::Unknown
        }
        ProviderActionState::AwaitingDesktopApproval => {
            mutation_truth == ProviderMutationTruth::Confirmed
        }
        ProviderActionState::ProviderAuthRequired
        | ProviderActionState::FailedNoMutation
        | ProviderActionState::CanceledNoMutation
        | ProviderActionState::ApprovedNotStarted => mutation_truth == ProviderMutationTruth::None,
        ProviderActionState::ProviderActionRunning => {
            matches!(
                mutation_truth,
                ProviderMutationTruth::None | ProviderMutationTruth::Unknown
            )
        }
    };
    if !truth_valid
        || (current.state == ProviderActionState::ProviderActionReconciliationRequired
            && next == ProviderActionState::ProviderActionRunning)
    {
        return Err("Remote provider mutation truth 不允許 blind retry".into());
    }
    let mut receipt = ProviderActionReceipt {
        schema: ACTION_RECEIPT_SCHEMA,
        action_id: current.action_id.clone(),
        idempotency_key: current.idempotency_key.clone(),
        approval_receipt_digest: current.approval_receipt_digest.clone(),
        state: next,
        mutation_truth: match mutation_truth {
            ProviderMutationTruth::None => "none",
            ProviderMutationTruth::Confirmed => "confirmed",
            ProviderMutationTruth::Unknown => "unknown",
        }
        .into(),
        attempt: current.attempt.saturating_add(1),
        previous_receipt_digest: Some(current.receipt_digest.clone()),
        observed_at_ms,
        receipt_digest: String::new(),
    };
    receipt.receipt_digest = action_receipt_digest(&receipt)?;
    Ok(receipt)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_enabled_connector() -> RemoteProviderConnectorManifest {
        RemoteProviderConnectorManifest {
            connector_id: "fixture-connector".into(),
            connector_revision: "test-1".into(),
            provider_id: "fixture-provider".into(),
            provider_display_name: "Fixture Provider".into(),
            product_name: "Fixture Tunnel".into(),
            transport: "https-tunnel".into(),
            availability: "enabled".into(),
            approval_enabled: true,
            attested: true,
            execution_owner: "native-typed-connector".into(),
            auth_mode: "provider-owned-browser".into(),
            stable_https_name: true,
            supported_public_ports: vec![443],
            allowed_plan_operations: vec!["inspect-status".into()],
            limitations: vec!["Test memory fixture only".into()],
            source_urls: vec!["https://example.test/fixture".into()],
        }
    }

    #[test]
    fn product_registry_contains_no_actionable_or_fake_connector() {
        let registry = registry().expect("closed registry");
        assert!(registry
            .connectors
            .iter()
            .all(|connector| !approval_available(connector)));
        assert!(registry
            .connectors
            .iter()
            .all(|connector| !connector.connector_id.contains("fake")));
        assert_eq!(registry.connectors.len(), 2);
    }

    #[test]
    fn registry_rejects_duplicate_connector_id_across_revisions() {
        let registry = registry().expect("closed registry");

        let mut distinct_registry = registry.clone();
        let mut distinct = distinct_registry.connectors[0].clone();
        distinct.connector_id = "fixture-distinct-connector".into();
        distinct.connector_revision = "test-2".into();
        distinct_registry.connectors.push(distinct);
        let distinct_json = serde_json::to_string(&distinct_registry).expect("distinct fixture");
        parse_registry(&distinct_json).expect("distinct connectorId remains valid");

        let mut duplicate_registry = registry;
        let mut duplicate = duplicate_registry.connectors[0].clone();
        duplicate.connector_revision = "test-2".into();
        duplicate_registry.connectors.push(duplicate);
        let duplicate_json = serde_json::to_string(&duplicate_registry).expect("duplicate fixture");
        assert!(parse_registry(&duplicate_json).is_err());
    }

    #[test]
    fn product_connector_rejects_action_approval() {
        let registry = registry().expect("closed registry");
        let connector = &registry.connectors[0];
        let digest = connector_manifest_digest(&registry.registry_revision, connector)
            .expect("manifest digest");
        assert!(issue_action_approval(
            connector,
            "123e4567-e89b-42d3-a456-426614174000",
            &"a".repeat(64),
            &digest,
            &"b".repeat(64),
            &"c".repeat(32),
            &"d".repeat(32),
            1_700_000_000_000,
        )
        .is_err());
    }

    #[test]
    fn fake_connector_proves_exact_approval_chain_and_no_blind_retry() {
        let connector = fake_enabled_connector();
        let approval = issue_action_approval(
            &connector,
            "123e4567-e89b-42d3-a456-426614174000",
            &"a".repeat(64),
            &"b".repeat(64),
            &"c".repeat(64),
            &"d".repeat(32),
            &"e".repeat(32),
            1_700_000_000_000,
        )
        .expect("fixture approval");
        assert!(!approval.secrets_accepted_by_editkin);
        assert!(approval.provider_owned_login);
        let initial =
            begin_action_receipt(&approval, 1_700_000_000_001).expect("initial action receipt");
        let auth = transition_action_receipt(
            &initial,
            ProviderActionState::ProviderAuthRequired,
            ProviderMutationTruth::None,
            1_700_000_000_002,
        )
        .expect("provider-owned auth state");
        let running = transition_action_receipt(
            &auth,
            ProviderActionState::ProviderActionRunning,
            ProviderMutationTruth::None,
            1_700_000_000_003,
        )
        .expect("running state");
        let unknown = transition_action_receipt(
            &running,
            ProviderActionState::ProviderActionReconciliationRequired,
            ProviderMutationTruth::Unknown,
            1_700_000_000_004,
        )
        .expect("unknown result must reconcile");
        assert!(transition_action_receipt(
            &unknown,
            ProviderActionState::ProviderActionRunning,
            ProviderMutationTruth::Unknown,
            1_700_000_000_005,
        )
        .is_err());
        let reconciled = transition_action_receipt(
            &unknown,
            ProviderActionState::AwaitingDesktopApproval,
            ProviderMutationTruth::Confirmed,
            1_700_000_000_005,
        )
        .expect("read-only reconcile confirms exact result");
        assert_eq!(
            reconciled.state,
            ProviderActionState::AwaitingDesktopApproval
        );
        assert_eq!(
            reconciled.previous_receipt_digest,
            Some(unknown.receipt_digest)
        );
    }

    #[test]
    fn receipt_tamper_and_duplicate_transition_fail_closed() {
        let connector = fake_enabled_connector();
        let approval = issue_action_approval(
            &connector,
            "123e4567-e89b-42d3-a456-426614174000",
            &"a".repeat(64),
            &"b".repeat(64),
            &"c".repeat(64),
            &"d".repeat(32),
            &"e".repeat(32),
            10,
        )
        .expect("fixture approval");
        let initial = begin_action_receipt(&approval, 11).expect("initial receipt");
        assert!(transition_action_receipt(
            &initial,
            ProviderActionState::ApprovedNotStarted,
            ProviderMutationTruth::None,
            12,
        )
        .is_err());
        let mut tampered = initial;
        tampered.action_id = "f".repeat(32);
        assert!(transition_action_receipt(
            &tampered,
            ProviderActionState::ProviderAuthRequired,
            ProviderMutationTruth::None,
            12,
        )
        .is_err());
    }
}
