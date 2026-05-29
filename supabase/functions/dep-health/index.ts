// dep-health — enrich npm dependencies with registry data.
// Body: { deps: [{ name, version }] }  (npm package names; non-npm names are skipped)
// Returns: { results: [{ name, current, latest, deprecated, status, lag }] }
//   status: "ok" | "patch" | "minor" | "major" | "deprecated" | "unknown"

import { handleCors, jsonResponse } from "../_shared/cors.ts";

interface DepInput {
  name: string;
  version: string;
}

interface DepHealth {
  name: string;
  current: string;
  latest: string | null;
  deprecated: boolean;
  status: "ok" | "patch" | "minor" | "major" | "deprecated" | "unknown";
  lagMajor: number;
}

// Strip range prefixes (^ ~ >= etc.) and extract the numeric core.
function cleanVersion(v: string): [number, number, number] | null {
  const m = String(v).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compareStatus(cur: string, latest: string): { status: DepHealth["status"]; lagMajor: number } {
  const c = cleanVersion(cur);
  const l = cleanVersion(latest);
  if (!c || !l) return { status: "unknown", lagMajor: 0 };
  if (l[0] > c[0]) return { status: "major", lagMajor: l[0] - c[0] };
  if (l[1] > c[1]) return { status: "minor", lagMajor: 0 };
  if (l[2] > c[2]) return { status: "patch", lagMajor: 0 };
  return { status: "ok", lagMajor: 0 };
}

async function fetchNpm(name: string): Promise<{ latest: string | null; deprecated: boolean }> {
  try {
    // Lightweight: the "latest" dist-tag + deprecation flag.
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return { latest: null, deprecated: false };
    const json = await res.json();
    return { latest: json.version ?? null, deprecated: typeof json.deprecated === "string" };
  } catch {
    return { latest: null, deprecated: false };
  }
}

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const { deps } = await req.json();
    if (!Array.isArray(deps)) return jsonResponse({ error: "deps array required" }, { status: 400 });

    // Only npm-resolvable names; cap to keep latency bounded.
    const list: DepInput[] = deps
      .filter((d: DepInput) => d && typeof d.name === "string" && !d.name.startsWith("git+") && !/\s/.test(d.name))
      .slice(0, 150);

    // Fetch in small concurrent batches to be gentle on the registry.
    const results: DepHealth[] = [];
    const batchSize = 12;
    for (let i = 0; i < list.length; i += batchSize) {
      const batch = list.slice(i, i + batchSize);
      const enriched = await Promise.all(
        batch.map(async (d) => {
          const { latest, deprecated } = await fetchNpm(d.name);
          let status: DepHealth["status"] = "unknown";
          let lagMajor = 0;
          if (deprecated) status = "deprecated";
          else if (latest) ({ status, lagMajor } = compareStatus(d.version, latest));
          return { name: d.name, current: d.version, latest, deprecated, status, lagMajor };
        }),
      );
      results.push(...enriched);
    }

    return jsonResponse({ results });
  } catch (err) {
    return jsonResponse(
      { error: "dep-health failed", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
});
