// SentinelFlow — la porte HTTP, logée dans automation-receiver (le projet est
// au plafond des 100 fonctions ; ce point d'entrée est déjà la porte publique
// des événements entrants).
//
//   POST …/automation-receiver?sentinel=<jeton>   — un outil de sécurité envoie
//        ses alertes. Le jeton peut aussi venir de l'en-tête x-sentinel-token
//        ou de Authorization: Bearer (dans ce cas ?sentinel=hook).
//   POST …/automation-receiver?sentinel=admin     — l'écran SentinelFlow :
//        créer / modifier une source, faire tourner un jeton, prévisualiser une
//        correspondance, tester une interrogation, importer, trier maintenant.
//        Authentifié par la session de l'utilisateur.

import { jsonResponse } from "./cors.ts";
import { createServiceClient, createUserClient } from "./supabase-admin.ts";
import { enforceRateLimit } from "./rate-limit.ts";
import { encryptSecret } from "./crypto.ts";
import { timingSafeEqual } from "./authz.ts";
import {
  extractItems, hashToken, ingest, normalizeAlert, parseTextBody, pollSource, presetOf, sentinelTick, triagePending,
  VENDOR_PRESETS, type FieldKey, type SourceRow,
} from "./sentinel.ts";

const MAX_BODY = 5 * 1024 * 1024;

export function isSentinelRequest(url: URL): boolean {
  return url.searchParams.has("sentinel") || url.pathname.endsWith("/sentinel");
}

export async function handleSentinel(req: Request, url: URL): Promise<Response> {
  const param = url.searchParams.get("sentinel") ?? "";
  if (param === "admin") return handleAdmin(req);
  if (param === "presets") return jsonResponse({ presets: VENDOR_PRESETS });
  if (param === "tick") return handleTick(req);
  return handleHook(req, url, param);
}

// ── Le passage planifié ──────────────────────────────────────────────────────
// Appelé chaque minute par pg_cron (migration 0262). Authentifié par le secret
// interne dédié (x-tick-secret, le même que l'envoi des tâches d'agents) et non
// par la clé de service : c'est la correspondance exacte de cette clé qui a
// cassé le planificateur des missions.
async function handleTick(req: Request): Promise<Response> {
  const secret = Deno.env.get("AGENT_TICK_SECRET");
  const given = req.headers.get("x-tick-secret") ?? "";
  if (!secret || !timingSafeEqual(given, secret)) return jsonResponse({ error: "Unauthorized" }, { status: 401 });
  const r = await sentinelTick(createServiceClient(), 40_000);
  return jsonResponse({ ok: true, ...r });
}

// ── Réception ────────────────────────────────────────────────────────────────

async function handleHook(req: Request, url: URL, param: string): Promise<Response> {
  if (req.method !== "POST") return jsonResponse({ error: "POST attendu" }, { status: 405 });
  const bearer = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const token = req.headers.get("x-sentinel-token")
    ?? (param && param !== "hook" ? param : null)
    ?? url.searchParams.get("token")
    ?? (bearer.startsWith("sen_") ? bearer : null);
  if (!token || !token.startsWith("sen_")) return jsonResponse({ error: "Jeton SentinelFlow manquant" }, { status: 401 });

  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY) return jsonResponse({ error: "Lot trop volumineux (5 Mo max)" }, { status: 413 });

  const admin = createServiceClient();
  const { data } = await admin.from("sentinel_sources").select("*").eq("token_hash", await hashToken(token)).maybeSingle();
  const source = data as (SourceRow & { enabled: boolean }) | null;
  // Même réponse pour un jeton inconnu et une source désactivée : ne rien
  // apprendre à qui essaie des jetons.
  if (!source || !source.enabled) return jsonResponse({ error: "Jeton SentinelFlow invalide" }, { status: 401 });

  const limited = await enforceRateLimit({ scope: "sentinel:hook", identity: source.id, limit: 600, windowSeconds: 60 });
  if (limited) return limited;

  const text = await req.text();
  if (text.length > MAX_BODY) return jsonResponse({ error: "Lot trop volumineux (5 Mo max)" }, { status: 413 });
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = null; }
  const items = body !== null ? extractItems(body, presetOf(source.vendor), source.items_path) : parseTextBody(text);
  if (!items.length) return jsonResponse({ ok: true, accepted: 0 });

  const r = await ingest(admin, source, items);
  // 202 : reçu. Le tri suit, par le planificateur — un outil de sécurité qui
  // attend sa réponse réessaie sur un délai dépassé, et doublerait le lot.
  return jsonResponse({ ok: true, accepted: r.created, duplicates: r.duplicates, rejected: r.errors }, { status: 202 });
}

