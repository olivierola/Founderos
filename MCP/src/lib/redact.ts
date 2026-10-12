// Masquage avant tout renvoi à l'agent (première des deux passes ; la seconde,
// données personnelles, est le garde-fou Presidio de LiteLLM).
//
// Les logs et événements de production contiennent des jetons, des mots de
// passe et des chaînes de connexion : rien de cela ne doit atteindre le modèle
// ni la trace d'audit. Les motifs visent large ; un faux positif coûte une
// valeur masquée, un faux négatif une fuite.

const MASK = "[MASQUÉ]";

const PATTERNS: Array<[RegExp, string | ((...m: string[]) => string)]> = [
  // Blocs de clé privée PEM.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, `-----PRIVATE KEY ${MASK}-----`],
  // JWT (trois segments base64url, en-tête JSON « eyJ »).
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, MASK],
  // En-têtes et schémas d'authentification.
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, (_m, scheme) => `${scheme} ${MASK}`],
  // Identifiants dans une URL : scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)([^:@\s/]+):([^@\s/]+)@/gi, (_m, scheme, user) => `${scheme}${user}:${MASK}@`],
  // Clés d'accès cloud et jetons de plateformes connues.
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
  [/\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g, MASK],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, MASK],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, MASK],
  [/\bhvs\.[A-Za-z0-9_-]{20,}\b/g, MASK],
  // Paires clé=valeur ou "clé": "valeur" dont la clé désigne un secret.
  [
    /((?:["']?)(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?|auth)(?:["']?)\s*[:=]\s*)(["']?)([^"'\s,;}&]{3,})\2/gi,
    (_m, prefix, quote) => `${prefix}${quote}${MASK}${quote}`,
  ],
  // Chaînes de connexion type ADO/JDBC : Password=...;
  [/\b(Password|Pwd|AccountKey|SharedAccessKey)=([^;"'\s]+)/gi, (_m, key) => `${key}=${MASK}`],
];

export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement as string);
  }
  return out;
}

/** Masque récursivement les chaînes d'une valeur JSON. */
export function redactValue<T>(value: T): T {
  if (typeof value === "string") return redact(value) as T;
  if (Array.isArray(value)) return value.map(redactValue) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValue(v)])) as T;
  }
  return value;
}
