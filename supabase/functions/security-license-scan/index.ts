// security-license-scan — resolve SPDX licenses for npm deps and classify risk.
// Body: { workspace_id, project_id }
// Returns: { results: [{ name, version, license, risk }], summary }

import { handleCors, jsonResponse } from "../_shared/cors.ts";
import { createServiceClient, createUserClient } from "../_shared/supabase-admin.ts";

interface Dep { name: string; version: string }

// Copyleft / restrictive families that warrant review for a commercial SaaS.
const COPYLEFT = /AGPL|^GPL|LGPL|MPL|EUPL|CDDL|EPL|SSPL|CC-BY-NC|BUSL|Sleepycat/i;
const PERMISSIVE = /MIT|ISC|BSD|Apache|Unlicense|0BSD|CC0|WTFPL|Zlib|BlueOak/i;

function classify(license: string | null): "permissive" | "copyleft" | "unknown" {
  if (!license) return "unknown";
  if (COPYLEFT.test(license)) return "copyleft";
  if (PERMISSIVE.test(license)) return "permissive";
  return "unknown";
}

async function npmLicense(name: string): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const j = await res.json();
    if (typeof j.license === "string") return j.license;
    if (j.license?.type) return j.license.type;
    if (Array.isArray(j.licenses) && j.licenses[0]?.type) return j.licenses[0].type;
    return null;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return jsonResponse({ error: "Missing Authorization" }, { status: 401 });
    const userClient = createUserClient(authHeader);
    const { data: userData } = await userClient.auth.getUser();
    if (!userData.user) return jsonResponse({ error: "Invalid session" }, { status: 401 });

    const { workspace_id, project_id } = await req.json();
    if (!workspace_id || !project_id) {
      return jsonResponse({ error: "workspace_id and project_id required" }, { status: 400 });
    }

    const admin = createServiceClient();
    const { data: member } = await admin
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", workspace_id)
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (!member) return jsonResponse({ error: "Not authorized" }, { status: 403 });

    const { data: scan } = await admin
      .from("scan_results")
      .select("dependencies")
      .eq("project_id", project_id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!scan) return jsonResponse({ error: "No scan available. Run a code scan first." }, { status: 400 });

    const deps: Dep[] = ((scan as any).dependencies ?? [])
      .filter((d: Dep) => d?.name && !d.name.startsWith("git+") && !/\s/.test(d.name))
      .slice(0, 150);

    const results: { name: string; version: string; license: string | null; risk: string }[] = [];
    const batchSize = 12;
    for (let i = 0; i < deps.length; i += batchSize) {
      const batch = deps.slice(i, i + batchSize);
      const enriched = await Promise.all(
        batch.map(async (d) => {
          const license = await npmLicense(d.name);
          return { name: d.name, version: d.version, license, risk: classify(license) };
        }),
      );
      results.push(...enriched);
    }

    const summary = {
      total: results.length,
      copyleft: results.filter((r) => r.risk === "copyleft").length,
      unknown: results.filter((r) => r.risk === "unknown").length,
      permissive: results.filter((r) => r.risk === "permissive").length,
    };

    return jsonResponse({ results, summary });
  } catch (err) {
    return jsonResponse(
      { error: "security-license-scan failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
