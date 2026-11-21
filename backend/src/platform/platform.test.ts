// Plateforme auto-hébergée — les parties pures : lecture des URL PostgREST,
// SQL produit, planning cron, filtres realtime, JWT, TOTP.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseQuery, parseSelect, ApiError } from "./rest/parse.ts";
import { conditionSql, filterSql, pickFunction, resolveRelationship } from "./rest/sql.ts";
import type { SchemaCache, Table } from "./rest/schema.ts";
import { cronMatches, intervalSeconds, slotFor } from "./workers.ts";
import { matchesFilter } from "./realtime.ts";
import { apiKeys, signJwt, verifyJwt } from "./jwt.ts";
import { totpCode, verifyTotp, base32Decode, base32Encode } from "./auth/totp.ts";
import { adaptMigration } from "./migrate.ts";

const q = (s: string) => parseQuery([...new URLSearchParams(s)]);

describe("lecture des URL PostgREST", () => {
  it("select : champs, alias, conversions, chemins JSON, ressources imbriquées", () => {
    const s = parseSelect("id,nom:name,meta->>key::text,to:knowledge_entities!knowledge_relations_to_entity_fkey!inner(name,sub(*))");
    assert.equal(s.length, 4);
    assert.deepEqual(s[1], { type: "field", field: { name: "name", path: [] }, alias: "nom", cast: null });
    assert.deepEqual(s[2], { type: "field", field: { name: "meta", path: [{ key: "key", text: true }] }, alias: null, cast: "text" });
    const e = s[3] as Extract<typeof s[number], { type: "embed" }>;
    assert.equal(e.target, "knowledge_entities");
    assert.equal(e.alias, "to");
    assert.deepEqual(e.hints, ["knowledge_relations_to_entity_fkey"]);
    assert.equal(e.inner, true);
    assert.equal(e.items[1].type, "embed");
  });

  it("filtres, logique, tri, pages, niveaux imbriqués", () => {
    const p = q("select=*&a=eq.1&b=not.is.null&c=in.(x,\"y,z\")&or=(d.eq.1,and(e.gt.2,f.lt.3))&order=g.desc.nullslast,h&limit=10&offset=5&rel.col=eq.v&rel.order=k.asc&rel.limit=3");
    const top = p.levels.get("")!;
    assert.equal(top.filters.length, 4);
    assert.deepEqual((top.filters[2] as { list: string[] }).list, ["x", "y,z"]);
    assert.equal(top.order[0].desc, true);
    assert.equal(top.order[0].nulls, "last");
    assert.equal(top.limit, 10);
    assert.equal(top.offset, 5);
    const rel = p.levels.get("rel")!;
    assert.equal(rel.filters.length, 1);
    assert.equal(rel.limit, 3);
    assert.equal(rel.order[0].field.name, "k");
  });

  it("not.or et rel.or", () => {
    const p = q("not.or=(a.eq.1,b.eq.2)&rel.or=(c.eq.3)");
    assert.equal(p.levels.get("")!.filters[0].type, "logic");
    assert.equal((p.levels.get("")!.filters[0] as { negate: boolean }).negate, true);
    assert.equal(p.levels.get("rel")!.filters.length, 1);
  });

  it("refuse un opérateur inconnu ou une conversion douteuse", () => {
    assert.throws(() => q("a=zz.1"), ApiError);
    assert.throws(() => parseSelect("a::text;drop table x"), ApiError);
  });
});

