// process-repo-scan
// Fetches manifest files via GitHub API, extracts deps/env vars/detected services,
// and stores the result in scan_results.
// Body: { scan_job_id }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient } from "../_shared/supabase-admin.ts";
import { decryptSecret } from "../_shared/crypto.ts";
import { fetchFileContent, listRepoTree } from "../_shared/github.ts";

const MANIFEST_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "vite.config.ts",
  "vite.config.js",
  "next.config.js",
  "next.config.mjs",
  "tsconfig.json",
  "requirements.txt",
  "pyproject.toml",
  "Pipfile",
  "Gemfile",
  "composer.json",
  "go.mod",
  "Cargo.toml",
  "Dockerfile",
  "docker-compose.yml",
  "vercel.json",
  "netlify.toml",
  "railway.json",
  "supabase/config.toml",
  "prisma/schema.prisma",
  "drizzle.config.ts",
  ".env.example",
  ".env.sample",
  ".env.local.example",
];

interface ServiceSignature {
  service: string;
  category: string;
  envPatterns: RegExp[];
  depPatterns: RegExp[];
}

const SERVICE_SIGNATURES: ServiceSignature[] = [
  { service: "supabase", category: "backend", envPatterns: [/SUPABASE/i], depPatterns: [/^@supabase\//] },
  { service: "stripe", category: "payments", envPatterns: [/STRIPE/i], depPatterns: [/^stripe$/, /^@stripe\//] },
  { service: "clerk", category: "auth", envPatterns: [/CLERK/i], depPatterns: [/^@clerk\//] },
  { service: "auth0", category: "auth", envPatterns: [/AUTH0/i], depPatterns: [/^@auth0\//, /^auth0$/] },
  { service: "openai", category: "ai", envPatterns: [/^OPENAI_/i], depPatterns: [/^openai$/] },
  { service: "groq", category: "ai", envPatterns: [/GROQ/i], depPatterns: [/^groq-sdk$/, /^@groq\//] },
  { service: "anthropic", category: "ai", envPatterns: [/ANTHROPIC/i], depPatterns: [/^@anthropic-ai\//] },
  { service: "deepseek", category: "ai", envPatterns: [/DEEPSEEK/i], depPatterns: [] },
  { service: "mistral", category: "ai", envPatterns: [/MISTRAL/i], depPatterns: [/^@mistralai\//] },
  { service: "resend", category: "email", envPatterns: [/RESEND/i], depPatterns: [/^resend$/] },
  { service: "sendgrid", category: "email", envPatterns: [/SENDGRID/i], depPatterns: [/^@sendgrid\//] },
  { service: "posthog", category: "analytics", envPatterns: [/POSTHOG/i], depPatterns: [/^posthog/] },
  { service: "mixpanel", category: "analytics", envPatterns: [/MIXPANEL/i], depPatterns: [/^mixpanel/] },
  { service: "sentry", category: "monitoring", envPatterns: [/SENTRY/i], depPatterns: [/^@sentry\//] },
  { service: "vercel", category: "hosting", envPatterns: [/VERCEL/i], depPatterns: [] },
  { service: "cloudinary", category: "storage", envPatterns: [/CLOUDINARY/i], depPatterns: [/^cloudinary/] },
  { service: "inngest", category: "jobs", envPatterns: [/INNGEST/i], depPatterns: [/^inngest$/] },
];

interface DetectedDep {
  name: string;
  version: string;
  category: string;
  risk: "low" | "medium" | "high";
}

interface DetectedEnv {
  key: string;
  detected_service: string | null;
  sensitivity: "public" | "secret";
}

function detectFrameworkFromDeps(deps: Record<string, string>): {
  frontend: { framework: string | null; ui: string[]; language: string };
  backend_framework: string | null;
} {
  const names = new Set(Object.keys(deps));
  let frontend: string | null = null;
  if (names.has("next")) frontend = "next.js";
  else if (names.has("vite") && names.has("react")) frontend = "vite-react";
  else if (names.has("vite") && names.has("vue")) frontend = "vite-vue";
  else if (names.has("svelte")) frontend = "svelte";
  else if (names.has("react")) frontend = "react";

  const ui: string[] = [];
  if (names.has("tailwindcss")) ui.push("tailwindcss");
  if (names.has("@radix-ui/react-slot") || [...names].some((n) => n.startsWith("@radix-ui/"))) ui.push("shadcn/ui");
  if (names.has("@chakra-ui/react")) ui.push("chakra");
  if (names.has("@mui/material")) ui.push("mui");

  let backend: string | null = null;
  if (names.has("express")) backend = "express";
  else if (names.has("fastify")) backend = "fastify";
  else if (names.has("@nestjs/core")) backend = "nestjs";
  else if (names.has("hono")) backend = "hono";

  return {
    frontend: { framework: frontend, ui, language: names.has("typescript") ? "typescript" : "javascript" },
    backend_framework: backend,
  };
}

function categorizeDep(name: string): string {
  if (name.startsWith("@supabase/")) return "backend";
  if (name === "stripe" || name.startsWith("@stripe/")) return "payments";
  if (name.startsWith("@sentry/")) return "monitoring";
  if (name === "react" || name === "vue" || name === "next" || name === "svelte") return "frontend";
  if (name === "tailwindcss" || name.startsWith("@radix-ui/")) return "ui";
  if (name === "openai" || name.startsWith("@anthropic-ai/")) return "ai";
  return "other";
}

function detectServices(deps: Record<string, string>, envKeys: string[]) {
  const found = new Map<string, { service: string; category: string }>();
  for (const sig of SERVICE_SIGNATURES) {
    const depMatch = Object.keys(deps).some((d) => sig.depPatterns.some((p) => p.test(d)));
    const envMatch = envKeys.some((k) => sig.envPatterns.some((p) => p.test(k)));
    if (depMatch || envMatch) {
      found.set(sig.service, { service: sig.service, category: sig.category });
    }
  }
  return [...found.values()];
}

function parseEnvFile(content: string): DetectedEnv[] {
  return content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => l.split("=")[0]!.trim())
    .filter(Boolean)
    .map((key) => {
      let detected: string | null = null;
      for (const sig of SERVICE_SIGNATURES) {
        if (sig.envPatterns.some((p) => p.test(key))) {
          detected = sig.service;
          break;
        }
      }
      const isSecret = /SECRET|PRIVATE|TOKEN|KEY/i.test(key) && !/^VITE_|^NEXT_PUBLIC_|^PUBLIC_/i.test(key);
      return { key, detected_service: detected, sensitivity: isSecret ? "secret" : "public" } as DetectedEnv;
    });
}

async function patchProgress(jobId: string, step: string) {
  const admin = createServiceClient();
  await admin.from("scan_jobs").update({ progress: { step }, status: "running" }).eq("id", jobId);
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const admin = createServiceClient();
  let scanJobId: string | undefined;

  try {
    const body = await req.json();
    scanJobId = body.scan_job_id as string;
    if (!scanJobId) return jsonResponse({ error: "scan_job_id required" }, { status: 400 });

    const { data: job } = await admin.from("scan_jobs").select("*").eq("id", scanJobId).maybeSingle();
    if (!job) return jsonResponse({ error: "scan_job not found" }, { status: 404 });

    await admin
      .from("scan_jobs")
      .update({ status: "running", started_at: new Date().toISOString(), progress: { step: "fetch_repo" } })
      .eq("id", scanJobId);

    const { data: repo } = await admin.from("repositories").select("*").eq("id", job.repository_id).single();
    if (!repo) throw new Error("repository not found");

    const { data: connector } = await admin
      .from("connectors")
      .select("id")
      .eq("workspace_id", job.workspace_id)
      .eq("project_id", job.project_id)
      .eq("provider", "github")
      .single();
    if (!connector) throw new Error("github connector missing");

    const { data: cred } = await admin
      .from("encrypted_credentials")
      .select("encrypted_payload, iv")
      .eq("connector_id", connector.id)
      .single();
    if (!cred) throw new Error("github credential missing");

    const token = await decryptSecret(cred.encrypted_payload, cred.iv);
    const ref = repo.default_branch ?? "main";

    await patchProgress(scanJobId, "parse_manifests");

    // Fetch existing manifest files
    const fileTree = await listRepoTree(token, repo.full_name, ref).catch(() => [] as string[]);
    const fileSet = new Set(fileTree);

    const fileContents: Record<string, string> = {};
    for (const path of MANIFEST_FILES) {
      if (fileSet.size && !fileSet.has(path)) continue;
      const content = await fetchFileContent(token, repo.full_name, ref, path);
      if (content) fileContents[path] = content;
    }

    await patchProgress(scanJobId, "detect_services");

    // Parse package.json deps
    let deps: Record<string, string> = {};
    if (fileContents["package.json"]) {
      try {
        const pkg = JSON.parse(fileContents["package.json"]);
        deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      } catch { /* ignore */ }
    }

    const dependencies: DetectedDep[] = Object.entries(deps).map(([name, version]) => ({
      name,
      version: String(version),
      category: categorizeDep(name),
      risk: "low",
    }));

    await patchProgress(scanJobId, "analyze_env_vars");

    // Parse env example files
    const env_vars: DetectedEnv[] = [];
    for (const candidate of [".env.example", ".env.sample", ".env.local.example"]) {
      if (fileContents[candidate]) env_vars.push(...parseEnvFile(fileContents[candidate]));
    }

    // Services
    const envKeys = env_vars.map((e) => e.key);
    const services = detectServices(deps, envKeys);

    const fw = detectFrameworkFromDeps(deps);

    const recommendations: Array<{ type: string; severity: string; message: string }> = [];
    if (env_vars.some((e) => /^VITE_.*(SECRET|PRIVATE|SERVICE_ROLE)/i.test(e.key))) {
      recommendations.push({
        type: "security",
        severity: "high",
        message: "A VITE_-prefixed env var looks like a secret. Move it to an Edge Function — VITE_ vars are exposed to the browser.",
      });
    }
    if (deps.stripe && fw.frontend.framework && fw.frontend.framework !== "next.js") {
      recommendations.push({
        type: "security",
        severity: "high",
        message: "Stripe SDK appears in a frontend project. Move Stripe secret operations to a backend / Edge Function.",
      });
    }

    const summary = {
      project_type: services.some((s) => s.service === "stripe") ? "b2b_saas" : "unknown",
      detected_frontend: fw.frontend,
      backend_framework: fw.backend_framework,
      total_dependencies: dependencies.length,
      manifests_found: Object.keys(fileContents),
    };

    await patchProgress(scanJobId, "store_results");

    const { data: scanResultRow } = await admin
      .from("scan_results")
      .insert({
        scan_job_id: scanJobId,
        workspace_id: job.workspace_id,
        project_id: job.project_id,
        repository_id: job.repository_id,
        summary,
        dependencies,
        env_vars,
        services,
        architecture: { frontend: fw.frontend, backend: fw.backend_framework },
        security_findings: recommendations,
        ai_analysis: { status: "pending" },
      })
      .select("id")
      .single();

    // Fire-and-forget AI analysis
    if (scanResultRow?.id) {
      const projectUrl = Deno.env.get("SUPABASE_URL")!;
      const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      fetch(`${projectUrl}/functions/v1/ai-code-analysis`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ scan_result_id: scanResultRow.id }),
      }).catch(() => {});
    }

    await admin
      .from("scan_jobs")
      .update({
        status: "succeeded",
        finished_at: new Date().toISOString(),
        progress: { step: "done" },
      })
      .eq("id", scanJobId);

    await admin.from("repositories").update({ last_scanned_at: new Date().toISOString() }).eq("id", repo.id);

    await admin.from("activity_logs").insert({
      workspace_id: job.workspace_id,
      project_id: job.project_id,
      event_type: "scan.succeeded",
      title: `Scan completed for ${repo.full_name}`,
      payload: { scan_job_id: scanJobId, dependencies: dependencies.length, services: services.length },
    });

    return jsonResponse({ ok: true, scan_job_id: scanJobId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (scanJobId) {
      await admin
        .from("scan_jobs")
        .update({ status: "failed", finished_at: new Date().toISOString(), error_message: message })
        .eq("id", scanJobId);
    }
    return jsonResponse({ error: "Scan failed", detail: message }, { status: 500 });
  }
});
