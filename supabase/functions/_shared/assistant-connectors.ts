// L'assistant et les outils internes (connecteurs personnalisés, 0267).
//
// L'assistant RÉDIGE : il pose un brouillon de connecteur à partir d'un modèle
// (Argo CD, Vault, Grafana…) ou de ce qu'il sait de l'API décrite, avec les
// opérations, le schéma d'authentification et la politique. Il ne manipule
// JAMAIS de secret : un jeton collé dans la conversation est refusé, la saisie
// se fait dans le formulaire du connecteur (chiffrée, liée à l'URL). Un
// brouillon est inerte ; l'activer et le confier à un collaborateur reste une
// décision d'owner ou d'admin.

import {
  type OpsActor, type OpsResult, type UiBlock, appBase, findAgent, resolveService,
} from "./assistant-ops.ts";
import {
  type AuthScheme, type ConnectorOperation, CONNECTOR_TEMPLATES, connectorSetupIssues, findTemplate,
  normalizeAuthConfig, normalizeOperations, normalizePolicy, toSlug,
} from "./custom-connector-model.ts";

const RANK: Record<string, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };
const atLeast = (a: OpsActor, role: "member" | "admin") => (RANK[a.role] ?? 0) >= RANK[role];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCHEMES: AuthScheme[] = [
  "none", "bearer", "api_key", "basic", "headers",
  "oauth2_client_credentials", "oauth2_authorization_code", "session_login", "mtls",
];

const str = (v: unknown, d = "") => (typeof v === "string" ? v : typeof v === "number" ? String(v) : d);
const text = (t: string, ui?: UiBlock[]): OpsResult => (ui?.length ? { text: t, ui } : { text: t });

// ── Aucun secret par ici ─────────────────────────────────────────────────────

