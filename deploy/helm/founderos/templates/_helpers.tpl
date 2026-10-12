{{- define "founderos.labels" -}}
app.kubernetes.io/part-of: founderos
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "founderos.image" -}}
{{- $root := index . 0 -}}{{- $name := index . 1 -}}
{{- printf "%s/%s:%s" $root.Values.images.registry $name $root.Values.images.tag -}}
{{- end -}}

{{/* Le nom d'hôte d'une adresse publique (https://hôte/…). */}}
{{- define "founderos.host" -}}
{{- regexReplaceAll "^https?://([^/:]+).*$" . "${1}" -}}
{{- end -}}

{{- define "founderos.backendUrl" -}}
{{- required "backend.publicUrl est obligatoire (ex. https://api.founderos.exemple.fr)" .Values.backend.publicUrl | trimSuffix "/" -}}
{{- end -}}

{{- define "founderos.webUrl" -}}
{{- required "web.publicUrl est obligatoire (ex. https://founderos.exemple.fr)" .Values.web.publicUrl | trimSuffix "/" -}}
{{- end -}}

{{- define "founderos.supabaseUrl" -}}
{{- required "supabase.url est obligatoire" .Values.supabase.url | trimSuffix "/" -}}
{{- end -}}

{{- define "founderos.pullSecrets" -}}
{{- with .Values.images.pullSecrets }}
imagePullSecrets:
{{- range . }}
  - name: {{ . }}
{{- end }}
{{- end }}
{{- end -}}
