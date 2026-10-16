{{/* Un module (server) : mcp-<server>. Plusieurs (servers) : un serveur par cluster, mcp-<cluster>. */}}
{{- define "mcp.name" -}}
{{- if .Values.servers -}}
{{- printf "mcp-%s" (required "cluster est obligatoire" .Values.cluster) -}}
{{- else -}}
{{- printf "mcp-%s" (required "server ou servers est obligatoire" .Values.server) -}}
{{- end -}}
{{- end -}}

{{- define "mcp.serverKey" -}}
{{- if .Values.servers -}}{{ join "," .Values.servers }}{{- else -}}{{ .Values.server }}{{- end -}}
{{- end -}}

{{- define "mcp.audience" -}}
{{- if .Values.servers -}}
{{- default (include "mcp.name" .) .Values.audience -}}
{{- else -}}
{{- default (printf "mcp-%s-%s" .Values.server (required "cluster est obligatoire" .Values.cluster)) .Values.audience -}}
{{- end -}}
{{- end -}}

{{- define "mcp.labels" -}}
app.kubernetes.io/name: {{ include "mcp.name" . }}
app.kubernetes.io/part-of: ai-platform
app.kubernetes.io/component: mcp-server
ai.platform/cluster: {{ .Values.cluster }}
{{- end -}}

{{- define "mcp.selector" -}}
app.kubernetes.io/name: {{ include "mcp.name" . }}
{{- end -}}

{{- define "mcp.tlsSecret" -}}
{{- default (printf "%s-tls" (include "mcp.name" .)) .Values.tls.secretName -}}
{{- end -}}

{{/* Namespaces où lier les comptes dédiés : rbac.namespaces, sinon ceux de la configuration OpenShift. */}}
{{- define "mcp.rbacNamespaces" -}}
{{- $ns := .Values.rbac.namespaces -}}
{{- if not $ns -}}
{{- if .Values.config.openshift -}}
{{- $ns = .Values.config.openshift.namespaces | default list -}}
{{- else -}}
{{- $ns = .Values.config.namespaces | default list -}}
{{- end -}}
{{- end -}}
{{- toJson $ns -}}
{{- end -}}
