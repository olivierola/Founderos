// Garde d'autorisation partagé.
//
// POURQUOI CE FICHIER EXISTE
// Presque toutes les fonctions edge sont déployées en `verify_jwt = false` et
// interrogent la base avec la clé service role, qui ignore RLS. L'autorisation
// n'est donc plus assurée par Postgres : chaque fonction doit la refaire à la
// main. Elle a été oubliée dans une dizaine d'entre elles (audit 2026-09,
// FOS-01/FOS-02), avec pour conséquence qu'un compte gratuit pouvait piloter
// l'infrastructure d'un autre client.
//
// La règle, désormais : toute fonction qui accepte un identifiant de ressource
// venu du corps de la requête appelle un des gardes ci-dessous AVANT de toucher
// à quoi que ce soit. Ils échouent en refusant — jamais en laissant passer.
//
// Chaque garde renvoie soit le contexte autorisé, soit une Response prête à
// renvoyer. Le motif d'appel :
//
//   const auth = await requireProjectMember(req, project_id);
//   if (!auth.ok) return auth.response;
//   // ici, auth.userId / auth.workspaceId sont sûrs

import { jsonResponse } from "./cors.ts";
import { createServiceClient, createUserClient } from "./supabase-admin.ts";

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
  ok: true;
  userId: string;
  workspaceId: string;
  /** Renseigné par les gardes qui partent d'un projet ou d'une ressource. */
  projectId: string | null;
  role: string;
}

export interface AuthFailure {
  ok: false;
  response: Response;
}

export type AuthResult = AuthContext | AuthFailure;

const fail = (message: string, status: number): AuthFailure => ({
  ok: false,
  response: jsonResponse({ ok: false, error: message, message }, { status }),
});

/** Compare deux secrets sans fuiter leur préfixe commun par le temps d'exécution. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** L'appelant présente-t-il la clé service role ? (appels machine-à-machine) */
export function isServiceCaller(req: Request): boolean {
  const header = req.headers.get("Authorization") ?? "";
  const token = header.replace(/^Bearer\s+/i, "");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  return !!key && timingSafeEqual(token, key);
}

/**
 * Résout l'utilisateur derrière la requête. Ne dit RIEN de ses droits — c'est
 * l'authentification seule, et elle ne suffit jamais : l'inscription étant
 * ouverte, « authentifié » veut dire « n'importe qui ».
 */
export async function requireUser(
  req: Request,
): Promise<{ ok: true; userId: string } | AuthFailure> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return fail("Missing Authorization header", 401);
  const { data, error } = await createUserClient(authHeader).auth.getUser();
  if (error || !data.user) return fail("Invalid session", 401);
  return { ok: true, userId: data.user.id };
}

/** Appartenance à un workspace, avec rôle minimum optionnel. */
export async function requireWorkspaceMember(
  req: Request,
  workspaceId: string | null | undefined,
  minRole: WorkspaceRole = "viewer",
): Promise<AuthResult> {
  if (!workspaceId) return fail("workspace_id required", 400);

  const user = await requireUser(req);
  if (!user.ok) return user;

  const admin = createServiceClient();
  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.userId)
    .maybeSingle();

  // Un non-membre reçoit 403 et rien d'autre : pas de distinction entre
  // « ce workspace n'existe pas » et « vous n'y êtes pas », qui servirait à
  // énumérer les workspaces existants.
  if (!member) return fail("Not authorized for this workspace", 403);

  const rank = ROLE_RANK[String(member.role)] ?? 0;
  if (rank < (ROLE_RANK[minRole] ?? 0)) {
    return fail(`This action requires the '${minRole}' role or higher`, 403);
  }

  return {
    ok: true,
    userId: user.userId,
    workspaceId,
    projectId: null,
    role: String(member.role),
  };
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
): Promise<AuthResult> {
  if (!projectId) return fail("project_id required", 400);

  const user = await requireUser(req);
  if (!user.ok) return user;

  const admin = createServiceClient();
  const { data: project } = await admin
    .from("projects")
    .select("workspace_id")
    .eq("id", projectId)
    .maybeSingle();
  if (!project) return fail("Not authorized for this project", 403);

  const { data: member } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", project.workspace_id)
    .eq("user_id", user.userId)
    .maybeSingle();
  if (!member) return fail("Not authorized for this project", 403);

  const rank = ROLE_RANK[String(member.role)] ?? 0;
  if (rank < (ROLE_RANK[minRole] ?? 0)) {
    return fail(`This action requires the '${minRole}' role or higher`, 403);
  }

  return {
    ok: true,
    userId: user.userId,
    workspaceId: project.workspace_id,
    projectId,
    role: String(member.role),
  };
}

/**
 * Appartenance déduite d'une ressource quelconque : on lit son `project_id` sur
 * sa propre ligne, puis on applique requireProjectMember.
 *
 * C'est le garde des fonctions dont le corps ne transporte qu'un `server_id` ou
 * un `job_id`. Faire résoudre le projet par la ressource elle-même donnait
 * l'illusion d'un cadrage (« le workspace vient bien de la base ») alors que
 * rien ne reliait ce workspace à l'appelant.
 */
export async function requireResourceAccess(
  req: Request,
  table: string,
  resourceId: string | null | undefined,
  minRole: WorkspaceRole = "viewer",
): Promise<AuthResult & { resource?: Record<string, unknown> }> {
  if (!resourceId) return fail(`${table} id required`, 400);

  const admin = createServiceClient();
  const { data: row } = await admin
    .from(table)
    .select("*")
    .eq("id", resourceId)
    .maybeSingle();
  if (!row) return fail("Not found or not authorized", 403);

  const projectId = (row as { project_id?: string }).project_id ?? null;
  if (!projectId) return fail("Resource is not scoped to a project", 403);

  const auth = await requireProjectMember(req, projectId, minRole);
  if (!auth.ok) return auth;
  return { ...auth, resource: row as Record<string, unknown> };
}

/**
 * Cohérence projet ↔ workspace quand l'appelant fournit les deux.
 * À utiliser lorsqu'une fonction doit écrire les deux colonnes : sans ce
 * contrôle, on peut rattacher une ligne au projet d'autrui sous son propre
 * workspace, et inversement.
 */
export async function assertProjectInWorkspace(
  projectId: string,
  workspaceId: string,
): Promise<boolean> {
  const admin = createServiceClient();
  const { data } = await admin
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  return !!data;
}