// ── Administration ───────────────────────────────────────────────────────────

const newToken = () => `sen_${Array.from(crypto.getRandomValues(new Uint8Array(20))).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
const KINDS = ["webhook", "poll", "internal", "agent", "manual"];

function cleanMapping(raw: unknown): Partial<Record<FieldKey, string[]>> {
  const out: Partial<Record<FieldKey, string[]>> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const list = (Array.isArray(v) ? v : String(v ?? "").split(","))
      .map((x) => String(x).trim()).filter((x) => /^[\w@.$\-[\]]+$/.test(x)).slice(0, 8);
    if (list.length) out[k as FieldKey] = list;
  }
  return out;
}

async function handleAdmin(req: Request): Promise<Response> {
  const auth = req.headers.get("authorization");
  if (!auth) return jsonResponse({ error: "Session requise" }, { status: 401 });
  const { data: u } = await createUserClient(auth).auth.getUser();
  if (!u.user) return jsonResponse({ error: "Session invalide" }, { status: 401 });

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const action = String(body.action ?? "");
  const admin = createServiceClient();

  // La source visée (si l'action en vise une) fixe l'espace ; sinon c'est le
  // corps. Dans les deux cas l'appelant doit en être membre, et administrateur
  // pour tout ce qui ouvre une porte ou touche un secret.
  let source: (SourceRow & { token_hint: string | null }) | null = null;
  if (body.source_id) {
    const { data } = await admin.from("sentinel_sources").select("*").eq("id", String(body.source_id)).maybeSingle();
    source = data as typeof source;
    if (!source) return jsonResponse({ error: "Source introuvable" }, { status: 404 });
  }
  const workspaceId = source?.workspace_id ?? String(body.workspace_id ?? "");
  const projectId = source?.project_id ?? String(body.project_id ?? "");
  if (!workspaceId || !projectId) return jsonResponse({ error: "workspace_id et project_id requis" }, { status: 400 });
  const { data: mem } = await admin.from("workspace_members").select("role")
    .eq("workspace_id", workspaceId).eq("user_id", u.user.id).maybeSingle();
  const role = (mem as { role?: string } | null)?.role;
  if (!role) return jsonResponse({ error: "Accès refusé" }, { status: 403 });
  const isAdmin = role === "owner" || role === "admin";
  const needsAdmin = ["create_source", "update_source", "rotate_token", "delete_source"].includes(action);
  if (needsAdmin && !isAdmin) return jsonResponse({ error: "Réservé aux administrateurs de l'espace" }, { status: 403 });

  if (action === "create_source" || action === "update_source") {
    const kind = String(body.kind ?? source?.kind ?? "webhook");
    if (!KINDS.includes(kind)) return jsonResponse({ error: "Genre de source inconnu" }, { status: 400 });
    const pollIn = (body.poll && typeof body.poll === "object" ? body.poll : source?.poll ?? {}) as Record<string, unknown>;
    const poll = {
      url: String(pollIn.url ?? "").slice(0, 2000),
      method: String(pollIn.method ?? "GET").toUpperCase() === "POST" ? "POST" : "GET",
      body: String(pollIn.body ?? "").slice(0, 8000),
      auth: ["none", "bearer", "basic", "header"].includes(String(pollIn.auth)) ? String(pollIn.auth) : "none",
      header_name: String(pollIn.header_name ?? "").replace(/[^\w-]/g, "").slice(0, 60),
      internal: ["scan_findings", "gov_incidents", "policy_blocks"].includes(String(pollIn.internal)) ? String(pollIn.internal) : "scan_findings",
    };
    if (kind === "poll" && !/^https:\/\//i.test(poll.url)) return jsonResponse({ error: "L'URL d'interrogation doit être en HTTPS" }, { status: 400 });

    const row: Record<string, unknown> = {
      name: String(body.name ?? source?.name ?? "Source").slice(0, 120),
      kind, vendor: VENDOR_PRESETS.some((p) => p.key === body.vendor) ? body.vendor : source?.vendor ?? "generic",
      items_path: body.items_path != null ? String(body.items_path).slice(0, 200) || null : source?.items_path ?? null,
      mapping: body.mapping !== undefined ? cleanMapping(body.mapping) : source?.mapping ?? {},
      poll, poll_interval_minutes: Math.min(Math.max(Number(body.poll_interval_minutes ?? 5) || 5, 1), 1440),
      enabled: body.enabled !== undefined ? body.enabled === true : source?.enabled ?? true,
      updated_at: new Date().toISOString(),
    };
    if (typeof body.secret === "string" && body.secret) {
      const enc = await encryptSecret(body.secret);
      row.secret_ciphertext = enc.ciphertext; row.secret_iv = enc.iv;
    } else if (body.clear_secret === true) {
      row.secret_ciphertext = null; row.secret_iv = null;
    }
    let token: string | null = null;
    if (action === "create_source") {
      if (kind === "webhook") {
        token = newToken();
        row.token_hash = await hashToken(token);
        row.token_hint = token.slice(-4);
      }
      const { data, error } = await admin.from("sentinel_sources")
        .insert({ ...row, workspace_id: workspaceId, project_id: projectId, created_by: u.user.id }).select("id").maybeSingle();
      if (error) return jsonResponse({ error: error.message }, { status: 400 });
      // Le jeton n'est rendu QU'UNE fois : seul son empreinte est gardée.
      return jsonResponse({ ok: true, id: (data as { id: string }).id, token });
    }
    const { error } = await admin.from("sentinel_sources").update(row).eq("id", source!.id);
    return error ? jsonResponse({ error: error.message }, { status: 400 }) : jsonResponse({ ok: true });
  }

  if (action === "rotate_token") {
    if (!source) return jsonResponse({ error: "source_id requis" }, { status: 400 });
    const token = newToken();
    await admin.from("sentinel_sources").update({ token_hash: await hashToken(token), token_hint: token.slice(-4), kind: "webhook" }).eq("id", source.id);
    return jsonResponse({ ok: true, token });
  }

  if (action === "delete_source") {
    if (!source) return jsonResponse({ error: "source_id requis" }, { status: 400 });
    await admin.from("sentinel_sources").delete().eq("id", source.id);
    return jsonResponse({ ok: true });
  }

  // Prévisualiser : un exemple de charge utile → ce que SentinelFlow en lirait.
  // Rien n'est enregistré.
  if (action === "preview") {
    const preset = presetOf(String(body.vendor ?? source?.vendor ?? "generic"));
    const sample = String(body.sample ?? "");
    let parsed: unknown;
    try { parsed = JSON.parse(sample); } catch { parsed = null; }
    const items = parsed !== null ? extractItems(parsed, preset, (body.items_path as string) ?? source?.items_path) : parseTextBody(sample);
    const mapping = body.mapping !== undefined ? cleanMapping(body.mapping) : source?.mapping ?? {};
    const out = [];
    for (const it of items.slice(0, 5)) out.push(await normalizeAlert(it, preset, mapping, "preview"));
    return jsonResponse({ ok: true, count: items.length, alerts: out });
  }

  // Tester une interrogation : la vraie requête, les vraies alertes, enregistrées.
  if (action === "poll_now") {
    if (!source) return jsonResponse({ error: "source_id requis" }, { status: 400 });
    const r = await pollSource(admin, source);
    return jsonResponse({ ok: !r.error, ...r });
  }

  if (action === "import") {
    if (!source) return jsonResponse({ error: "source_id requis" }, { status: 400 });
    const text = String(body.text ?? "");
    if (text.length > MAX_BODY) return jsonResponse({ error: "Import trop volumineux (5 Mo max)" }, { status: 413 });
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    const items = parsed !== null ? extractItems(parsed, presetOf(source.vendor), source.items_path) : parseTextBody(text);
    const r = await ingest(admin, source, items);
    return jsonResponse({ ok: true, ...r });
  }

  if (action === "triage_now") {
    const n = await triagePending(admin, { projectId, limit: 20, deadline: Date.now() + 40_000 });
    return jsonResponse({ ok: true, triaged: n });
  }

  return jsonResponse({ error: "Action inconnue" }, { status: 400 });
}
