{{- define "relay.fullname" -}}
{{- printf "%s-%s" .Release.Name "connector-relay" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "relay.labels" -}}
app.kubernetes.io/name: founderos-connector-relay
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end -}}

{{- define "relay.selector" -}}
app.kubernetes.io/name: founderos-connector-relay
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "relay.serviceAccount" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "relay.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "relay.secretName" -}}
{{- default (include "relay.fullname" .) .Values.existingSecret -}}
{{- end -}}
