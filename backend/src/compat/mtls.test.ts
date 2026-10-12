// Certificat client mTLS vers les serveurs MCP internes (D4) : une vraie poignée
// de main TLS, avec une AC, un certificat serveur et un certificat client
// générés pour l'occasion par openssl (test sauté s'il est absent).

import "../test-env.ts";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Agent, fetch as undiciFetch } from "undici";
import { createMcpFetch } from "./mtls.ts";

function hasOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("mTLS vers les serveurs MCP", { skip: !hasOpenssl() && "openssl absent" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mtls-"));
  const p = (f: string) => path.join(dir, f);
  const ssl = (...args: string[]) => execFileSync("openssl", args, { stdio: "ignore" });
  let server: ReturnType<typeof createServer>;
  let url = "";

  before(async () => {
    const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
    ssl("req", "-x509", ...ec, "-keyout", p("ca.key"), "-out", p("ca.crt"), "-days", "1", "-subj", "/CN=test-ca");
    writeFileSync(p("srv.ext"), "subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n");
    writeFileSync(p("cli.ext"), "extendedKeyUsage=clientAuth\n");
    for (const [name, cn] of [["srv", "127.0.0.1"], ["cli", "founderos-ai-platform"]]) {
      ssl("req", ...ec, "-keyout", p(`${name}.key`), "-out", p(`${name}.csr`), "-subj", `/CN=${cn}`);
      ssl("x509", "-req", "-in", p(`${name}.csr`), "-CA", p("ca.crt"), "-CAkey", p("ca.key"), "-CAcreateserial",
        "-out", p(`${name}.crt`), "-days", "1", "-extfile", p(`${name}.ext`));
    }
    server = createServer({
      cert: readFileSync(p("srv.crt")), key: readFileSync(p("srv.key")), ca: readFileSync(p("ca.crt")),
      requestCert: true, rejectUnauthorized: true,
    }, (req, res) => {
      const peer = (req.socket as import("node:tls").TLSSocket).getPeerCertificate();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ client: peer.subject?.CN }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `https://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });

  after(() => {
    server.closeAllConnections();
    server.close();
  });

  it("présente le certificat client aux hôtes internes", async () => {
    const f = createMcpFetch({ certFile: p("cli.crt"), keyFile: p("cli.key"), caFile: p("ca.crt"), hosts: ["127.0.0.1"] });
    const res = await f(url, { method: "POST", body: "{}" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { client: "founderos-ai-platform" });
  });

  it("sans certificat client, le serveur coupe la poignée de main", async () => {
    // AC interne reconnue, mais aucun certificat présenté.
    const agent = new Agent({ connect: { ca: readFileSync(p("ca.crt")) } });
    await assert.rejects(undiciFetch(url, { method: "POST", body: "{}", dispatcher: agent }));
    await agent.close();
  });

  it("un hôte hors liste passe par le fetch global, sans le certificat", async () => {
    const seen: string[] = [];
    const fallback = async (input: string) => { seen.push(input); return new Response("fallback"); };
    const f = createMcpFetch({ certFile: p("cli.crt"), keyFile: p("cli.key"), caFile: p("ca.crt"), hosts: ["*.apps-int.*.interne.exemple"] }, fallback);
    assert.equal(await (await f("https://api.github.com/x")).text(), "fallback");
    assert.deepEqual(seen, ["https://api.github.com/x"]);
  });

  it("recharge le certificat quand le fichier change (rotation cert-manager)", async () => {
    const certFile = p("rot.crt");
    const keyFile = p("rot.key");
    writeFileSync(certFile, readFileSync(p("srv.crt")));  // mauvais certificat d'abord (usage serveur)
    writeFileSync(keyFile, readFileSync(p("srv.key")));
    const f = createMcpFetch({ certFile, keyFile, caFile: p("ca.crt"), hosts: ["127.0.0.1"], recheckMs: 0 });
    await assert.rejects(f(url, { method: "POST", body: "{}" }));
    writeFileSync(certFile, readFileSync(p("cli.crt")));
    writeFileSync(keyFile, readFileSync(p("cli.key")));
    // mtime à la milliseconde : un léger délai garantit qu'il change.
    await new Promise((r) => setTimeout(r, 20));
    const res = await f(url, { method: "POST", body: "{}" });
    assert.equal(res.status, 200);
  });
});
