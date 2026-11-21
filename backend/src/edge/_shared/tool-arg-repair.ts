// GÉNÉRÉ par backend/scripts/port-edge.mjs depuis supabase/functions/_shared/tool-arg-repair.ts.
// Ne pas modifier à la main : corriger la source puis relancer `npm run port:edge`.

// La réparation des arguments d'outil, d'après le plugin tool-input-repair
// d'OpenCode.
//
// Un modèle se trompe souvent de FORME, rarement d'intention : `"20"` pour un
// nombre, un objet sérialisé dans une chaîne, `"web"` pour l'enum `"WEB"`,
// `filePath` pour `file_path`, une valeur seule là où le schéma attend une
// liste. Refuser l'appel coûte un tour entier pour une correction que le
// schéma permet de faire sans ambiguïté. On répare donc AVANT de valider, et
// seulement quand le schéma dit sans hésitation ce qui était voulu :
//
//   - objet ou liste sérialisés dans une chaîne → reparsés ;
//   - nombre / booléen écrits en chaîne → convertis ;
//   - nombre ou booléen là où une chaîne est attendue → écrits en chaîne ;
//   - valeur seule là où une liste est attendue → mise en liste ;
//   - enum à la casse ou aux espaces près → valeur canonique ;
//   - `null` sur un champ facultatif → retiré ;
//   - clé inconnue qui ne diffère d'une clé connue que par la casse, les
//     tirets ou le camelCase → renommée ;
//   - et récursivement dans les objets et les listes imbriqués.
//
// Rien n'est inventé : un champ obligatoire absent reste absent, une chaîne
// qui n'est pas un nombre reste une chaîne — la validation le refuse ensuite
// avec un message que le modèle peut corriger.

type Schema = Record<string, unknown>;

export interface ArgRepair {
  args: Record<string, unknown>;
  /** Ce qui a été corrigé, lisible (« limit : "20" → 20 »). Vide : rien. */
  repairs: string[];
}

const MAX_DEPTH = 6;

/** Une clé ramenée à sa forme comparable : `filePath`, `file-path`, `File_Path` → `filepath`. */
const keyForm = (k: string) => k.replace(/[^A-Za-z0-9]/g, "").toLowerCase();

function typesOf(schema: Schema | undefined): string[] {
  if (!schema) return [];
  const t = schema.type;
  if (typeof t === "string") return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === "string");
  // anyOf / oneOf de types simples (« string | null ») : on lit leurs types.
  const alts = (Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : []) as Schema[];
  return alts.flatMap((a) => typesOf(a));
}

function matchesType(v: unknown, t: string): boolean {
  switch (t) {
    case "string": return typeof v === "string";
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "integer": return typeof v === "number" && Number.isInteger(v);
    case "boolean": return typeof v === "boolean";
    case "array": return Array.isArray(v);
    case "object": return !!v && typeof v === "object" && !Array.isArray(v);
    case "null": return v === null;
    default: return true;
  }
}

function parseJson(s: string): unknown {
  const t = s.trim();
  if (!t || (t[0] !== "{" && t[0] !== "[")) return undefined;
  try { return JSON.parse(t); } catch { return undefined; }
}

/** Une valeur tentée vers UN type cible, ou `undefined` si ce n'est pas sûr. */
function coerce(v: unknown, t: string): unknown {
  if (matchesType(v, t)) return v;
  if (t === "number" || t === "integer") {
    if (typeof v === "string" && /^\s*-?\d+(\.\d+)?([eE][+-]?\d+)?\s*$/.test(v)) {
      const n = Number(v);
      if (t === "integer" && !Number.isInteger(n)) return undefined;
      return n;
    }
    return undefined;
  }
  if (t === "boolean") {
    if (typeof v === "string") {
      const s = v.trim().toLowerCase();
      if (s === "true") return true;
      if (s === "false") return false;
    }
    return undefined;
  }
  if (t === "string") {
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return undefined;
  }
  if (t === "object") {
    if (typeof v === "string") {
      const p = parseJson(v);
      return p && typeof p === "object" && !Array.isArray(p) ? p : undefined;
    }
    return undefined;
  }
  if (t === "array") {
    if (typeof v === "string") {
      const p = parseJson(v);
      if (Array.isArray(p)) return p;
    }
    // Une valeur seule là où une liste est attendue : la liste d'un élément.
    // Jamais pour null/undefined (un champ absent n'est pas une liste vide).
    if (v !== null && v !== undefined && !Array.isArray(v)) return [v];
    return undefined;
  }
  return undefined;
}

