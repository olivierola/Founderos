# Autorisation des tools MCP — interrogée par chaque serveur MCP avant l'appel
# (POST /v1/data/ai/tools/decision), après vérification du jeton d'appel et du
# jeton d'approbation.
#
# Entrée (construite par MCP/src/lib/policy.ts) :
#   input.tool            nom du tool
#   input.cluster         cluster qui héberge le serveur MCP (hub, ips, sdb, npr, prd)
#   input.target_cluster  cluster sur lequel l'action porte (= cluster, sauf tools
#                         du Hub/IPS qui visent un autre cluster)
#   input.params_hash     sha256 des paramètres canoniques
#   input.token           { sub, azp, scopes: [...], roles: [...] }
#   input.approval        { id, tool, target_cluster, params_hash, approver, approvers }
#                         si un jeton d'approbation valide accompagne l'appel
#                         (approvers : tous les approbateurs d'une règle à quorum)
#
# Par rapport à l'annexe A6 : le scope du jeton ne suffit pas. Keycloak place un
# client scope dans le jeton sans regarder les rôles de l'utilisateur ; le scope
# doit donc AUSSI être accordé par un de ses rôles (data.catalog.role_scopes).

package ai.tools

import rego.v1

default decision := "deny"

required_scope := data.catalog.scopes[input.tool]

in_catalog if input.tool in data.catalog.tools[input.cluster]

scope_in_token if required_scope in input.token.scopes

scope_granted_by_role if {
	some role in input.token.roles
	required_scope in data.catalog.role_scopes[role]
}

authorized if {
	in_catalog
	scope_in_token
	scope_granted_by_role
}

needs_approval if {
	input.tool in data.catalog.approval_required[input.target_cluster]
	not valid_approval
}

# Tous les approbateurs : la liste du jeton (règle à quorum, G3), sinon le seul approbateur.
approvers := {a | some a in input.approval.approvers} if {
	is_array(input.approval.approvers)
} else := {input.approval.approver}

# Approbateurs distincts exigés pour le cluster cible ; 1 par défaut.
required_quorum := q if {
	q := data.catalog.approval_quorum[input.target_cluster]
} else := 1

valid_approval if {
	input.approval.tool == input.tool
	input.approval.target_cluster == input.target_cluster
	input.approval.params_hash == input.params_hash
	input.approval.approver != input.token.sub
	not input.token.sub in approvers
	count(approvers) >= required_quorum
}

decision := "allow" if {
	authorized
	not needs_approval
}

decision := "approval_required" if {
	authorized
	needs_approval
}

# Motif lisible du refus, pour l'audit et la métrique ai_tool_denied_total.
reason := "not_in_catalog" if not in_catalog

reason := "scope_missing" if {
	in_catalog
	not scope_in_token
}

reason := "role_missing" if {
	in_catalog
	scope_in_token
	not scope_granted_by_role
}

reason := "approval_required" if {
	authorized
	needs_approval
}

reason := "ok" if decision == "allow"
