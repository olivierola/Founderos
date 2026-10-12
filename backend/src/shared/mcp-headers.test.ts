// En-têtes statiques des serveurs MCP (0280) : chiffrés, jamais relus par un
// navigateur, et jamais en mesure d'usurper un en-tête que FounderOS pose.

import "../test-env.ts";

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { decryptSecret } from "../edge/_shared/crypto.ts";
import { apiTokenHeaders } from "../edge/_shared/mcp-api-token.ts";
import {
  headerHint, headerHints, loadMcpHeaders, mergeMcpHeaders, resolveHeaderInput, saveMcpHeaders, sealPendingMcpHeaders, urlOrigin,
} from "../edge/_shared/mcp-headers.ts";

process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");

/* eslint-disable @typescript-eslint/no-explicit-any */
/** La base, réduite aux deux tables touchées. */
function memoryAdmin(tables: Record<string, Array<Record<string, any>>>) {
  const from = (table: string) => {
    const rows = (tables[table] ??= []);
    let op: "select" | "update" | "upsert" | "delete" = "select";
    let payload: Record<string, any> = {};
    const eq: Record<string, unknown> = {};
    let inF: [string, unknown[]] | null = null;
    let notNull: string | null = null;
    const key = table === "mcp_servers" ? "id" : "server_id";
    const match = (r: Record<string, any>) => Object.entries(eq).every(([k, v]) => r[k] === v)
      && (!inF || inF[1].includes(r[inF[0]])) && (!notNull || r[notNull] != null);
    const run = () => {
      if (op === "upsert") {
        const i = rows.findIndex((r) => r[key] === payload[key]);
        if (i >= 0) rows[i] = { ...rows[i], ...payload }; else rows.push({ ...payload });
        return { data: null, error: null };
      }
      if (op === "update") { for (const r of rows.filter(match)) Object.assign(r, payload); return { data: null, error: null }; }
      if (op === "delete") { for (const r of rows.filter(match)) rows.splice(rows.indexOf(r), 1); return { data: null, error: null }; }
      return { data: rows.filter(match), error: null };
    };
    const q: any = {
      select: () => q, limit: () => q,
      eq: (k: string, v: unknown) => { eq[k] = v; return q; },
      in: (k: string, v: unknown[]) => { inF = [k, v]; return q; },
      not: (k: string) => { notNull = k; return q; },
      update: (p: Record<string, any>) => { op = "update"; payload = p; return q; },
      upsert: (p: Record<string, any>) => { op = "upsert"; payload = p; return q; },
      delete: () => { op = "delete"; return q; },
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
    };
    return q;
  };
  return { from } as any;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

describe("aperçu d'un en-tête", () => {
  it("même règle que public.mcp_header_hint (cas du test SQL de 0280)", () => {
    assert.equal(headerHint("Bearer secret-notion-abcd1234"), "Bearer …1234");
    assert.equal(headerHint("cle-api-0123456789"), "…6789");
    assert.equal(headerHint("acme"), "••••");
    assert.equal(headerHint("Bearer abc"), "Bearer ••••");
    assert.equal(headerHint("Bearer abcdefghijk"), "Bearer ••••");
    assert.equal(headerHint("abcdefghijk"), "••••");
    assert.equal(headerHint("bearer secret-xyz-0000"), "bearer …0000");
    assert.deepEqual(headerHints({ Authorization: "Bearer secret-notion-abcd1234", "X-Tenant": "acme" }),
      { Authorization: "Bearer …1234", "X-Tenant": "••••" });
  });

  it("l'origine d'une URL, comme la garde SQL", () => {
    assert.equal(urlOrigin("https://API.exemple:8443/mcp?x=1"), "https://api.exemple:8443");
    assert.equal(urlOrigin("https://s@attaquant.exemple/mcp"), "https://s@attaquant.exemple");
    assert.equal(urlOrigin("pas une url"), "");
  });
});

describe("en-têtes saisis", () => {
  it("une valeur vide garde la valeur enregistrée sous le même nom", () => {
    const stored = { Authorization: "Bearer ancien-jeton-0000" };
    assert.deepEqual(resolveHeaderInput({ Authorization: "", "X-Tenant": "acme" }, stored),
      { Authorization: "Bearer ancien-jeton-0000", "X-Tenant": "acme" });
    // Sans valeur enregistrée (nouvel en-tête, ou destination changée : la garde a tout effacé).
    assert.throws(() => resolveHeaderInput({ Authorization: "" }, {}), /saisissez sa valeur/);
    assert.throws(() => resolveHeaderInput({ "X-Autre": "" }, stored), /saisissez sa valeur/);
  });

  it("refuse les en-têtes que FounderOS pose, quelle qu'en soit la casse", () => {
    for (const name of ["X-FounderOS-User", "x-founderos-agent", "X-Approval-Token", "traceparent", "Mcp-Session-Id", "Host", "Content-Length"]) {
      assert.throws(() => resolveHeaderInput({ [name]: "valeur" }), /posé par FounderOS/, name);
    }
  });

  it("refuse un nom ou une valeur impropres", () => {
    assert.throws(() => resolveHeaderInput({ "X Bad": "v" }), /lettres, chiffres et tirets/);
    assert.throws(() => resolveHeaderInput({ "X-Inject": "a\r\nX-FounderOS-User: attaquant" }), /plusieurs lignes/);
    assert.throws(() => resolveHeaderInput(Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`X-H${i}`, "v"]))), /30 au plus/);
    assert.throws(() => resolveHeaderInput(["Authorization"]), /objet/);
  });

  it("les en-têtes de FounderOS remplacent les statiques du même nom, sans tenir compte de la casse", () => {
    const merged = mergeMcpHeaders({ authorization: "Bearer statique", "X-Tenant": "acme" }, { Authorization: "Bearer oauth" });
    assert.deepEqual(merged, { "X-Tenant": "acme", Authorization: "Bearer oauth" });
  });
});