function repairValue(v: unknown, schema: Schema | undefined, path: string, repairs: string[], depth: number): unknown {
  if (!schema || depth > MAX_DEPTH) return v;
  const types = typesOf(schema);
  let out = v;

  if (types.length && !types.some((t) => matchesType(out, t))) {
    // Le premier type non nul qui accepte la valeur gagne : « string | null »
    // reçoit 5 → "5", jamais null.
    for (const t of types.filter((x) => x !== "null")) {
      const c = coerce(out, t);
      if (c !== undefined) {
        repairs.push(`${path} : ${short(out)} → ${short(c)}`);
        out = c;
        break;
      }
    }
  }

  // Enum à la casse et aux espaces près.
  const allowed = Array.isArray(schema.enum) ? schema.enum : null;
  if (allowed && typeof out === "string" && !allowed.includes(out)) {
    const norm = (x: unknown) => String(x).trim().toLowerCase().replace(/[\s-]+/g, "_");
    const hit = allowed.find((e) => norm(e) === norm(out));
    if (hit !== undefined) {
      repairs.push(`${path} : ${short(out)} → ${short(hit)}`);
      out = hit;
    }
  }

  if (Array.isArray(out) && schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
    const items = schema.items as Schema;
    out = out.map((x, i) => repairValue(x, items, `${path}[${i}]`, repairs, depth + 1));
  } else if (out && typeof out === "object" && !Array.isArray(out) && schema.properties) {
    out = repairObject(out as Record<string, unknown>, schema, path, repairs, depth + 1);
  }
  return out;
}

function repairObject(
  obj: Record<string, unknown>, schema: Schema, path: string, repairs: string[], depth: number,
): Record<string, unknown> {
  const props = (schema.properties && typeof schema.properties === "object" ? schema.properties : {}) as Record<string, Schema>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as unknown[]).filter((k): k is string => typeof k === "string") : []);
  const known = Object.keys(props);
  const byForm = new Map(known.map((k) => [keyForm(k), k]));
  const out: Record<string, unknown> = {};
  const at = (k: string) => (path ? `${path}.${k}` : k);

  for (const [rawKey, value] of Object.entries(obj)) {
    let key = rawKey;
    if (!(key in props)) {
      const canonical = byForm.get(keyForm(key));
      // Renommée seulement si la clé canonique n'est pas aussi fournie : deux
      // valeurs pour un même champ, on ne choisit pas à la place du modèle.
      if (canonical && !(canonical in obj)) {
        repairs.push(`${at(rawKey)} → ${canonical}`);
        key = canonical;
      }
    }
    if (value === null && key in props && !required.has(key) && !typesOf(props[key]).includes("null")) {
      repairs.push(`${at(key)} : null retiré (facultatif)`);
      continue;
    }
    out[key] = key in props ? repairValue(value, props[key], at(key), repairs, depth) : value;
  }
  return out;
}

function short(v: unknown): string {
  const s = typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) ?? String(v);
  return s.length > 40 ? `${s.slice(0, 37)}…` : s;
}

/** Les arguments réparés d'après le schéma de l'outil. Sans schéma : tels quels. */
export function repairToolArgs(args: Record<string, unknown>, schema: Schema | undefined): ArgRepair {
  const repairs: string[] = [];
  if (!schema || typeof schema !== "object" || !args || typeof args !== "object") return { args, repairs };
  if (!schema.properties || typeof schema.properties !== "object") return { args, repairs };
  const fixed = repairObject(args, schema, "", repairs, 0);
  return { args: repairs.length ? fixed : args, repairs };
}

// ── Les noms d'outils ────────────────────────────────────────────────────────

/** Les noms que les modèles rapportent d'autres harnais. Utilisés SEULEMENT
 *  quand l'outil appelé n'existe pas et que la cible existe dans la boîte. */
const NAME_ALIASES: Record<string, string[]> = {
  bash: ["shell_exec", "runner_shell_exec", "sandbox_shell_exec", "team_shell"],
  shell: ["shell_exec", "runner_shell_exec", "sandbox_shell_exec", "team_shell"],
  run_command: ["shell_exec", "runner_shell_exec", "sandbox_shell_exec", "team_shell"],
  execute_command: ["shell_exec", "runner_shell_exec", "sandbox_shell_exec", "team_shell"],
  terminal: ["shell_exec", "runner_shell_exec", "sandbox_shell_exec", "team_shell"],
  search: ["web_search"],
  google_search: ["web_search"],
  internet_search: ["web_search"],
  websearch: ["web_search"],
  fetch: ["read_url", "http_get"],
  fetch_url: ["read_url", "http_get"],
  webfetch: ["read_url", "http_get"],
  browse: ["read_url"],
  open_url: ["read_url"],
  read_file: ["file_read", "runner_file_read", "sandbox_file_read"],
  read: ["file_read", "runner_file_read", "sandbox_file_read"],
  write_file: ["file_write", "runner_file_write", "sandbox_file_write"],
  write: ["file_write", "runner_file_write", "sandbox_file_write"],
  todowrite: ["update_todos"],
  todo_write: ["update_todos"],
  ask: ["ask_user"],
  question: ["ask_user"],
};

/**
 * Le vrai nom d'un outil appelé sous un nom qui n'existe pas, ou null.
 *
 * Préfixes d'espace de noms retirés (`functions.`, `default_api.`, `tools.`),
 * camelCase et tirets ramenés au snake_case, puis les alias des autres
 * harnais. Un nom déjà connu n'est jamais touché.
 */
export function resolveToolName(name: string, known: (n: string) => boolean): string | null {
  if (!name || known(name)) return null;
  const stripped = name.replace(/^(functions|default_api|tools|tool|api)[.:]/i, "");
  const snake = stripped
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s.-]+/g, "_")
    .toLowerCase();
  for (const candidate of [stripped, snake]) {
    if (candidate !== name && known(candidate)) return candidate;
  }
  for (const target of NAME_ALIASES[snake] ?? []) {
    if (known(target)) return target;
  }
  return null;
}
