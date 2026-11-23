// Plateforme auto-hébergée, de bout en bout : le vrai serveur (comme index.ts)
// sur une base PGlite neuve — socle + toutes les migrations —, et supabase-js
// en face, comme le front et le code des fonctions l'utilisent.
//
// Lent (les migrations, ~20 s) : PLATFORM_E2E=0 le saute.

const PORT = Number(process.env.PLATFORM_E2E_PORT ?? 18787);
process.env.PLATFORM = "self";
process.env.DATABASE_URL = process.env.PLATFORM_E2E_DATABASE_URL ?? "pglite://memory";
process.env.JWT_SECRET = "e2e-secret-e2e-secret-e2e-secret-e2e-secret";
process.env.FUNCTIONS_URL = `http://localhost:${PORT}`;
process.env.STORAGE_DIR = `${process.env.TEMP ?? "/tmp"}/founderos-e2e-storage-${process.pid}`;
process.env.MGMT_PORT = "0";
delete process.env.AUTH_SMTP_HOST;
delete process.env.RESEND_API_KEY;

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

const skip = process.env.PLATFORM_E2E === "0";

describe("plateforme auto-hébergée (supabase-js ↔ backend ↔ PostgreSQL)", { skip, timeout: 240_000 }, () => {
  let server: import("node:http").Server;
  let platform: import("./platform.ts").Platform;
  let url: string;
  let anonKey: string;
  let serviceKey: string;
  let createClient: typeof import("@supabase/supabase-js").createClient;
  const opts = { auth: { persistSession: false, autoRefreshToken: false } };

  before(async () => {
    const { env } = await import("../env.ts");
    const { startPlatform } = await import("./platform.ts");
    const { createServer } = await import("../server.ts");
    ({ createClient } = await import("@supabase/supabase-js"));
    platform = await startPlatform({
      ...env.platform!, publicUrl: env.functionsUrl, anonKey: env.supabaseAnonKey, serviceKey: env.supabaseServiceRoleKey,
    }, () => {});
    server = createServer(undefined, { platform });
    await new Promise<void>((r) => server.listen(PORT, r));
    url = env.functionsUrl;
    anonKey = env.supabaseAnonKey;
    serviceKey = env.supabaseServiceRoleKey;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await platform.close();
  });

  const email = `e2e-${Date.now()}@example.com`;
  const password = "correct horse battery staple";

  it("inscription, connexion, utilisateur, rafraîchissement, déconnexion", async () => {
    const sb = createClient(url, anonKey, opts);
    const su = await sb.auth.signUp({ email, password, options: { data: { full_name: "E2E Test" } } });
    assert.equal(su.error, null, su.error?.message);
    assert.ok(su.data.session?.access_token, "autoconfirm sans e-mail configuré : la session arrive tout de suite");
    assert.equal(su.data.user?.user_metadata.full_name, "E2E Test");

    const dup = await sb.auth.signUp({ email, password });
    assert.equal(dup.error?.code, "user_already_exists");

    const bad = await sb.auth.signInWithPassword({ email, password: "wrong" });
    assert.equal(bad.error?.code, "invalid_credentials");

    const si = await sb.auth.signInWithPassword({ email, password });
    assert.equal(si.error, null, si.error?.message);
    const u = await sb.auth.getUser();
    assert.equal(u.data.user?.email, email);
    assert.equal(u.data.user?.identities?.[0]?.provider, "email");

    const old = si.data.session!.refresh_token;
    const rf = await sb.auth.refreshSession();
    assert.equal(rf.error, null, rf.error?.message);
    assert.notEqual(rf.data.session?.refresh_token, old);

    const up = await sb.auth.updateUser({ data: { locale: "fr" } });
    assert.equal(up.data.user?.user_metadata.locale, "fr");

    await sb.auth.signOut();
    const gone = await createClient(url, anonKey, opts).auth.refreshSession({ refresh_token: rf.data.session!.refresh_token });
    assert.ok(gone.error, "après déconnexion, le jeton de rafraîchissement ne vaut plus rien");
  });

  it("les déclencheurs de l'inscription et la RLS s'appliquent comme chez Supabase", async () => {
    const sb = createClient(url, anonKey, opts);
    await sb.auth.signInWithPassword({ email, password });
    const { data: me } = await sb.auth.getUser();
    // Le profil créé par le déclencheur on_auth_user_created (0001).
    // Le déclencheur on_auth_user_created (0001, puis 0282) : un profil, un
    // espace et l'adhésion « owner » — visibles par l'utilisateur sous RLS.
    const prof = await sb.from("profiles").select("id").eq("id", me.user!.id).maybeSingle();
    assert.equal(prof.error, null, prof.error?.message);
    assert.equal(prof.data?.id, me.user!.id);
    const mine = await sb.from("workspace_members").select("role, workspaces(slug, owner_id)").eq("user_id", me.user!.id);
    assert.equal(mine.error, null, mine.error?.message);
    assert.equal(mine.data?.length, 1);
    assert.equal(mine.data?.[0].role, "owner");
    assert.equal((mine.data?.[0].workspaces as unknown as { owner_id: string }).owner_id, me.user!.id);

    // Ce que l'utilisateur voit de ses espaces, et rien de celui d'un autre.
    const admin = createClient(url, serviceKey, opts);
    const other = await admin.auth.admin.createUser({ email: `other-${Date.now()}@example.com`, password, email_confirm: true });
    assert.equal(other.error, null, other.error?.message);
    const ws = await admin.from("workspaces").insert({ name: "Autre", slug: `autre-${Date.now()}`, owner_id: other.data.user!.id }).select("id").single();
    assert.equal(ws.error, null, ws.error?.message);
    const seen = await sb.from("workspaces").select("id").eq("id", ws.data!.id);
    assert.deepEqual(seen.data, [], "RLS : l'espace d'un autre est invisible");

    const anon = await createClient(url, anonKey, opts).from("profiles").select("id");
    assert.deepEqual(anon.data, []);
  });

  it("admin : lire, bannir, supprimer un compte", async () => {
    const admin = createClient(url, serviceKey, opts);
    const c = await admin.auth.admin.createUser({ email: `ban-${Date.now()}@example.com`, password, email_confirm: true });
    const got = await admin.auth.admin.getUserById(c.data.user!.id);
    assert.equal(got.data.user?.id, c.data.user!.id);
    await admin.auth.admin.updateUserById(c.data.user!.id, { ban_duration: "24h" });
    const banned = await createClient(url, anonKey, opts).auth.signInWithPassword({ email: c.data.user!.email!, password });
    assert.equal(banned.error?.code, "user_banned");
    // Suppression douce : le déclencheur d'inscription lui a créé un espace,
    // dont la clé étrangère (sans cascade) refuse la suppression dure — chez
    // Supabase aussi.
    const hard = await admin.auth.admin.deleteUser(c.data.user!.id);
    assert.equal(hard.error?.message, "Database error deleting user");
    const del = await admin.auth.admin.deleteUser(c.data.user!.id, true);
    assert.equal(del.error, null, del.error?.message);
    assert.ok((await admin.auth.admin.getUserById(c.data.user!.id)).error, "le compte supprimé n'est plus lisible");
    const nope = await createClient(url, anonKey, opts).auth.admin.getUserById(c.data.user!.id);
    assert.ok(nope.error, "la clé anon n'ouvre pas l'API d'administration");
  });

  it("MFA : enrôlement TOTP, défi, vérification (aal2)", async () => {
    const { totpCode } = await import("./auth/totp.ts");
    const sb = createClient(url, anonKey, opts);
    await sb.auth.signInWithPassword({ email, password });
    const en = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: "app" });
    assert.equal(en.error, null, en.error?.message);
    assert.equal(en.data?.type, "totp");
    const totp = (en.data as { totp: { qr_code: string; secret: string } }).totp;
    assert.match(totp.qr_code, /^data:image\/svg\+xml/);
    const ch = await sb.auth.mfa.challenge({ factorId: en.data!.id });
    const code = totpCode(totp.secret, Math.floor(Date.now() / 30_000));
    const v = await sb.auth.mfa.verify({ factorId: en.data!.id, challengeId: ch.data!.id, code });
    assert.equal(v.error, null, v.error?.message);
    const aal = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    assert.equal(aal.data?.currentLevel, "aal2");
    const list = await sb.auth.mfa.listFactors();
    assert.equal(list.data?.totp.length, 1);
    const un = await sb.auth.mfa.unenroll({ factorId: en.data!.id });
    assert.equal(un.error, null, un.error?.message);
  });

  it("storage : envoi, lecture publique, URL signée, suppression, refus sous RLS", async () => {
    const admin = createClient(url, serviceKey, opts);
    const path = `e2e/${Date.now()}/hello.txt`;
    const upl = await admin.storage.from("office-media").upload(path, Buffer.from("bonjour"), { contentType: "text/plain" });
    assert.equal(upl.error, null, upl.error?.message);
    const pub = admin.storage.from("office-media").getPublicUrl(path);
    const res = await fetch(pub.data.publicUrl);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "bonjour");
    const signed = await admin.storage.from("office-media").createSignedUrl(path, 60);
    assert.equal(signed.error, null, signed.error?.message);
    assert.equal(await (await fetch(signed.data!.signedUrl)).text(), "bonjour");
    const dl = await admin.storage.from("office-media").download(path);
    assert.equal(await dl.data?.text(), "bonjour");
    const denied = await createClient(url, anonKey, opts).storage.from("office-media").upload(`e2e/x-${Date.now()}.txt`, Buffer.from("x"));
    assert.ok(denied.error, "anon ne peut pas écrire dans le bucket");
    const rm = await admin.storage.from("office-media").remove([path]);
    assert.equal(rm.error, null, rm.error?.message);
    assert.equal((await fetch(pub.data.publicUrl)).status, 400);
  });

  it("realtime : postgres_changes filtré, reçu par l'abonné", async () => {
    const admin = createClient(url, serviceKey, opts);
    const { data: u } = await admin.auth.admin.createUser({ email: `rt-${Date.now()}@example.com`, password, email_confirm: true });
    const { data: ws } = await admin.from("workspaces").insert({ name: "RT", slug: `rt-${Date.now()}`, owner_id: u.user!.id, plan: "enterprise" }).select("id").single();
    const { data: proj } = await admin.from("projects").insert({ workspace_id: ws!.id, name: "RT", slug: "rt" }).select("id").single();
    const { data: agent, error: ae } = await admin.from("internal_agents").insert({
      workspace_id: ws!.id, project_id: proj!.id, name: "Agent RT", created_by: u.user!.id,
    }).select("id").single();
    assert.equal(ae, null, ae?.message);
    const { data: run, error: re } = await admin.from("internal_agent_runs").insert({
      agent_id: agent!.id, workspace_id: ws!.id, project_id: proj!.id, status: "running",
    }).select("id").single();
    assert.equal(re, null, re?.message);

    const got = new Promise<Record<string, unknown>>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("aucun événement realtime reçu")), 15_000);
      const ch = admin.channel(`run-${run!.id}`)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "internal_agent_run_events", filter: `run_id=eq.${run!.id}` },
          (payload) => { clearTimeout(t); void admin.removeChannel(ch); resolve(payload.new as Record<string, unknown>); })
        .subscribe(async (status) => {
          if (status !== "SUBSCRIBED") return;
          await admin.from("internal_agent_run_events").insert({ run_id: run!.id, agent_id: agent!.id, kind: "status", payload: { message: "hello" } });
        });
    });
    const row = await got;
    assert.equal(row.run_id, run!.id);
    assert.deepEqual(row.payload, { message: "hello" });
  });

  it("les edge functions tournent contre la plateforme, et pg_net passe par les workers", async () => {
    const res = await fetch(`${url}/functions/v1/public-feature-flags`, { headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` } });
    assert.ok(res.status < 500, `public-feature-flags : ${res.status} ${await res.clone().text()}`);

    const [{ id }] = await platform.db.query<{ id: string }>("select net.http_post($1, '{}'::jsonb)::text as id", [`${url}/health`]);
    let status: number | null = null;
    for (let i = 0; i < 40 && status === null; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const [r] = await platform.db.query<{ status_code: number }>("select status_code from net._http_response where id = $1", [id]);
      if (r) status = r.status_code;
    }
    // POST sur /health : la route n'existe qu'en GET, l'important est que la requête soit partie.
    assert.ok(status !== null, "la requête pg_net a été envoyée par le worker");

    const jobs = await platform.db.query<{ jobname: string }>("select jobname from cron.job where jobname is not null");
    assert.ok(jobs.some((j) => j.jobname === "reconcile-zombie-runs"), "les tâches planifiées des migrations sont enregistrées");
    assert.ok(!jobs.some((j) => j.jobname === "drain-agent-ticks"), "plus de file de ticks (0314)");
  });

});