describe("SQL produit", () => {
  const cond = (s: string) => conditionSql("t", q(s).levels.get("")!.filters[0] as never);

  it("des littéraux échappés, jamais concaténés tels quels", () => {
    assert.equal(cond("name=eq.O'Hara"), `"t"."name" = 'O''Hara'`);
    assert.equal(cond("name=ilike.*abc*"), `"t"."name" ilike '%abc%'`);
    assert.equal(cond("id=in.()"), "false");
    assert.equal(cond("x=not.is.null"), `not ("t"."x" is null)`);
    assert.equal(cond("data->>k=eq.v"), `("t"."data"->>'k') = 'v'`);
    assert.equal(cond("tags=cs.{a,b}"), `"t"."tags" @> '{a,b}'`);
  });

  it("is n'accepte que null, true, false, unknown", () => {
    assert.throws(() => cond("x=is.1; drop"), ApiError);
  });

  it("or et and imbriqués", () => {
    assert.equal(filterSql("t", q("or=(a.eq.1,and(b.gt.2,c.lt.3))").levels.get("")!.filters[0]),
      `("t"."a" = '1' or ("t"."b" > '2' and "t"."c" < '3'))`);
  });

  const table = (name: string, pk = ["id"]): Table => ({ schema: "public", name, kind: "table", columns: new Map(), pk, uniques: [pk] });
  const cache: SchemaCache = {
    tables: new Map([["public.rel", table("rel")], ["public.ent", table("ent")], ["public.proj", table("proj")]]),
    fks: [
      { name: "rel_to_fkey", from: { schema: "public", table: "rel", columns: ["to_id"] }, to: { schema: "public", table: "ent", columns: ["id"] } },
      { name: "rel_from_fkey", from: { schema: "public", table: "rel", columns: ["from_id"] }, to: { schema: "public", table: "ent", columns: ["id"] } },
      { name: "proj_ent_fkey", from: { schema: "public", table: "proj", columns: ["ent_id"] }, to: { schema: "public", table: "ent", columns: ["id"] } },
    ],
    fns: new Map(), loadedAt: 0,
  };
  const embed = (target: string, hints: string[] = []) => ({ type: "embed" as const, target, alias: null, hints, inner: false, spread: false, items: [] });

  it("relations : plusieurs-à-un, un-à-plusieurs, ambiguïté, indice", () => {
    assert.equal(resolveRelationship(cache, cache.tables.get("public.proj")!, embed("ent")).kind, "m2o");
    assert.equal(resolveRelationship(cache, cache.tables.get("public.ent")!, embed("proj")).kind, "o2m");
    assert.throws(() => resolveRelationship(cache, cache.tables.get("public.rel")!, embed("ent")), (e: ApiError) => e.code === "PGRST201");
    assert.equal(resolveRelationship(cache, cache.tables.get("public.rel")!, embed("ent", ["rel_to_fkey"])).fk.name, "rel_to_fkey");
    assert.throws(() => resolveRelationship(cache, cache.tables.get("public.proj")!, embed("rel")), (e: ApiError) => e.code === "PGRST200");
  });

  it("surcharge de fonction choisie par les arguments nommés", () => {
    const fn = (args: Array<[string, boolean]>) => ({
      schema: "public", name: "f", returnsSet: false, returns: "scalar" as const, returnType: "int", volatile: true,
      args: args.map(([name, hasDefault]) => ({ name, type: "text", isArray: false, isJson: false, hasDefault })),
    });
    const a = fn([["x", false]]), b = fn([["x", false], ["y", false]]), c = fn([["x", false], ["z", true]]);
    assert.equal(pickFunction([a, b, c], ["x"]), a);
    assert.equal(pickFunction([a, b, c], ["x", "y"]), b);
    assert.equal(pickFunction([a, b, c], ["x", "z"]), c);
    assert.equal(pickFunction([a, b, c], ["w"]), null);
  });
});

describe("tâches planifiées", () => {
  it("intervalles en secondes et expressions cron (UTC)", () => {
    assert.equal(intervalSeconds("10 seconds"), 10);
    assert.equal(intervalSeconds("* * * * *"), null);
    const d = new Date("2026-11-04T03:30:00Z"); // mercredi
    assert.ok(cronMatches("30 3 * * *", d));
    assert.ok(cronMatches("*/15 * * * *", d));
    assert.ok(!cronMatches("17 * * * *", d));
    assert.ok(cronMatches("* * * * 3", d));
    assert.ok(!cronMatches("* * * * 1-2", d));
  });

  it("le créneau est le dernier échu, stable dans sa fenêtre", () => {
    const a = slotFor("10 seconds", new Date("2026-11-04T03:30:07.400Z"));
    const b = slotFor("10 seconds", new Date("2026-11-04T03:30:09.900Z"));
    assert.equal(a?.toISOString(), "2026-11-04T03:30:00.000Z");
    assert.equal(a?.getTime(), b?.getTime());
    assert.equal(slotFor("*/2 * * * *", new Date("2026-11-04T03:31:20Z")), null);
    assert.equal(slotFor("*/2 * * * *", new Date("2026-11-04T03:32:59Z"))?.toISOString(), "2026-11-04T03:32:00.000Z");
  });
});

describe("realtime, JWT, TOTP, migrations", () => {
  it("filtres realtime", () => {
    assert.ok(matchesFilter("run_id=eq.42", { run_id: 42 }));
    assert.ok(!matchesFilter("run_id=eq.42", { run_id: 43 }));
    assert.ok(matchesFilter("n=gt.9", { n: 10 }));
    assert.ok(matchesFilter("k=in.(a,b)", { k: "b" }));
    assert.ok(matchesFilter(undefined, null));
  });

  it("JWT : signé, vérifié, expiré, falsifié", () => {
    const secret = "x".repeat(40);
    const t = signJwt({ sub: "u", exp: 2_000_000_000 }, secret);
    assert.equal(verifyJwt(t, secret).sub, "u");
    assert.throws(() => verifyJwt(signJwt({ exp: 1 }, secret), secret), /expired/);
    assert.throws(() => verifyJwt(t, "y".repeat(40)), /signature/);
    const keys = apiKeys(secret);
    assert.equal(verifyJwt(keys.anon, secret).role, "anon");
    assert.equal(verifyJwt(keys.service, secret).role, "service_role");
  });

  it("TOTP (vecteur de la RFC 6238)", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    assert.deepEqual(base32Decode(secret), Buffer.from("12345678901234567890"));
    assert.equal(totpCode(secret, Math.floor(59 / 30)), "287082");
    assert.ok(verifyTotp(secret, totpCode(secret, Math.floor(Date.now() / 30_000))));
    assert.ok(!verifyTotp(secret, "000000", 59_000));
  });

  it("les extensions remplacées par le socle sont neutralisées, le reste intact", () => {
    const out = adaptMigration("create extension if not exists pgmq cascade;\ncreate extension if not exists vector;\nselect 1;");
    assert.match(out, /select 1; -- pgmq/);
    assert.match(out, /create extension if not exists vector;/);
  });
});