describe("stockage", () => {
  it("chiffre à la première lecture ce que le déclencheur a déposé en clair", async () => {
    const db: Record<string, Array<Record<string, unknown>>> = {
      mcp_server_headers: [{ server_id: "s1", headers_plain: { Authorization: "Bearer secret-notion-abcd1234" }, headers_enc: null, headers_iv: null }],
    };
    const admin = memoryAdmin(db);
    const got = await loadMcpHeaders(admin, ["s1", "absent"]);
    assert.deepEqual(got.get("s1"), { Authorization: "Bearer secret-notion-abcd1234" });
    assert.equal(got.has("absent"), false);
    const row = db.mcp_server_headers[0] as { headers_plain: unknown; headers_enc: string; headers_iv: string };
    assert.equal(row.headers_plain, null, "plus rien en clair après la lecture");
    assert.deepEqual(JSON.parse(await decryptSecret(row.headers_enc, row.headers_iv)), { Authorization: "Bearer secret-notion-abcd1234" });
    // Lecture suivante : depuis la valeur chiffrée.
    assert.deepEqual((await loadMcpHeaders(admin, ["s1"])).get("s1"), { Authorization: "Bearer secret-notion-abcd1234" });
  });

  it("écarte à la lecture un en-tête réservé écrit par un autre chemin (SQL, ancienne version)", async () => {
    const db: Record<string, Array<Record<string, unknown>>> = {
      mcp_server_headers: [{
        server_id: "s1", headers_enc: null, headers_iv: null,
        headers_plain: { "x-founderos-user": "attaquant", "X-Approval-Token": "volé", "X-Tenant": "acme", "X-Inject": "a\nb" },
      }],
    };
    const statics = (await loadMcpHeaders(memoryAdmin(db), ["s1"])).get("s1")!;
    assert.deepEqual(statics, { "X-Tenant": "acme" });
    // Exécution planifiée (pas de personne) : aucune personne ne peut être affirmée par un en-tête statique.
    const sent = mergeMcpHeaders(statics, apiTokenHeaders({ token: "mcpt_abcdefgh_" + "x".repeat(43), userId: null }));
    assert.equal(Object.keys(sent).some((k) => k.toLowerCase() === "x-founderos-user"), false);
  });

  it("enregistre chiffré, met l'aperçu sur le serveur ; vide : efface", async () => {
    const db: Record<string, Array<Record<string, unknown>>> = { mcp_servers: [{ id: "s1", header_hints: {} }], mcp_server_headers: [] };
    const admin = memoryAdmin(db);
    const { hints } = await saveMcpHeaders(admin, "s1", { Authorization: "Bearer nouveau-jeton-9876" });
    assert.deepEqual(hints, { Authorization: "Bearer …9876" });
    assert.deepEqual(db.mcp_servers[0].header_hints, hints);
    assert.equal(JSON.stringify(db.mcp_server_headers).includes("nouveau-jeton"), false, "jamais en clair");
    assert.deepEqual((await loadMcpHeaders(admin, ["s1"])).get("s1"), { Authorization: "Bearer nouveau-jeton-9876" });
    await saveMcpHeaders(admin, "s1", {});
    assert.equal(db.mcp_server_headers.length, 0);
    assert.deepEqual(db.mcp_servers[0].header_hints, {});
  });

  it("le balayage du démarrage chiffre tout ce qui reste en clair", async () => {
    const db: Record<string, Array<Record<string, unknown>>> = {
      mcp_server_headers: [
        { server_id: "a", headers_plain: { "X-Key": "cle-0123456789" }, headers_enc: null, headers_iv: null },
        { server_id: "b", headers_plain: { "X-Key": "autre-cle-0000" }, headers_enc: null, headers_iv: null },
      ],
    };
    assert.equal(await sealPendingMcpHeaders(memoryAdmin(db)), 2);
    assert.ok(db.mcp_server_headers.every((r) => r.headers_plain === null && typeof r.headers_enc === "string"));
    assert.equal(await sealPendingMcpHeaders(memoryAdmin(db)), 0);
  });
});
