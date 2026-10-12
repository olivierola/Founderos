{{- define "gw.fullname" -}}
{{- if contains "gateway" .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-gateway" .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "gw.labels" -}}
app.kubernetes.io/name: founderos-gateway
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/part-of: founderos
{{- end -}}

{{- define "gw.selector" -}}
app.kubernetes.io/name: founderos-gateway
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "gw.serviceAccount" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "gw.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "gw.relaySecret" -}}
{{- default (printf "%s-relay" (include "gw.fullname" .)) .Values.relay.existingSecret -}}
{{- end -}}

{{- define "gw.mcpEnabled" -}}
{{- if .Values.mcp.servers -}}true{{- end -}}
{{- end -}}

{{- define "gw.seedSecret" -}}
{{- default (printf "%s-token-seed" (include "gw.fullname" .)) .Values.mcp.auth.seedSecret -}}
{{- end -}}

{{- define "gw.tokensSecret" -}}
{{- default (printf "%s-mcp-tokens" (include "gw.fullname" .)) .Values.mcp.auth.tokensSecret -}}
{{- end -}}

{{/* La liste blanche du relais, plus le serveur MCP voisin sur la boucle locale. */}}
{{- define "gw.allowedHosts" -}}
{{- $hosts := list -}}
{{- range (splitList "," .Values.relay.allowedHosts) -}}{{- if trim . -}}{{- $hosts = append $hosts (trim .) -}}{{- end -}}{{- end -}}
{{- if include "gw.mcpEnabled" . -}}{{- $hosts = append $hosts (printf "127.0.0.1:%v" .Values.mcp.port) -}}{{- end -}}
{{- join "," $hosts -}}
{{- end -}}
