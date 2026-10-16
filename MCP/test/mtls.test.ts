// mTLS du port MCP : une vraie poignée de main TLS, avec une AC, un certificat
// serveur et des certificats clients générés par openssl (test sauté s'il est
// absent). Seul le certificat client signé par l'AC interne ET au CN autorisé
// atteint la vérification du jeton.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { loadCatalog } from "../src/lib/catalog.ts";
import { BuiltinPolicyEngine } from "../src/lib/policy.ts";
import { startServer, type RunningServer } from "../src/lib/server.ts";
import { openshiftServer } from "../src/servers/openshift.ts";
import { fakeSecrets } from "./helpers.ts";

function hasOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("mTLS du port MCP", { skip: !hasOpenssl() && "openssl absent" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mcp-mtls-"));
  const p = (f: string) => path.join(dir, f);
  const ssl = (...args: string[]) => execFileSync("openssl", args, { stdio: "ignore" });
  let server: RunningServer;
  let port = 0;

  before(async () => {
    const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
    for (const ca of ["ca", "autre-ca"]) {
      ssl("req", "-x509", ...ec, "-keyout", p(`${ca}.key`), "-out", p(`${ca}.crt`), "-days", "1", "-subj", `/CN=${ca}`);
    }
    writeFileSync(p("srv.ext"), "subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n");
    writeFileSync(p("cli.ext"), "extendedKeyUsage=clientAuth\n");
    const issue = (name: string, cn: string, ca: string, ext: string) => {
      ssl("req", ...ec, "-keyout", p(`${name}.key`), "-out", p(`${name}.csr`), "-subj", `/CN=${cn}`);
      ssl("x509", "-req", "-in", p(`${name}.csr`), "-CA", p(`${ca}.crt`), "-CAkey", p(`${ca}.key`), "-CAcreateserial",
        "-out", p(`${name}.crt`), "-days", "1", "-extfile", p(ext));
    };
    issue("srv", "127.0.0.1", "ca", "srv.ext");
    issue("founderos", "founderos-ai-platform", "ca", "cli.ext");
    issue("intrus", "autre-application", "ca", "cli.ext");
    issue("etranger", "founderos-ai-platform", "autre-ca", "cli.ext");

    const catalog = loadCatalog();
    server = await startServer({
      module: openshiftServer,
      config: openshiftServer.configSchema.parse({
        api: { url: "https://127.0.0.1:1", caFile: "inutile" },
        namespaces: ["app-a"],
        readCredential: { type: "k8s-token", serviceAccount: "mcp-npr-reader" },
      }),
      cluster: "npr", catalog, policy: new BuiltinPolicyEngine(catalog),
      verifyToken: async () => { throw new Error("jeton refusé"); },
      secrets: fakeSecrets, audit: () => {},
      mcpPort: 0, mgmtPort: 0, host: "127.0.0.1",
      tls: { certFile: p("srv.crt"), keyFile: p("srv.key"), clientCaFile: p("ca.crt"), allowedClientCNs: ["founderos-ai-platform"] },
      checkIntervalMs: 0,
    });
    port = (server.mcp.address() as AddressInfo).port;
  });
  after(() => server.close());

  /** POST /mcp sans jeton, avec le certificat client donné (ou aucun). */
  const post = (client?: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({
      host: "127.0.0.1", port, path: "/mcp", method: "POST",
      ca: readFileSync(p("ca.crt")),
      ...(client ? { cert: readFileSync(p(`${client}.crt`)), key: readFileSync(p(`${client}.key`)) } : {}),
      headers: { "Content-Type": "application/json" },
    }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end("{}");
  });

  it("le certificat de FounderOS passe : la requête arrive à la vérification du jeton (401)", async () => {
    const r = await post("founderos");
    assert.equal(r.status, 401);
    assert.match(r.body, /jeton d'appel manquant/);
  });

  it("un certificat de la même AC, mais d'un autre CN : 403 avant toute lecture du jeton", async () => {
    const r = await post("intrus");
    assert.equal(r.status, 403);
    assert.match(r.body, /certificat client non autorisé/);
  });

  it("sans certificat client, ou signé par une autre AC : la poignée de main échoue", async () => {
    await assert.rejects(post());
    await assert.rejects(post("etranger"));
  });
});
