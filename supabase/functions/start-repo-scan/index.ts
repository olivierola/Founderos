// start-repo-scan
// Creates a repository row (if not exists) and a scan_job, then invokes process-repo-scan.
// Body: { workspace_id, project_id, github_repo: { full_name, default_branch, private, external_id, name } }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization header" }, { status: 401 });

    const userClient = createUserClient(authHeader);
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });
    const userId = userData.user.id;

    const body = await req.json();
    const { workspace_id, project_id, github_repo } = body;
    if (!workspace_id || !project_id || !github_repo?.full_name) {
      return jsonResponse({ error: "workspace_id, project_id, github_repo.full_name required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const { data: membership } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspace_id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!membership || !["owner", "admin"].includes(membership.role)) {
      return jsonResponse({ error: "Not authorized" }, { status: 403 });
    }

    // Find or create repository row
    let { data: repo } = await admin
      .from("repositories")
      .select("*")
      .eq("project_id", project_id)
      .eq("provider", "github")
      .eq("full_name", github_repo.full_name)
      .maybeSingle();

    if (!repo) {
      const { data: created, error: repoErr } = await admin
        .from("repositories")
        .insert({
          workspace_id,
          project_id,
          provider: "github",
          external_id: String(github_repo.external_id ?? ""),
          name: github_repo.name ?? github_repo.full_name.split("/").pop(),
          full_name: github_repo.full_name,
          default_branch: github_repo.default_branch ?? "main",
          private: github_repo.private ?? true,
        })
        .select()
        .single();
      if (repoErr || !created) {
        return jsonResponse({ error: "Could not create repository", detail: repoErr?.message }, { status: 500 });
      }
      repo = created;
    }

    const { data: job, error: jobErr } = await admin
      .from("scan_jobs")
      .insert({
        workspace_id,
        project_id,
        repository_id: repo.id,
        status: "pending",
        progress: { step: "queued" },
      })
      .select()
      .single();
    if (jobErr || !job) {
      return jsonResponse({ error: "Could not create scan_job", detail: jobErr?.message }, { status: 500 });
    }

    // Fire-and-forget invoke of process-repo-scan
    const projectUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    fetch(`${projectUrl}/functions/v1/process-repo-scan`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ scan_job_id: job.id }),
    }).catch(() => {});

    await admin.from("activity_logs").insert({
      workspace_id,
      project_id,
      actor_user_id: userId,
      event_type: "scan.started",
      title: `Scan started for ${repo.full_name}`,
      payload: { repository_id: repo.id, scan_job_id: job.id },
    });

    return jsonResponse({ scan_job_id: job.id, repository_id: repo.id });
  } catch (err) {
    return jsonResponse(
      { error: "Unexpected error", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
