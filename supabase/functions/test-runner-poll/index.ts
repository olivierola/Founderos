// test-runner-poll — the single endpoint the Playwright test runner talks to.
// Auth: X-Runner-Token (hashed, compared against ops_settings.runner_token_hash —
// the same runner identity used by the Ops module).
//
// Modes (in body):
//   { mode: "claim", runner_id }
//        → claims the next queued test_run project-wide. Returns the run plus
//          its test case context (instructions, fixtures, app_url) or null.
//
//   { mode: "observe", run_id, current_url, dom_excerpt, screenshot_url? }
//        → the runner reports what it sees after loading/acting; the agent
//          decides the next action and we return it:
//            { action: { type, selector, value, ... } }
//          Side effects by action.type:
//            ask_user → run.status = 'needs_input' (runner should idle-poll)
//            pass/fail → run finished (status passed/failed)
//
//   { mode: "poll", run_id }
//        → lightweight check for a paused (needs_input) run: returns
//          { resumed: bool } so the runner knows when the user answered.
//
//   { mode: "complete", run_id, status, error_message? }
//        → terminal report from the runner (e.g. crash/timeout).
//
// The SKILL RECORDER (skill-recorder/) shares this endpoint — same runner
// identity, same token — because the project sits at the 100 edge-function cap:
//   { mode: "rec_claim", runner_id }        → next pending skill_recording
//   { mode: "rec_events", recording_id, events[] } → append gestures; the reply
//        carries { stop } when the user pressed stop in the app
//   { mode: "rec_finish", recording_id, duration_ms? } → close the recording and
//        kick off the LLM synthesis that writes the skill

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";
import {
  decideNextAction, appendStep, actionToStep, generateRunReport, type RunContext,
} from "../_shared/test-agent.ts";
import { synthesizeSkill } from "../_shared/skill-synthesis.ts";

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A runner is authorised either by:
//   - the GLOBAL platform token (PLATFORM_RUNNER_TOKEN env) → it serves every
//     project (this is the host's single shared runner; clients never see a
//     token), or
//   - a per-project token in ops_settings.runner_token_hash (legacy / Ops).
// `projectId === null` means "global" — no per-project scoping is applied.
interface AuthOk {
  ok: true;
  projectId: string | null;
  /** Renseignés uniquement pour un APPAREIL appairé (le Skill Recorder). */
  deviceId?: string;
  workspaceId?: string;
}

async function authenticate(
  req: Request,
): Promise<AuthOk | { ok: false; reason: string }> {
  // Un appareil appairé (skill-recorder) porte sa propre identité, liée à un
  // workspace et à un utilisateur. Elle est vérifiée EN PREMIER : c'est la
  // seule qui apporte une portée, là où le token runner est global au projet.
  const deviceToken = req.headers.get("x-recorder-token");
  if (deviceToken) {
    const admin = createServiceClient();
    const { data } = await admin
      .from("recorder_devices").select("id, workspace_id, revoked_at")
      .eq("token_hash", await sha256Hex(deviceToken)).maybeSingle();
    if (!data) return { ok: false, reason: "Appareil inconnu — relancez l'appairage." };
    if (data.revoked_at) return { ok: false, reason: "Appareil révoqué — relancez l'appairage." };
    await admin.from("recorder_devices").update({ last_seen_at: new Date().toISOString() }).eq("id", data.id);
    return { ok: true, projectId: null, deviceId: data.id, workspaceId: data.workspace_id };
  }

  const token = req.headers.get("x-runner-token");
  if (!token) return { ok: false, reason: "Missing X-Runner-Token header" };

  const platform = Deno.env.get("PLATFORM_RUNNER_TOKEN");
  if (platform && token === platform) return { ok: true, projectId: null };

  const admin = createServiceClient();
  const { data } = await admin
    .from("ops_settings").select("project_id").eq("runner_token_hash", await sha256Hex(token)).maybeSingle();
  if (!data) return { ok: false, reason: "Unknown runner token" };
  return { ok: true, projectId: data.project_id };
}

/** Code d'appairage : court, dictable à voix haute, sans caractère ambigu
 *  (ni O/0 ni I/1 — il sera lu sur un terminal et retapé dans un navigateur). */
