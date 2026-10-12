// Gardes d'autorisation — portage de supabase/functions/_shared/authz.ts.
//
// Les routes interrogent la base avec la clé service role, qui ignore RLS.
// L'autorisation n'est donc pas assurée par Postgres : toute route qui accepte
// un identifiant de ressource venu du corps de la requête appelle un des gardes
// ci-dessous AVANT de toucher à quoi que ce soit (audit 2026-09, FOS-01/FOS-02).
//
// Différence avec la version edge : un refus LÈVE une HttpError (rendue en
// `{ ok: false, error, message }` par le gestionnaire d'erreurs) au lieu de
// renvoyer une Response. Le motif d'appel devient :
//
//   const auth = await requireProjectMember(req, project_id);
//   // ici, auth.userId / auth.workspaceId sont sûrs

import { timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { env } from "../env.ts";
import { HttpError } from "./http.ts";
import { createServiceClient, createUserClient } from "./supabase.ts";

/** Rôles d'un membre de workspace, du plus faible au plus fort. */
export type WorkspaceRole = "viewer" | "member" | "editor" | "admin" | "owner";

const ROLE_RANK: Record<string, number> = {
  viewer: 0,
  member: 1,
  editor: 2,
  admin: 3,
  owner: 4,
};

export interface AuthContext {
  userId: string;
  workspaceId: string;
  /** Renseigné par les gardes qui partent d'un projet ou d'une ressource. */
  projectId: string | null;
  role: string;
}

const deny = (message: string, status: number) =>
  new HttpError(status, message, { extra: { ok: false, message } });

/** Compare deux secrets sans fuiter leur préfixe commun par le temps d'exécution. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && nodeTimingSafeEqual(bufA, bufB);
}

/** L'appelant présente-t-il la clé service role ? (appels machine-à-machine) */
export function isServiceCaller(req: Request): boolean {
  const token = (req.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  return timingSafeEqual(token, env.supabaseServiceRoleKey);
}

/**
 * Résout l'utilisateur derrière la requête. Ne dit RIEN de ses droits — c'est
 * l'authentification seule, et elle ne suffit jamais : l'inscription étant
 * ouverte, « authentifié » veut dire « n'importe qui ».
 */
export async function requireUser(req: Request): Promise<string> {
  const authHeader = req.get("Authorization");
  if (!authHeader) throw deny("Missing Authorization header", 401);
  const { data, error } = await createUserClient(authHeader).auth.getUser();
  if (error || !data.user) throw deny("Invalid session", 401);
  return data.user.id;
}

function assertRole(role: unknown, minRole: WorkspaceRole) {
  const rank = ROLE_RANK[String(role)] ?? 0;
  if (rank < (ROLE_RANK[minRole] ?? 0)) {
    throw deny(`This action requires the '${minRole}' role or higher`, 403);
  }
}

/** Appartenance à un workspace, avec rôle minimum optionnel. */
export async function requireWorkspaceMember(
  req: Request,
  workspaceId: string | null | undefined,
  minRole: WorkspaceRole = "viewer",
): Promise<AuthContext> {
  if (!workspaceId) throw deny("workspace_id required", 400);

  const userId = await requireUser(req);

  const { data: member } = await createServiceClient()
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();

  // Un non-membre reçoit 403 et rien d'autre : pas de distinction entre
  // « ce workspace n'existe pas » et « vous n'y êtes pas », qui servirait à
  // énumérer les workspaces existants.
  if (!member) throw deny("Not authorized for this workspace", 403);
  assertRole(member.role, minRole);

  return { userId, workspaceId, projectId: null, role: String(member.role) };
}

/**
 * Appartenance au workspace QUI POSSÈDE le projet.
 *
 * Le workspace est résolu depuis la table `projects`, jamais depuis le corps de
 * la requête : c'est précisément l'inversion qui rendait FOS-09 exploitable —
 * on vérifiait l'appartenance à un workspace fourni par l'appelant, puis on
 * chargeait une ressource qui appartenait à un autre.
 */
export async function requireProjectMember(
  req: Request,
  projectId: string | null | undefined,
  minRole: WorkspaceRole = "viewer",
): Promise<AuthContext> {
  if (!projectId) throw deny("project_id required", 400);

  const userId = await requireUser(req);

  const admin = createServiceClient();
  const { data: project } = await admin
    .from("projects")
    .select("workspace_id")
    .eq("id", projectId)
    .maybeSingle();
  if (!project) throw deny("Not authorized for this project", 403);

  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", project.workspace_id)
    .eq("user_id", userId)
    .maybeSingle();
  if (!member) throw deny("Not authorized for this project", 403);
  assertRole(member.role, minRole);

  return { userId, workspaceId: project.workspace_id, projectId, role: String(member.role) };
}

/**
 * Appartenance déduite d'une ressource quelconque : on lit son `project_id` sur
 * sa propre ligne, puis on applique requireProjectMember.
 *
 * C'est le garde des routes dont le corps ne transporte qu'un `server_id` ou
 * un `job_id`. Faire résoudre le projet par la ressource elle-même donnait
 * l'illusion d'un cadrage (« le workspace vient bien de la base ») alors que
 * rien ne reliait ce workspace à l'appelant.
 */
export async function requireResourceAccess(
  req: Request,
  table: string,
  resourceId: string | null | undefined,
  minRole: WorkspaceRole = "viewer",
): Promise<AuthContext & { resource: Record<string, unknown> }> {
  if (!resourceId) throw deny(`${table} id required`, 400);

  const { data: row } = await createServiceClient()
    .from(table)
    .select("*")
    .eq("id", resourceId)
    .maybeSingle();
  if (!row) throw deny("Not found or not authorized", 403);

  const projectId = (row as { project_id?: string }).project_id ?? null;
  if (!projectId) throw deny("Resource is not scoped to a project", 403);

  const auth = await requireProjectMember(req, projectId, minRole);
  return { ...auth, resource: row as Record<string, unknown> };
}

/**
 * Cohérence projet ↔ workspace quand l'appelant fournit les deux.
 * À utiliser lorsqu'une route doit écrire les deux colonnes : sans ce
 * contrôle, on peut rattacher une ligne au projet d'autrui sous son propre
 * workspace, et inversement.
 */
export async function assertProjectInWorkspace(
  projectId: string,
  workspaceId: string,
): Promise<boolean> {
  const { data } = await createServiceClient()
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  return !!data;
}
