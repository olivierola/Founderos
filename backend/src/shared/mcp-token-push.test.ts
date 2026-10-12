// Jeton tournant d'un serveur MCP (0285), côté FounderOS : la livraison par le
// serveur (connector-action, mode mcp.token_push) n'est acceptée qu'avec le
// jeton que FounderOS détient, et remplace ce jeton partout où il est enregistré.

import "../test-env.ts";

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { describe, it } from "node:test";
import { memoryDb } from "../test-memory-db.ts";

process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString("base64");
const { encryptSecret, decryptSecret } = await import("../edge/_shared/crypto.ts");
const { acceptPushedMcpToken, loadMcpApiTokens, saveMcpApiToken, tokenSha256 } = await import("../edge/_shared/mcp-api-token.ts");

const tok = (id: string) => `mcpt_${id}_${randomBytes(32).toString("base64url")}`;
const sha = (t: string) => createHash("sha256").update(t).digest("hex");

function setup() {
  const db = memoryDb({ mcp_servers: [{ id: "srv-a" }, { id: "srv-b" }, { id: "srv-c" }], mcp_server_secrets: [] }, { mcp_server_secrets: "server_id" });
  return db;
}

describe("livraison du jeton tournant", () => {
  it("l'empreinte : celle de node:crypto ; enregistrée à la saisie, avec l'origine « saisi »", async () => {
    const { admin, tables } = setup();
    const t = tok("ab12cd34");
    assert.equal(await tokenSha256(t), sha(t));
    await saveMcpApiToken(admin, "srv-a", t, "u-admin");
    assert.equal(tables.mcp_server_secrets[0].token_sha256, sha(t));
    assert.equal(tables.mcp_servers[0].token_origin, "manual");
    assert.ok(tables.mcp_servers[0].token_received_at);
  });

  it("avec le jeton détenu : remplacé, chiffré, sur toutes les lignes qui le détiennent ; les autres intactes", async () => {
    const { admin, tables } = setup();
    const t1 = tok("ab12cd34");
    const other = tok("zz99yy88");
    await saveMcpApiToken(admin, "srv-a", t1, "u-1");
    await saveMcpApiToken(admin, "srv-b", t1, "u-2"); // le même serveur, déclaré dans une autre organisation
    await saveMcpApiToken(admin, "srv-c", other, "u-3");
    const t2 = tok("ab12cd34");
    const out = await acceptPushedMcpToken(admin, t1, t2);
    assert.equal(out.status, 200);
    assert.deepEqual(out.body, { ok: true, updated: 2 });
    assert.deepEqual(out.servers?.sort(), ["srv-a", "srv-b"]);
    const tokens = await loadMcpApiTokens(admin, ["srv-a", "srv-b", "srv-c"]);
    assert.equal(tokens.get("srv-a"), t2);
    assert.equal(tokens.get("srv-b"), t2);
    assert.equal(tokens.get("srv-c"), other);
    assert.ok(tables.mcp_server_secrets.every((r: any) => !JSON.stringify(r).includes(t2.slice(14))), "jamais en clair en base");
    const a = tables.mcp_servers.find((r: any) => r.id === "srv-a")!;
    assert.equal(a.token_origin, "push");
    assert.equal(a.token_hint, `mcpt_ab12cd34…${t2.slice(-4)}`);
  });

  it("une seconde réplique livre le même jeton : rien ne change, sans autre preuve", async () => {
    const { admin } = setup();
    const t1 = tok("ab12cd34");
    const t2 = tok("ab12cd34");
    await saveMcpApiToken(admin, "srv-a", t1, "u");
    assert.equal((await acceptPushedMcpToken(admin, t1, t2)).status, 200);
    const again = await acceptPushedMcpToken(admin, t1, t2);
    assert.deepEqual([again.status, again.body.unchanged], [200, true]);
  });

  it("refusé : un jeton périmé (volé hier), un jeton inconnu, un autre serveur, une forme invalide", async () => {
    const { admin } = setup();
    const t1 = tok("ab12cd34");
    const t2 = tok("ab12cd34");
    await saveMcpApiToken(admin, "srv-a", t1, "u");
    await acceptPushedMcpToken(admin, t1, t2);
    const stolen = await acceptPushedMcpToken(admin, t1, tok("ab12cd34"));
    assert.equal(stolen.status, 401, "le jeton d'hier ne prouve plus rien");
    assert.equal((await acceptPushedMcpToken(admin, tok("ab12cd34"), tok("ab12cd34"))).status, 401);
    assert.equal((await acceptPushedMcpToken(admin, t2, tok("ffff0000"))).status, 400);
    assert.equal((await acceptPushedMcpToken(admin, "Bearer x", t2)).status, 400);
    assert.equal((await loadMcpApiTokens(admin, ["srv-a"])).get("srv-a"), t2, "le jeton détenu n'a pas bougé");
  });

  it("les jetons saisis avant 0285 (sans empreinte) : retrouvés à la première livraison", async () => {
    const { admin, tables } = setup();
    const t1 = tok("ab12cd34");
    const { ciphertext, iv } = await encryptSecret(t1);
    tables.mcp_server_secrets.push({ server_id: "srv-a", token_enc: ciphertext, token_iv: iv });
    const t2 = tok("ab12cd34");
    assert.equal((await acceptPushedMcpToken(admin, t1, t2)).status, 200);
    const row = tables.mcp_server_secrets[0];
    assert.equal(row.token_sha256, sha(t2));
    assert.equal(await decryptSecret(row.token_enc, row.token_iv), t2);
  });

  it("l'empreinte seule ne suffit pas : le jeton déchiffré doit être le même", async () => {
    const { admin, tables } = setup();
    const t1 = tok("ab12cd34");
    const decoy = tok("ab12cd34");
    const { ciphertext, iv } = await encryptSecret(decoy);
    // Une ligne dont l'empreinte aurait été falsifiée en base.
    tables.mcp_server_secrets.push({ server_id: "srv-a", token_enc: ciphertext, token_iv: iv, token_sha256: sha(t1) });
    assert.equal((await acceptPushedMcpToken(admin, t1, tok("ab12cd34"))).status, 401);
  });
});