function generatePairingCode(): string {
  const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

function generateDeviceToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return "fos_rec_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const PAIRING_TTL_MS = 10 * 60_000;

// True when a run belongs to the runner's scope (global runner sees all).
function inScope(projectId: string | null, runProjectId: string): boolean {
  return projectId === null || projectId === runProjectId;
}

/** Portée d'une DÉMONSTRATION. Un appareil appairé est borné à son workspace ;
 *  un runner par projet à son projet. Les deux bornes s'appliquent quand elles
 *  existent — un appareil a un workspace mais pas de projet, d'où le besoin
 *  d'un contrôle distinct de `inScope`. */
function recordingInScope(
  rec: { project_id: string | null; workspace_id: string },
  projectId: string | null,
  deviceWorkspaceId: string | null,
): boolean {
  if (deviceWorkspaceId !== null && rec.workspace_id !== deviceWorkspaceId) return false;
  if (projectId !== null && rec.project_id !== projectId) return false;
  return true;
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  // L'APPAIRAGE précède l'authentification — par construction : un recorder qui
  // démarre pour la première fois n'a aucun secret à présenter. Ce qui protège
  // ces deux modes n'est pas un token mais le fait que le code obtenu ne sert à
  // rien tant qu'un humain authentifié dans l'app ne l'a pas saisi.
  let earlyBody: Record<string, unknown> = {};
  try { earlyBody = await req.clone().json(); } catch { /* corps illisible → auth normale */ }
  const earlyMode = String(earlyBody.mode ?? "");

  if (earlyMode === "rec_pair_start" || earlyMode === "rec_pair_poll") {
    const admin = createServiceClient();

    // rec_pair_start — l'appareil se présente et repart avec un code à afficher.
    if (earlyMode === "rec_pair_start") {
      const name = String(earlyBody.name ?? "Poste inconnu").slice(0, 80);
      // Boucle courte : une collision de code est improbable (32^8) mais
      // l'index unique la rendrait fatale, donc on réessaie.
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = generatePairingCode();
        const { data, error } = await admin.from("recorder_devices").insert({
          name,
          pairing_code: code,
          pairing_expires_at: new Date(Date.now() + PAIRING_TTL_MS).toISOString(),
        }).select("id").single();
        if (!error && data) {
          return jsonResponse({ ok: true, device_id: data.id, code, expires_in_s: PAIRING_TTL_MS / 1000 });
        }
      }
      return jsonResponse({ ok: false, message: "Impossible de générer un code d'appairage" }, { status: 500 });
    }

    // rec_pair_poll — l'appareil attend que quelqu'un ait saisi son code.
    // Le token n'est remis QU'UNE FOIS, à celui qui connaît le device_id : il
    // est effacé de la ligne juste après (seul son hash y reste).
    const deviceId = String(earlyBody.device_id ?? "");
    if (!deviceId) return jsonResponse({ ok: false, message: "device_id required" }, { status: 400 });

    const { data: dev } = await admin.from("recorder_devices")
      .select("id, workspace_id, paired_at, pairing_expires_at, token_hash")
      .eq("id", deviceId).maybeSingle();
    if (!dev) return jsonResponse({ ok: false, message: "Appareil inconnu" }, { status: 404 });

    if (!dev.paired_at) {
      const expired = dev.pairing_expires_at && Date.parse(dev.pairing_expires_at) < Date.now();
      return jsonResponse({ ok: true, paired: false, expired: !!expired });
    }

    // Le device_id est un porteur : il suffit à retirer le token. On borne donc
    // l'émission à une courte fenêtre après l'appairage — assez pour qu'un
    // recorder dont la réponse s'est perdue réessaie, trop peu pour que le
    // device_id devienne une clé de rechange exploitable plus tard.
    const TOKEN_GRACE_MS = 2 * 60_000;
    if (dev.token_hash && Date.parse(dev.paired_at) < Date.now() - TOKEN_GRACE_MS) {
      return jsonResponse(
        { ok: false, message: "Token déjà émis pour cet appareil — relancez l'appairage." },
        { status: 409 },
      );
    }

    const plaintext = generateDeviceToken();
    await admin.from("recorder_devices").update({
      token_hash: await sha256Hex(plaintext),
      pairing_code: null,
      pairing_expires_at: null,
    }).eq("id", deviceId);

    return jsonResponse({
      ok: true, paired: true, token: plaintext, workspace_id: dev.workspace_id,
    });
  }

  const auth = await authenticate(req);
  if (!auth.ok) return jsonResponse({ ok: false, message: auth.reason }, { status: 401 });
  const { projectId } = auth;
  const deviceWorkspaceId = auth.workspaceId ?? null;
  const admin = createServiceClient();

  try {
    const body = await req.json();
    const mode = body.mode as string;

    // ── CLAIM ────────────────────────────────────────────────────────────────
    if (mode === "claim") {
      const runnerId = String(body.runner_id ?? "");
      if (!runnerId) return jsonResponse({ ok: false, message: "runner_id required" }, { status: 400 });
      const { data: run } = await admin.rpc("claim_test_run", { p_runner_id: runnerId });
      // A per-project runner that grabbed another project's run must release it
      // back to the queue; the global runner keeps whatever it claims.
      if (!run) return jsonResponse({ ok: true, run: null });
      if (!inScope(projectId, run.project_id)) {
        await admin.from("test_runs").update({ status: "queued", runner_id: null }).eq("id", run.id);
        return jsonResponse({ ok: true, run: null });
      }

      const { data: tc } = await admin
        .from("test_cases").select("name, instructions, expected_outcome, fixtures").eq("id", run.case_id).maybeSingle();
      await appendStep(admin, run.id, { actor: "runner", kind: "info", label: `Runner ${runnerId} picked up the run` });

      return jsonResponse({
        ok: true,
        run: {
          id: run.id, app_url: run.app_url, plan: run.plan,
          case: tc ?? null,
        },
      });
    }

    // ── OBSERVE → decide next action ──────────────────────────────────────────
    if (mode === "observe") {
      const runId = String(body.run_id ?? "");
      if (!runId) return jsonResponse({ ok: false, message: "run_id required" }, { status: 400 });

      const { data: run } = await admin.from("test_runs").select("*").eq("id", runId).maybeSingle();
      if (!run || !inScope(projectId, run.project_id)) return jsonResponse({ ok: false, message: "Run not found" }, { status: 404 });
      if (["passed", "failed", "error", "cancelled"].includes(run.status)) {
        return jsonResponse({ ok: true, action: { type: run.status === "passed" ? "pass" : "fail" }, terminal: true });
      }

      const currentUrl = body.current_url ? String(body.current_url) : run.current_url;
      const domExcerpt = body.dom_excerpt ? String(body.dom_excerpt) : null;
      const screenshotUrl = body.screenshot_url ? String(body.screenshot_url) : null;
      const perf = (body.perf && typeof body.perf === "object") ? body.perf as Record<string, number> : null;

      // Persist the latest observation (+ rolling perf telemetry) so the live
      // view and the final report can use them.
      await admin.from("test_runs").update({
        current_url: currentUrl,
        last_dom_excerpt: domExcerpt,
        last_screenshot_url: screenshotUrl ?? run.last_screenshot_url,
        status: "running",
        result: { ...(run.result ?? {}), perf: perf ?? (run.result?.perf ?? null) },
      }).eq("id", runId);

      // Gather context for the agent: case + history + prior user answers.
      const { data: tc } = await admin
        .from("test_cases").select("instructions, expected_outcome, fixtures").eq("id", run.case_id).maybeSingle();
      const { data: stepRows } = await admin
        .from("test_run_steps").select("kind, label, actor").eq("run_id", runId).order("idx", { ascending: true });
      const steps = stepRows ?? [];
      const userAnswers = steps.filter((s) => s.kind === "user_answer").map((s) => String(s.label ?? ""));

      // The persistent plan (stored as [{intent}] by the orchestrator).
      const plan = Array.isArray(run.plan)
        ? (run.plan as Array<{ intent?: string } | string>).map((p) => (typeof p === "string" ? p : p.intent ?? "")).filter(Boolean)
        : [];

      const ctx: RunContext = {
        instructions: tc?.instructions ?? "",
        expected_outcome: tc?.expected_outcome ?? null,
        fixtures: (tc?.fixtures ?? {}) as Record<string, unknown>,
        app_url: run.app_url,
        current_url: currentUrl,
        dom_excerpt: domExcerpt,
        history: steps.map((s) => ({ kind: s.kind, label: s.label })),
        user_answers: userAnswers,
        plan,
      };

      const action = await decideNextAction(ctx, { workspace_id: run.workspace_id, project_id: run.project_id });
      const step = actionToStep(action);

      // Record the agent's decision as a timeline step (carry the screenshot the
      // runner just captured so the frame lines up with the action).
      await appendStep(admin, runId, {
        actor: "agent", kind: step.kind, label: step.label, payload: action as unknown as Record<string, unknown>,
        screenshot_url: screenshotUrl,
      });

      // Terminal / pause transitions.
      if (action.type === "ask_user") {
        await admin.from("test_runs").update({ status: "needs_input", pending_question: action.question ?? "Need input" }).eq("id", runId);
        return jsonResponse({ ok: true, action, paused: true });
      }
      if (action.type === "pass" || action.type === "fail") {
        const verdict = action.type === "pass" ? "pass" : "fail";
        const finishedAt = new Date().toISOString();
        const durationMs = run.started_at ? new Date(finishedAt).getTime() - new Date(run.started_at).getTime() : null;

        // Latest perf telemetry sent by the runner (stored on each observe).
        const runPerf = perf ?? (run.result?.perf ?? null);

        // Build a rich structured report from the full run history + perf.
        const report = await generateRunReport(
          {
            instructions: tc?.instructions ?? "",
            expected_outcome: tc?.expected_outcome ?? null,
            app_url: run.app_url,
            verdict,
            assertion: action.assertion ?? null,
            failReason: action.reason ?? null,
            history: steps.map((s) => ({ kind: s.kind, label: s.label, actor: s.actor })),
            durationMs,
            perf: runPerf,
          },
          { workspace_id: run.workspace_id, project_id: run.project_id },
        );

        await admin.from("test_runs").update({
          status: verdict === "pass" ? "passed" : "failed",
          finished_at: finishedAt,
          result: { assertion: action.assertion ?? null, report },
          error_message: verdict === "fail" ? (action.reason ?? action.assertion ?? "Test failed") : null,
        }).eq("id", runId);

        // Emit the report as a timeline artifact (a card the user can open).
        await appendStep(admin, runId, {
          actor: "agent", kind: "report",
          label: report.title,
          payload: { report } as unknown as Record<string, unknown>,
          screenshot_url: screenshotUrl,
        });

        return jsonResponse({ ok: true, action, terminal: true });
      }

      return jsonResponse({ ok: true, action });
    }

    // ── POLL (paused run) ─────────────────────────────────────────────────────
    if (mode === "poll") {
      const runId = String(body.run_id ?? "");
      const { data: run } = await admin.from("test_runs").select("status, project_id").eq("id", runId).maybeSingle();
      if (!run || !inScope(projectId, run.project_id)) return jsonResponse({ ok: false, message: "Run not found" }, { status: 404 });
      // 'queued' again means the user answered and the orchestrator re-queued it.
      return jsonResponse({ ok: true, resumed: run.status === "queued" || run.status === "running", status: run.status });
    }

    // ── COMPLETE (terminal report) ────────────────────────────────────────────
    if (mode === "complete") {
      const runId = String(body.run_id ?? "");
      const status = ["passed", "failed", "error", "cancelled"].includes(body.status) ? body.status : "error";
      const { data: run } = await admin.from("test_runs").select("project_id").eq("id", runId).maybeSingle();
      if (!run || !inScope(projectId, run.project_id)) return jsonResponse({ ok: false, message: "Run not found" }, { status: 404 });
      await admin.from("test_runs").update({
        status, finished_at: new Date().toISOString(),
        error_message: body.error_message ? String(body.error_message) : null,
      }).eq("id", runId);
      await appendStep(admin, runId, {
        actor: "runner", kind: status === "passed" ? "pass" : status === "failed" ? "fail" : "error",
        label: body.error_message ? String(body.error_message) : `Run ${status}`,
      });
      return jsonResponse({ ok: true });
    }

    // ── SKILL RECORDER ────────────────────────────────────────────────────────
    // Le recorder Playwright (paquet skill-recorder/) parle ici plutôt qu'à une
    // edge function dédiée : même identité runner, même token, et le projet est
    // au plafond de 100 fonctions.

    // rec_claim — prendre la prochaine démonstration en attente.
    if (mode === "rec_claim") {
      const runnerId = String(body.runner_id ?? "");
      if (!runnerId) return jsonResponse({ ok: false, message: "runner_id required" }, { status: 400 });

      // Un recorder tourne sur le POSTE de quelqu'un : il ouvre un navigateur
      // sous ses yeux. Réclamer la démonstration d'un autre workspace n'aurait
      // aucun sens.
      //
      // Un appareil APPAIRÉ porte son workspace dans son identité — rien à
      // configurer, et rien à contourner : le corps de la requête ne peut pas
      // l'élargir. L'épinglage par le corps ne subsiste que pour un runner
      // authentifié par token plateforme (qui, lui, voit tout).
      const pinnedWorkspace = deviceWorkspaceId ?? (body.workspace_id ? String(body.workspace_id) : null);

      // Le PLUS RÉCENT d'abord, et rien de plus vieux que 15 minutes. Un
      // enregistrement en attente correspond à quelqu'un qui vient d'appuyer sur
      // « Démarrer » et regarde son écran : servir une demande abandonnée ce
      // matin ouvrirait un navigateur pour une démo que personne n'attend, en
      // laissant l'utilisateur réel devant un spinner éternel.
      const staleBefore = new Date(Date.now() - 15 * 60_000).toISOString();

      // Qui demande : l'extension navigateur, ou le recorder Playwright ? Les
      // deux parlent le même protocole, mais ils n'offrent pas la même chose —
      // l'un enregistre dans les onglets de l'utilisateur, l'autre ouvre une
      // fenêtre à part. Sans cette déclaration, le premier à répondre gagnait,
      // et le résultat d'un clic sur « Démarrer » dépendait de la latence
      // réseau. Un capteur ne prend donc que ce qui lui est destiné.
      const capture = body.capture === "extension" || body.capture === "playwright"
        ? String(body.capture)
        : "playwright"; // un client qui ne se déclare pas est un ancien recorder Node

      let query = admin.from("skill_recordings")
        .select("id, project_id, workspace_id, title, goal, start_url")
        .eq("status", "pending").gte("created_at", staleBefore)
        .in("capture_mode", ["any", capture]);
      if (pinnedWorkspace) query = query.eq("workspace_id", pinnedWorkspace);
      const { data: pending } = await query.order("created_at", { ascending: false }).limit(5);

      for (const rec of (pending ?? []) as Array<{ id: string; project_id: string | null; title: string; goal: string | null; start_url: string | null }>) {
        // Un runner par projet ne sert que son projet ; le runner global sert
        // tout, y compris les enregistrements sans projet.
        if (projectId !== null && rec.project_id !== projectId) continue;

        // Réclamation optimiste : le filtre status='pending' fait office de
        // verrou, deux recorders concurrents ne peuvent pas prendre la même.
        const startedAt = new Date().toISOString();
        const { data: claimed } = await admin.from("skill_recordings")
          .update({
            status: "recording", runner_id: runnerId, captured_by: capture,
            claimed_at: startedAt, started_at: startedAt, heartbeat_at: startedAt,
          })
          .eq("id", rec.id).eq("status", "pending")
          .select("id, title, goal, start_url, started_at").maybeSingle();
        if (claimed) return jsonResponse({ ok: true, recording: claimed });
      }
      return jsonResponse({ ok: true, recording: null });
    }

    // rec_events — lot d'événements + battement de cœur. La réponse porte
    // l'ordre d'arrêt : c'est le seul canal que le recorder écoute, il n'a
    // besoin d'aucun poll séparé.
    if (mode === "rec_events") {
      const recordingId = String(body.recording_id ?? "");
      if (!recordingId) return jsonResponse({ ok: false, message: "recording_id required" }, { status: 400 });

      const { data: rec } = await admin.from("skill_recordings")
        .select("id, project_id, workspace_id, status, event_count").eq("id", recordingId).maybeSingle();
      if (!rec || !recordingInScope(rec, projectId, deviceWorkspaceId)) {
        return jsonResponse({ ok: false, message: "Recording not found" }, { status: 404 });
      }

      const incoming = Array.isArray(body.events) ? body.events : [];
      const rows = incoming.slice(0, 500).map((e: Record<string, unknown>) => ({
        recording_id: recordingId,
        source: String(e.source ?? "browser"),
        seq: Number(e.seq ?? 0),
        at_ms: Math.max(0, Math.round(Number(e.at_ms ?? 0))),
        kind: String(e.kind ?? "note").slice(0, 40),
        url: e.url ? String(e.url).slice(0, 2000) : null,
        target: (e.target ?? {}) as Record<string, unknown>,
        value: e.value == null ? null : String(e.value).slice(0, 4000),
        is_secret: e.is_secret === true,
        duration_ms: e.duration_ms == null ? null : Math.round(Number(e.duration_ms)),
        screenshot_url: e.screenshot_url ? String(e.screenshot_url).slice(0, 2000) : null,
      }));

      if (rows.length) {
        // onConflict : un lot rejoué après un timeout réseau ne doit pas
        // dupliquer des gestes déjà enregistrés.
        const { error } = await admin.from("skill_recording_events")
          .upsert(rows, { onConflict: "recording_id,source,seq", ignoreDuplicates: true });
        if (error) return jsonResponse({ ok: false, message: error.message }, { status: 500 });
      }

      const { count } = await admin.from("skill_recording_events")
        .select("id", { count: "exact", head: true }).eq("recording_id", recordingId);
      await admin.from("skill_recordings")
        .update({ heartbeat_at: new Date().toISOString(), event_count: count ?? rec.event_count })
        .eq("id", recordingId);

      const stop = rec.status === "stopping" || rec.status === "cancelled";
      return jsonResponse({ ok: true, stop, status: rec.status, accepted: rows.length });
    }

    // ── PILOTAGE PAR UN AGENT ────────────────────────────────────────────────
    // L'extension va chercher les ordres et rapporte leurs résultats. Le canal
    // n'existe QUE pendant une fenêtre d'armement décidée par l'utilisateur.

    // rec_control_arm — l'utilisateur autorise (ou coupe) le pilotage.
    if (mode === "rec_control_arm") {
      if (!auth.deviceId) {
        return jsonResponse({ ok: false, message: "Réservé à un appareil appairé" }, { status: 403 });
      }
      const minutes = Math.min(240, Math.max(0, Number(body.minutes ?? 0)));
      const origins = Array.isArray(body.origins)
        ? body.origins.map((o: unknown) => String(o)).slice(0, 50)
        : [];

      // minutes = 0 → désarmement immédiat. C'est le chemin du bouton « couper »,
      // et il doit être aussi simple que possible : une seule écriture.
      const until = minutes > 0 ? new Date(Date.now() + minutes * 60_000).toISOString() : null;
      await admin.from("recorder_devices")
        .update({ control_until: until, control_origins: origins })
        .eq("id", auth.deviceId);

      // Les ordres en vol n'ont plus de mandat : on les périme plutôt que de
      // les laisser s'exécuter après le désarmement.
      if (!until) {
        await admin.from("browser_commands")
          .update({ status: "expired", finished_at: new Date().toISOString(), error: "pilotage désarmé" })
          .eq("device_id", auth.deviceId).eq("status", "pending");
      }
      return jsonResponse({ ok: true, control_until: until, origins });
    }

    // rec_coach_arm — l'utilisateur ouvre (ou ferme) le mode formation.
    //
    // Volontairement distinct de rec_control_arm : ce que le coach peut faire
    // — dessiner un repère, écrire une phrase, lire la page — ne se confond pas
    // avec cliquer à la place de quelqu'un. Un consentement unique aurait fait
    // du plus dangereux le prix d'entrée du plus anodin. D'où aussi la durée
    // maximale plus généreuse : une formation dure une matinée.
    if (mode === "rec_coach_arm") {
      if (!auth.deviceId) {
        return jsonResponse({ ok: false, message: "Réservé à un appareil appairé" }, { status: 403 });
      }
      const minutes = Math.min(480, Math.max(0, Number(body.minutes ?? 0)));
      const origins = Array.isArray(body.origins)
        ? body.origins.map((o: unknown) => String(o)).slice(0, 50)
        : [];
      const until = minutes > 0 ? new Date(Date.now() + minutes * 60_000).toISOString() : null;
      await admin.from("recorder_devices")
        .update({ coach_until: until, coach_origins: origins })
        .eq("id", auth.deviceId);

      // Couper la formation ferme aussi les repères en vol : un pas de plus
      // affiché après l'arrêt donnerait le sentiment que le bouton ne fait rien.
      if (!until) {
        await admin.from("browser_commands")
          .update({ status: "expired", finished_at: new Date().toISOString(), error: "mode formation désactivé" })
          .eq("device_id", auth.deviceId).eq("channel", "coach").in("status", ["pending", "running"]);
      }
      return jsonResponse({ ok: true, coach_until: until, origins });
    }

    // rec_control_poll — l'extension réclame les ordres en attente.
    //
    // Un seul appel sert les deux canaux, parce qu'un seul battement doit
    // suffire : l'extension n'a pas à savoir combien de pouvoirs existent. Ce
    // qu'elle reçoit dépend de ce qui est armé, et rien d'autre.
    if (mode === "rec_control_poll") {
      if (!auth.deviceId) {
        return jsonResponse({ ok: false, message: "Réservé à un appareil appairé" }, { status: 403 });
      }
      const { data: dev } = await admin.from("recorder_devices")
        .select("control_until, control_origins, coach_until, coach_origins")
        .eq("id", auth.deviceId).maybeSingle();

      const armed = !!dev?.control_until && Date.parse(dev.control_until) > Date.now();
      const coachArmed = !!dev?.coach_until && Date.parse(dev.coach_until) > Date.now();
      if (!armed && !coachArmed) {
        // Rien d'armé : on ne remet AUCUN ordre. L'extension n'a même pas à
        // savoir qu'il en existait.
        return jsonResponse({ ok: true, armed: false, coach_armed: false, commands: [] });
      }

      const nowIso = new Date().toISOString();
      // Les ordres périmés sont enterrés ici : c'est le seul endroit qui tourne
      // régulièrement, et les faire expirer plus tard reviendrait à les exécuter.
      await admin.from("browser_commands")
        .update({ status: "expired", finished_at: nowIso, error: "expiré avant exécution" })
        .eq("device_id", auth.deviceId).eq("status", "pending").lt("expires_at", nowIso);

      // Qui peut agir peut montrer ; l'inverse est faux. C'est ici que la
      // promesse du mode formation tient, avant même la liste blanche de
      // l'extension : un ordre de pilotage n'est jamais REMIS à un appareil
      // armé pour la seule formation.
      const channels = armed ? ["control", "coach"] : ["coach"];
      const { data: queued } = await admin.from("browser_commands")
        .select("id, action, params, channel")
        .eq("device_id", auth.deviceId).eq("status", "pending")
        .in("channel", channels)
        .order("created_at").limit(5);

      const ids = (queued ?? []).map((c: { id: string }) => c.id);
      if (ids.length) {
        await admin.from("browser_commands")
          .update({ status: "running", claimed_at: nowIso }).in("id", ids);
      }
      return jsonResponse({
        ok: true,
        armed,
        control_until: dev?.control_until ?? null,
        origins: dev?.control_origins ?? [],
        coach_armed: coachArmed,
        coach_until: dev?.coach_until ?? null,
        coach_origins: dev?.coach_origins ?? [],
        commands: queued ?? [],
      });
    }

    // rec_control_result — le compte rendu d'un ordre.
    if (mode === "rec_control_result") {
      if (!auth.deviceId) {
        return jsonResponse({ ok: false, message: "Réservé à un appareil appairé" }, { status: 403 });
      }
      const commandId = String(body.command_id ?? "");
      if (!commandId) return jsonResponse({ ok: false, message: "command_id required" }, { status: 400 });

      const failed = body.error != null;
      await admin.from("browser_commands").update({
        status: failed ? "failed" : "done",
        result: failed ? null : (body.result ?? {}),
        error: failed ? String(body.error).slice(0, 1000) : null,
        finished_at: new Date().toISOString(),
      }).eq("id", commandId).eq("device_id", auth.deviceId);

      return jsonResponse({ ok: true });
    }

    // rec_shot — une capture d'écran, poussée en base64, stockée côté SERVEUR.
    //
    // Le recorder Playwright téléverse lui-même avec la clé service role. Une
    // extension de navigateur ne le peut pas : embarquer cette clé dans un
    // paquet installé sur le poste de quelqu'un reviendrait à la publier. Elle
    // envoie donc l'image ici, et c'est l'edge function qui la range.
    if (mode === "rec_shot") {
      const recordingId = String(body.recording_id ?? "");
      const dataUrl = String(body.image ?? "");
      if (!recordingId || !dataUrl) {
        return jsonResponse({ ok: false, message: "recording_id and image required" }, { status: 400 });
      }

      const { data: rec } = await admin.from("skill_recordings")
        .select("id, project_id, workspace_id").eq("id", recordingId).maybeSingle();
      if (!rec || !recordingInScope(rec, projectId, deviceWorkspaceId)) {
        return jsonResponse({ ok: false, message: "Recording not found" }, { status: 404 });
      }

      const base64 = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl;
      let bytes: Uint8Array;
      try {
        const bin = atob(base64);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } catch {
        return jsonResponse({ ok: false, message: "image is not valid base64" }, { status: 400 });
      }
      // Une vignette de timeline, pas une pièce jointe : au-delà de 2 Mo, c'est
      // une erreur d'appelant, et on refuse plutôt que de remplir le bucket.
      if (bytes.length > 2_000_000) {
        return jsonResponse({ ok: false, message: "image too large" }, { status: 413 });
      }

      const idx = Number(body.idx ?? 0);
      const path = `${recordingId}/${String(idx).padStart(4, "0")}.jpg`;
      const { error: upErr } = await admin.storage.from("skill-recordings")
        .upload(path, bytes, { contentType: "image/jpeg", upsert: true });
      // Une vignette perdue ne doit jamais coûter un geste : l'appelant
      // continue sans image.
      if (upErr) return jsonResponse({ ok: true, url: null, warning: upErr.message });

      // FOS-04 : on rend le CHEMIN, plus une URL publique. Le bucket est privé
      // depuis la migration 0241 — ces vignettes filment l'écran d'un opérateur
      // au travail — et le front signe le chemin au moment de l'afficher.
      return jsonResponse({ ok: true, url: path, path });
    }

    // rec_finish — le recorder a refermé le navigateur. On bascule en
    // 'processing' et on rend la main tout de suite : la synthèse LLM dure
    // plusieurs dizaines de secondes et ne doit pas tenir le runner en ligne.
    if (mode === "rec_finish") {
      const recordingId = String(body.recording_id ?? "");
      if (!recordingId) return jsonResponse({ ok: false, message: "recording_id required" }, { status: 400 });

      const { data: rec } = await admin.from("skill_recordings")
        .select("id, project_id, workspace_id, status, started_at").eq("id", recordingId).maybeSingle();
      if (!rec || !recordingInScope(rec, projectId, deviceWorkspaceId)) {
        return jsonResponse({ ok: false, message: "Recording not found" }, { status: 404 });
      }

      const endedAt = new Date();
      const startedMs = rec.started_at ? Date.parse(rec.started_at) : endedAt.getTime();
      const durationMs = Number.isFinite(Number(body.duration_ms))
        ? Math.max(0, Math.round(Number(body.duration_ms)))
        : Math.max(0, endedAt.getTime() - startedMs);

      // Un enregistrement annulé n'est pas synthétisé : l'utilisateur a dit non.
      if (rec.status === "cancelled") {
        await admin.from("skill_recordings")
          .update({ ended_at: endedAt.toISOString(), duration_ms: durationMs }).eq("id", recordingId);
        return jsonResponse({ ok: true, synthesizing: false, status: "cancelled" });
      }

      await admin.from("skill_recordings").update({
        status: "processing",
        ended_at: endedAt.toISOString(),
        duration_ms: durationMs,
        error: body.error ? String(body.error).slice(0, 500) : null,
      }).eq("id", recordingId);

      // synthesizeSkill écrit lui-même le statut terminal (ready / failed), donc
      // un échec en tâche de fond reste visible dans l'UI.
      const job = synthesizeSkill(recordingId).catch((e) => {
        console.error("skill synthesis failed:", e instanceof Error ? e.message : String(e));
      });
      const er = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
      if (er?.waitUntil) er.waitUntil(job); else await job;

      return jsonResponse({ ok: true, synthesizing: true, status: "processing" });
    }

    return jsonResponse({ ok: false, message: `Unknown mode ${mode}` }, { status: 400 });
  } catch (err) {
    return jsonResponse({ ok: false, message: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
});