const SECRET_KEYS = /^(token|access_token|refresh_token|id_token|password|passwd|client_secret|secret|secret_id|api_key|apikey|private_key|bearer|authorization|cookie|x-vault-token|private-token|cf-access-client-secret)$/i;
const SECRET_SHAPES = [
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /\bhv[sbr]\.[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bglpat-[A-Za-z0-9_-]{20,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** Le premier endroit où un secret semble avoir été glissé, ou null. */
function findSecret(v: unknown, path = ""): string | null {
  if (typeof v === "string") {
    if (/\{\{secret:[A-Za-z0-9_-]+\}\}/.test(v)) return null;
    return SECRET_SHAPES.some((re) => re.test(v)) ? path || "valeur" : null;
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const hit = findSecret(v[i], `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      // Les définitions de paramètres d'opération s'appellent parfois « token » : ce sont des noms, pas des valeurs.
      if (k === "params" && Array.isArray(x)) continue;
      if (SECRET_KEYS.test(k) && typeof x === "string" && x.trim() && !/^\{\{secret:/.test(x)) return `${path}.${k}`.replace(/^\./, "");
      const hit = findSecret(x, `${path}.${k}`.replace(/^\./, ""));
      if (hit) return hit;
    }
  }
  return null;
}

// ── Lectures ─────────────────────────────────────────────────────────────────

interface ConnRow {
  id: string; name: string; slug: string; description: string | null; status: string;
  base_url: string; transport: "direct" | "relay"; relay_id: string | null;
  auth_scheme: AuthScheme; auth_config: unknown; operations: unknown; policy: unknown;
  service_dashboard_id: string | null; setup_notes: string | null; template_key: string | null;
}
const CONN_COLS = "id, name, slug, description, status, base_url, transport, relay_id, auth_scheme, auth_config, operations, policy, service_dashboard_id, setup_notes, template_key";

async function findConnector(a: OpsActor, ref: string): Promise<ConnRow | string> {
  const r = ref.trim();
  if (!r) return "ERREUR : précise le connecteur (nom, slug ou id).";
  let q = a.admin.from("custom_connectors").select(CONN_COLS).eq("project_id", a.projectId);
  if (UUID.test(r)) q = q.eq("id", r);
  else q = q.or(`slug.eq.${toSlug(r)},name.ilike.${r.replace(/[,()*%\\]/g, " ")}`);
  const { data } = await q.limit(5);
  const rows = (data ?? []) as ConnRow[];
  if (rows.length === 1) return rows[0];
  if (!rows.length) return `ERREUR : aucun outil interne « ${r} ». Utilise action=list.`;
  return `ERREUR : plusieurs outils internes correspondent : ${rows.map((x) => `${x.name} (${x.id})`).join(", ")}.`;
}

async function credentialCount(a: OpsActor, id: string): Promise<number> {
  const { count } = await a.admin.from("custom_connector_credentials")
    .select("id", { count: "exact", head: true }).eq("connector_id", id).eq("status", "active");
  return count ?? 0;
}

async function relayByRef(a: OpsActor, ref: string): Promise<{ id: string; name: string } | string> {
  const { data } = await a.admin.from("connector_relays").select("id, name, status")
    .eq("project_id", a.projectId).eq("status", "active");
  const rows = (data ?? []) as Array<{ id: string; name: string }>;
  const want = ref.trim().toLowerCase();
  const hit = rows.find((r) => r.id === ref.trim() || r.name.toLowerCase() === want) ?? rows.find((r) => r.name.toLowerCase().includes(want));
  return hit ?? `ERREUR : relais « ${ref} » introuvable. Relais : ${rows.map((r) => r.name).join(", ") || "aucun (à créer depuis la page Outils internes)"}.`;
}

async function connectorCard(a: OpsActor, c: { id: string; name: string; service_dashboard_id: string | null }, description: string): Promise<UiBlock[]> {
  const base = await appBase(a, c.service_dashboard_id ?? a.dashboardId);
  return base ? [{ component: "link_card", props: { title: `Ouvrir ${c.name}`, description, url: `${base}/connectors/internal?connector=${c.id}` } }] : [];
}

function describe(c: ConnRow, creds: number): string {
  const ops = normalizeOperations(c.operations);
  const issues = connectorSetupIssues(c, creds);
  const policy = normalizePolicy(c.policy);
  return [
    `${c.name} (slug ${c.slug}, id ${c.id}) · ${c.status === "active" ? "actif" : c.status === "draft" ? "brouillon" : "désactivé"}`,
    `URL : ${c.base_url || "à renseigner"} · transport : ${c.transport === "relay" ? "relais" : "direct"} · auth : ${c.auth_scheme} · ${creds} profil(s) d'identifiants`,
    `Opérations (${ops.length}) : ${ops.map((o) => `${o.name} [${o.risk}]`).join(", ") || "aucune"}`,
    `Politique : approbation ${policy.approval}${policy.read_only ? ", lecture seule" : ""}${policy.allow_raw ? `, requête brute ${policy.raw_methods.join("/")} sur ${policy.path_allowlist.join(", ") || "aucun chemin"}` : ""}`,
    issues.length ? `À compléter : ${issues.join(" ")}` : "Prêt.",
  ].join("\n");
}

// ── L'outil ──────────────────────────────────────────────────────────────────

const READS = ["list_templates", "list", "get", "list_relays"];
const WRITES = ["draft", "update", "activate", "attach"];
export const CONNECTOR_ACTIONS = [...READS, ...WRITES];

const ALIASES: Record<string, string> = {
  templates: "list_templates", create: "draft", new: "draft", create_draft: "draft",
  edit: "update", enable: "activate", grant: "attach", give: "attach", relays: "list_relays",
};

const PARAMS_DOC =
  "list_templates: {}. list: {}. get: {connector}. list_relays: {}. " +
  "draft: {name, template? (argocd, vault, grafana, loki, prometheus, alertmanager, kubernetes, helm, jenkins, gitlab, sonarqube, generic), " +
  "base_url?, transport? ('direct' | 'relay'), relay? (nom), auth_scheme?, auth_config? (NON secret : header, prefix, name, in, username, token_url, authorize_url, client_id, scope, audience, login_path, login_body avec des marqueurs {{secret:nom}}, token_path, header_names, extra_headers), " +
  "operations? (remplace : [{name, description, method, path avec {param}, query, body, params:[{name, type, required, description, enum, allow_slash}], risk: read|write|destructive, output: full|redact|keys_only}] ; ou kind:'exec' + binary + args pour une CLI sur le relais), " +
  "add_operations?, policy? ({approval: writes|all|destructive_only, read_only, allow_raw, raw_methods, path_allowlist}), description?, setup_notes? (ce qu'il reste à faire à la main), service? (nom, ou 'projet' pour tout le projet)}. " +
  "update: {connector, mêmes champs, add_operations?, remove_operations?: [nom]}. activate: {connector, confirm}. " +
  "attach: {connector, agent, operations?: [nom] (vide : toutes), credential? (libellé du profil)}.";

export const CONNECTOR_OPS_DESCRIPTION =
  "Outils internes de l'entreprise (Argo CD, Vault, Grafana, Loki, Kubernetes, Helm, API maison…) : lister les modèles, " +
  "rédiger un BROUILLON de connecteur à compléter (URL, auth, opérations, politique), le modifier, l'activer, le confier à un collaborateur. " +
  "Tu ne reçois et ne transmets JAMAIS de secret : les identifiants se saisissent dans le formulaire du connecteur (carte « Ouvrir »). " +
  "Marque [destructive] tout geste irréversible (rollback, suppression, mise à l'échelle) et [write] toute écriture.";

export function connectorOpsToolDef(name = "manage_connectors") {
  return {
    name,
    description: CONNECTOR_OPS_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: CONNECTOR_ACTIONS, description: "L'opération. Lectures : " + READS.join(", ") + "." },
        params: { type: "object", description: PARAMS_DOC },
      },
      required: ["action"],
      additionalProperties: false,
    },
  };
}

export const CONNECTOR_OPS_DOCTRINE = [
  "OUTILS INTERNES (manage_connectors)",
  "- Pour un outil hébergé par l'entreprise (Argo CD, Vault, Grafana, Loki, Prometheus, Kubernetes, Helm, Jenkins, GitLab, SonarQube, API maison) : draft avec le modèle qui correspond, sinon des opérations écrites d'après la documentation officielle de l'API. Lecture d'abord ; chaque écriture marquée write, chaque geste irréversible destructive.",
  "- Une URL interne (.svc, .local, .corp, IP privée) passe par un relais : transport='relay'. Pas de relais encore : dis-le, il se crée depuis la page Outils internes.",
  "- JAMAIS de secret dans la conversation. Si on t'en colle un, refuse de l'utiliser, conseille de le révoquer, et renvoie vers la carte « Ouvrir » du connecteur.",
  "- Le brouillon est inerte. Termine en listant ce qui reste à compléter à la main. activate et attach seulement si on te le demande.",
].join("\n");

export async function runConnectorOps(a: OpsActor, rawAction: string, params: Record<string, unknown>): Promise<OpsResult> {
  const action = ALIASES[rawAction] ?? rawAction;
  if (!CONNECTOR_ACTIONS.includes(action)) {
    return text(`ERREUR : l'action « ${rawAction} » n'existe pas. Actions : ${CONNECTOR_ACTIONS.join(", ")}.`);
  }
  const p = params ?? {};
  if (WRITES.includes(action)) {
    if (!atLeast(a, "member")) return text(`ACCÈS REFUSÉ : le rôle « ${a.role} » ne permet pas de modifier les outils internes.`);
    const leaked = findSecret(p);
    if (leaked) {
      return text(
        `REFUSÉ : un secret semble présent (${leaked}). Je ne manipule aucun identifiant : retire-le de la conversation, ` +
        "révoque-le s'il a été partagé, puis saisis-le dans le formulaire du connecteur (chiffré, jamais montré aux collaborateurs).",
      );
    }
  }
  const db = a.admin;

  switch (action) {
    case "list_templates":
      return text(CONNECTOR_TEMPLATES.map((t) =>
        `- ${t.key} : ${t.name} (${t.category}) · ${t.operations.length} opérations · auth ${t.auth_scheme} · ${t.default_transport === "relay" ? "relais conseillé" : "direct possible"}`).join("\n"));

    case "list": {
      const { data } = await db.from("custom_connectors").select(CONN_COLS).eq("project_id", a.projectId).order("name");
      const rows = (data ?? []) as ConnRow[];
      if (!rows.length) return text("Aucun outil interne. Propose un brouillon à partir d'un modèle (action=list_templates).");
      const lines = await Promise.all(rows.map(async (c) => {
        const n = await credentialCount(a, c.id);
        const issues = connectorSetupIssues(c, n);
        return `- ${c.name} (${c.slug}) · ${c.status} · ${normalizeOperations(c.operations).length} op. · ${issues.length ? `${issues.length} point(s) à compléter` : "prêt"}`;
      }));
      return text(lines.join("\n"));
    }

    case "get": {
      const c = await findConnector(a, str(p.connector ?? p.name ?? p.id));
      if (typeof c === "string") return text(c);
      const ops = normalizeOperations(c.operations);
      const { data: creds } = await db.from("custom_connector_credentials")
        .select("label, location, identity, expires_at").eq("connector_id", c.id).eq("status", "active");
      return text([
        describe(c, (creds ?? []).length),
        `Profils : ${((creds ?? []) as Array<{ label: string; location: string; identity: string | null }>).map((x) => `${x.label} (${x.location === "relay" ? "secret chez le relais" : "chiffré"}${x.identity ? `, ${x.identity}` : ""})`).join(", ") || "aucun"}`,
        "Détail des opérations :",
        ...ops.map((o) => `- ${o.name} [${o.risk}] ${o.kind === "exec" ? `${o.binary} ${(o.args ?? []).join(" ")}` : `${o.method} ${o.path}`} : ${o.description}`),
        c.setup_notes ? `Notes : ${c.setup_notes}` : "",
      ].filter(Boolean).join("\n"), await connectorCard(a, c, "Fiche du connecteur"));
    }

    case "list_relays": {
      const { data } = await db.from("connector_relays").select("name, status, last_seen_at, hostname, reported_hosts")
        .eq("project_id", a.projectId).order("name");
      const rows = (data ?? []) as Array<{ name: string; status: string; last_seen_at: string | null; hostname: string | null; reported_hosts: string[] }>;
      if (!rows.length) return text("Aucun relais. Il se crée depuis la page Outils internes (onglet Relais), puis se déploie chez vous (Docker ou chart Helm).");
      return text(rows.map((r) => {
        const online = r.status === "active" && r.last_seen_at && Date.now() - Date.parse(r.last_seen_at) < 90_000;
        return `- ${r.name} · ${r.status === "revoked" ? "révoqué" : online ? "en ligne" : "hors ligne"}${r.hostname ? ` · ${r.hostname}` : ""}${r.reported_hosts?.length ? ` · hôtes autorisés : ${r.reported_hosts.join(", ")}` : ""}`;
      }).join("\n"));
    }

    case "draft":
    case "update": {
      let existing: ConnRow | null = null;
      if (action === "update") {
        const c = await findConnector(a, str(p.connector ?? p.id));
        if (typeof c === "string") return text(c);
        existing = c;
        if (c.status !== "draft" && !atLeast(a, "admin")) {
          return text("ACCÈS REFUSÉ : modifier un outil interne actif est réservé aux owners et admins.");
        }
      }
      const tpl = action === "draft" && str(p.template) ? findTemplate(str(p.template)) : undefined;
      if (action === "draft" && str(p.template) && !tpl) {
        return text(`ERREUR : modèle « ${str(p.template)} » inconnu. Modèles : ${CONNECTOR_TEMPLATES.map((t) => t.key).join(", ")}.`);
      }
      const name = str(p.name).trim() || existing?.name || tpl?.name || "";
      if (!name) return text("ERREUR : donne un nom au connecteur (ex. « Argo CD prod »).");

      const patch: Record<string, unknown> = {};
      const notes: string[] = [];
      if (action === "draft" || p.name !== undefined) patch.name = name.slice(0, 80);
      if (p.description !== undefined || tpl) patch.description = str(p.description) || tpl?.description || null;
      if (p.base_url !== undefined) {
        const u = str(p.base_url).trim();
        if (u && !/^https?:\/\/[^/\s]+/i.test(u)) return text("ERREUR : base_url doit commencer par http(s)://hôte.");
        patch.base_url = u;
      } else if (action === "draft") patch.base_url = "";
      const transport = p.transport === "relay" || p.transport === "direct" ? p.transport : action === "draft" ? tpl?.default_transport ?? "relay" : undefined;
      if (transport) patch.transport = transport;
      if (str(p.relay)) {
        const r = await relayByRef(a, str(p.relay));
        if (typeof r === "string") notes.push(r.replace(/^ERREUR : /, ""));
        else { patch.relay_id = r.id; patch.transport = "relay"; }
      } else if (action === "draft" && transport === "relay") {
        const { data } = await db.from("connector_relays").select("id, name").eq("project_id", a.projectId).eq("status", "active");
        const relays = (data ?? []) as Array<{ id: string; name: string }>;
        if (relays.length === 1) { patch.relay_id = relays[0].id; notes.push(`Relais « ${relays[0].name} » choisi (le seul de l'espace).`); }
      }
      const scheme = str(p.auth_scheme) as AuthScheme;
      if (scheme && !SCHEMES.includes(scheme)) return text(`ERREUR : auth_scheme inconnu. Valeurs : ${SCHEMES.join(", ")}.`);
      if (scheme || tpl) patch.auth_scheme = scheme || tpl!.auth_scheme;
      if (p.auth_config !== undefined || tpl) {
        patch.auth_config = normalizeAuthConfig({
          ...(tpl?.auth_config ?? {}),
          ...((existing?.auth_config as Record<string, unknown>) ?? {}),
          ...((p.auth_config && typeof p.auth_config === "object") ? p.auth_config as Record<string, unknown> : {}),
        });
      }
      let ops: ConnectorOperation[] = normalizeOperations(existing?.operations ?? tpl?.operations ?? []);
      if (Array.isArray(p.operations)) ops = normalizeOperations(p.operations);
      if (Array.isArray(p.add_operations)) {
        const add = normalizeOperations(p.add_operations);
        ops = [...ops.filter((o) => !add.some((x) => x.name === o.name)), ...add];
      }
      if (Array.isArray(p.remove_operations)) {
        const drop = new Set((p.remove_operations as unknown[]).map(String));
        ops = ops.filter((o) => !drop.has(o.name));
      }
      if (action === "draft" || p.operations !== undefined || p.add_operations !== undefined || p.remove_operations !== undefined) {
        patch.operations = ops;
      }
      if (p.policy !== undefined || tpl) {
        patch.policy = normalizePolicy({
          ...(tpl?.policy ?? {}),
          ...((existing?.policy as Record<string, unknown>) ?? {}),
          ...((p.policy && typeof p.policy === "object") ? p.policy as Record<string, unknown> : {}),
        });
      }
      if (p.setup_notes !== undefined || tpl) patch.setup_notes = str(p.setup_notes) || tpl?.setup_notes || null;
      if (p.service !== undefined || action === "draft") {
        const ref = str(p.service).trim();
        if (/^(projet|project|tous|all|aucun)$/i.test(ref)) patch.service_dashboard_id = null;
        else if (ref) {
          const s = await resolveService(a, ref);
          if (typeof s === "string") return text(s);
          patch.service_dashboard_id = s.id;
        } else patch.service_dashboard_id = a.dashboardId;
      }

      let row: ConnRow;
      if (action === "draft") {
        let slug = toSlug(str(p.slug) || name);
        const { data: taken } = await db.from("custom_connectors").select("slug").eq("project_id", a.projectId).like("slug", `${slug}%`);
        const used = new Set(((taken ?? []) as Array<{ slug: string }>).map((t) => t.slug));
        for (let i = 2; used.has(slug); i++) slug = `${toSlug(str(p.slug) || name).slice(0, 44)}-${i}`;
        const { data, error } = await db.from("custom_connectors").insert({
          ...patch, slug, workspace_id: a.workspaceId, project_id: a.projectId, status: "draft",
          template_key: tpl?.key ?? null, created_via: "assistant", created_by: a.userId,
        }).select(CONN_COLS).single();
        if (error || !data) return text(`ERREUR : création impossible (${error?.message ?? "inconnu"}).`);
        row = data as ConnRow;
      } else {
        const { data, error } = await db.from("custom_connectors").update(patch).eq("id", existing!.id).select(CONN_COLS).single();
        if (error || !data) return text(`ERREUR : mise à jour impossible (${error?.message ?? "inconnu"}).`);
        row = data as ConnRow;
        if (existing!.base_url !== row.base_url && existing!.base_url) {
          notes.push("L'URL a changé : les secrets déjà saisis ne partiront plus tant qu'ils n'auront pas été ressaisis.");
        }
      }
      const n = await credentialCount(a, row.id);
      return text(
        `${action === "draft" ? "Brouillon créé" : "Connecteur mis à jour"}.\n${describe(row, n)}${notes.length ? `\n${notes.join("\n")}` : ""}\n` +
        "Les secrets se saisissent dans la fiche (carte ci-dessous), jamais ici.",
        await connectorCard(a, row, action === "draft" ? "Compléter l'URL et le secret" : "Fiche du connecteur"),
      );
    }

    case "activate": {
      if (!atLeast(a, "admin")) return text("ACCÈS REFUSÉ : activer un outil interne est réservé aux owners et admins.");
      const c = await findConnector(a, str(p.connector ?? p.id));
      if (typeof c === "string") return text(c);
      const issues = connectorSetupIssues(c, await credentialCount(a, c.id));
      if (issues.length) return text(`Pas encore activable. À compléter : ${issues.join(" ")}`, await connectorCard(a, c, "Compléter"));
      if (p.confirm !== true && p.confirm !== "true") {
        return text(`Activer ${c.name} le rend utilisable par les collaborateurs à qui il est confié. Demande l'accord, puis rappelle avec confirm=true.`);
      }
      await db.from("custom_connectors").update({ status: "active" }).eq("id", c.id);
      return text(`${c.name} est actif.`);
    }

    case "attach": {
      if (!atLeast(a, "admin")) return text("ACCÈS REFUSÉ : confier un outil interne à un collaborateur est réservé aux owners et admins.");
      const c = await findConnector(a, str(p.connector ?? p.id));
      if (typeof c === "string") return text(c);
      const ag = await findAgent(a, str(p.agent ?? p.agent_id));
      if (typeof ag === "string") return text(ag);
      if (c.service_dashboard_id && ag.service_dashboard_id !== c.service_dashboard_id) {
        return text("ERREUR : ce connecteur est réservé à un autre service que celui de ce collaborateur.");
      }
      const known = new Set(normalizeOperations(c.operations).map((o) => o.name).concat("request"));
      const wanted = (Array.isArray(p.operations) ? p.operations : []).map(String).filter(Boolean);
      const unknown = wanted.filter((w) => !known.has(w));
      if (unknown.length) return text(`ERREUR : opérations inconnues : ${unknown.join(", ")}.`);
      let credentialId: string | null = null;
      if (str(p.credential)) {
        const { data } = await db.from("custom_connector_credentials").select("id, label")
          .eq("connector_id", c.id).eq("status", "active");
        const hit = ((data ?? []) as Array<{ id: string; label: string }>)
          .find((x) => x.id === str(p.credential) || x.label.toLowerCase() === str(p.credential).toLowerCase());
        if (!hit) return text(`ERREUR : profil d'identifiants « ${str(p.credential)} » introuvable.`);
        credentialId = hit.id;
      }
      const config = { connector_id: c.id, slug: c.slug, operations: wanted, credential_id: credentialId };
      const { data: prior } = await db.from("internal_agent_tools").select("id")
        .eq("agent_id", ag.id).eq("kind", "custom_connector").contains("config", { connector_id: c.id }).maybeSingle();
      const res = prior
        ? await db.from("internal_agent_tools").update({ config, enabled: true }).eq("id", (prior as { id: string }).id)
        : await db.from("internal_agent_tools").insert({
            agent_id: ag.id, kind: "custom_connector", name: `${c.name} (outil interne)`,
            description: c.description, config, requires_approval: false,
          });
      if (res.error) return text(`ERREUR : ${res.error.message}`);
      return text(
        `${ag.name} peut utiliser ${c.name}${wanted.length ? ` (opérations : ${wanted.join(", ")})` : " (toutes les opérations)"}.` +
        (c.status !== "active" ? " Le connecteur est encore un brouillon : il ne sera visible qu'une fois activé." : ""),
      );
    }
  }
  return text("ERREUR : action non gérée.");
}
