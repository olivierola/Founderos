# opa test policies/ -v
package ai.tools_test

import rego.v1

import data.ai.tools

reader := {"sub": "u-alice", "azp": "agent-ops-investigator", "scopes": ["ocp:read", "obs:read"], "roles": ["ai-ops-reader"]}

operator := {"sub": "u-bob", "azp": "agent-ops-change", "scopes": ["ocp:read", "ocp:restart", "alert:silence", "argocd:sync"], "roles": ["ai-ops-operator"]}

test_reader_reads_prd if {
	tools.decision == "allow" with input as {"tool": "pods_list", "cluster": "prd", "target_cluster": "prd", "params_hash": "h", "token": reader}
}

test_reader_cannot_restart if {
	tools.decision == "deny" with input as {"tool": "deployment_restart", "cluster": "npr", "target_cluster": "npr", "params_hash": "h", "token": reader}
}

test_scope_without_role_is_denied if {
	tok := object.union(reader, {"scopes": ["ocp:read", "ocp:restart"]})
	tools.decision == "deny" with input as {"tool": "deployment_restart", "cluster": "npr", "target_cluster": "npr", "params_hash": "h", "token": tok}
	tools.reason == "role_missing" with input as {"tool": "deployment_restart", "cluster": "npr", "target_cluster": "npr", "params_hash": "h", "token": tok}
}

test_operator_restarts_npr_without_approval if {
	tools.decision == "allow" with input as {"tool": "deployment_restart", "cluster": "npr", "target_cluster": "npr", "params_hash": "h", "token": operator}
}

test_operator_restart_prd_needs_approval if {
	tools.decision == "approval_required" with input as {"tool": "deployment_restart", "cluster": "prd", "target_cluster": "prd", "params_hash": "h", "token": operator}
}

test_operator_restart_hub_needs_approval if {
	tools.decision == "approval_required" with input as {"tool": "deployment_restart", "cluster": "hub", "target_cluster": "hub", "params_hash": "h", "token": operator}
	tools.decision == "approval_required" with input as {"tool": "app_sync", "cluster": "hub", "target_cluster": "hub", "params_hash": "h", "token": operator}
}

test_prd_restart_allowed_with_approval_from_someone_else if {
	approval := {"id": "a1", "tool": "deployment_restart", "target_cluster": "prd", "params_hash": "h", "approver": "u-carol"}
	tools.decision == "allow" with input as {"tool": "deployment_restart", "cluster": "prd", "target_cluster": "prd", "params_hash": "h", "token": operator, "approval": approval}
}

test_self_approval_is_not_valid if {
	approval := {"id": "a1", "tool": "deployment_restart", "target_cluster": "prd", "params_hash": "h", "approver": "u-bob"}
	tools.decision == "approval_required" with input as {"tool": "deployment_restart", "cluster": "prd", "target_cluster": "prd", "params_hash": "h", "token": operator, "approval": approval}
}

test_approval_bound_to_params if {
	approval := {"id": "a1", "tool": "deployment_restart", "target_cluster": "prd", "params_hash": "other", "approver": "u-carol"}
	tools.decision == "approval_required" with input as {"tool": "deployment_restart", "cluster": "prd", "target_cluster": "prd", "params_hash": "h", "token": operator, "approval": approval}
}

test_app_sync_absent_from_prd if {
	tools.decision == "deny" with input as {"tool": "app_sync", "cluster": "prd", "target_cluster": "prd", "params_hash": "h", "token": operator}
	tools.reason == "not_in_catalog" with input as {"tool": "app_sync", "cluster": "prd", "target_cluster": "prd", "params_hash": "h", "token": operator}
}

test_hub_silence_targeting_prd_needs_approval if {
	tools.decision == "approval_required" with input as {"tool": "alert_silence_create", "cluster": "hub", "target_cluster": "prd", "params_hash": "h", "token": operator}
}

test_hub_silence_targeting_npr_allowed if {
	tools.decision == "allow" with input as {"tool": "alert_silence_create", "cluster": "hub", "target_cluster": "npr", "params_hash": "h", "token": operator}
}

test_unknown_tool_denied if {
	tools.decision == "deny" with input as {"tool": "secrets_read", "cluster": "prd", "target_cluster": "prd", "params_hash": "h", "token": operator}
}

# ── Règles à quorum (G3) : la liste des approbateurs du jeton ──────────────

prd_restart := {"tool": "deployment_restart", "cluster": "prd", "target_cluster": "prd", "params_hash": "h", "token": operator}

test_approvers_list_without_requester_is_valid if {
	approval := {"id": "a1", "tool": "deployment_restart", "target_cluster": "prd", "params_hash": "h", "approver": "u-carol", "approvers": ["u-dave", "u-carol"]}
	tools.decision == "allow" with input as object.union(prd_restart, {"approval": approval})
}

test_requester_among_approvers_is_not_valid if {
	approval := {"id": "a1", "tool": "deployment_restart", "target_cluster": "prd", "params_hash": "h", "approver": "u-carol", "approvers": ["u-bob", "u-carol"]}
	tools.decision == "approval_required" with input as object.union(prd_restart, {"approval": approval})
}

test_cluster_quorum_requires_enough_distinct_approvers if {
	one := {"id": "a1", "tool": "deployment_restart", "target_cluster": "prd", "params_hash": "h", "approver": "u-carol"}
	twice := object.union(one, {"approvers": ["u-carol", "u-carol"]})
	two := object.union(one, {"approvers": ["u-dave", "u-carol"]})
	tools.decision == "approval_required" with input as object.union(prd_restart, {"approval": one}) with data.catalog.approval_quorum as {"prd": 2}
	tools.decision == "approval_required" with input as object.union(prd_restart, {"approval": twice}) with data.catalog.approval_quorum as {"prd": 2}
	tools.decision == "allow" with input as object.union(prd_restart, {"approval": two}) with data.catalog.approval_quorum as {"prd": 2}
}

test_cluster_quorum_applies_to_its_cluster_only if {
	tools.decision == "allow" with input as {"tool": "deployment_restart", "cluster": "npr", "target_cluster": "npr", "params_hash": "h", "token": operator} with data.catalog.approval_quorum as {"prd": 2}
}
