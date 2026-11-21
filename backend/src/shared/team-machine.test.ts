// La machine d'équipe (0296), côté plateforme : ce qui se vérifie sans base ni
// machine — noms, signature, résolution des membres.

import "../test-env.ts";
import { randomBytes } from "node:crypto";

process.env.CREDENTIAL_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const {
  findTeamOf, hmacHex, newSecret, normalizeFolderName, readTeams, resolveAgentRefs, slugify, teamKeyFor, unixUserFor,
} = await import("../edge/_shared/team-machine.ts");

describe("machine d'équipe — formes", () => {
  it("signe exactement comme la machine le vérifie (vecteur partagé avec team-machine/src/machine.test.mjs)", async () => {
    assert.equal(
      await hmacHex("k".repeat(32), '1700000000.{"nonce":"abc"}'),
      "974611c2dfaecea193c6059d7614b5c2e37a85ea6b6773b728beef8e8596ab40",
    );
  });

  it("des noms Linux valides, stables et lisibles", () => {
    const key = teamKeyFor({ id: "8f3a2c10-0000-4000-8000-000000000000", name: "Équipe Données & IA — Paris" });
    assert.equal(key, "equipe-donnees-ia-pa-8f3a");
    assert.match(key, /^[a-z][a-z0-9-]{1,26}$/, "même règle que TEAM_KEY_RE côté machine");
    assert.match(teamKeyFor({ id: "t-data", name: "" }), /^equipe-/);
    const user = unixUserFor({ id: "3f2a9c1b-0000-4000-8000-000000000000", name: "Nova, la data scientist" });
    assert.equal(user, "nova-la-data-scienti-3f2a");
    assert.match(user, /^[a-z][a-z0-9-]{1,31}$/, "même règle que USER_RE côté machine");
    assert.equal(slugify("42"), "x42");
  });

  it("un nom de dossier protégé rendu sûr, ou refusé", () => {
    assert.equal(normalizeFolderName("Rachat Concurrent 2027"), "rachat-concurrent-2027");
    assert.equal(normalizeFolderName("../../etc/passwd"), "etc-passwd");
    assert.equal(normalizeFolderName("données.v2_final"), "donnees.v2_final");
    assert.equal(normalizeFolderName("..."), null);
    assert.equal(normalizeFolderName(""), null);
    assert.ok((normalizeFolderName("x".repeat(80)) ?? "").length <= 48);
  });

  it("un secret neuf : 32 octets, base64url", () => {
    const s = newSecret();
    assert.match(s, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(s, newSecret());
  });

  it("les membres se désignent par nom ou par id, pris parmi les candidats seulement", () => {
    const mates = [{ id: "a1", name: "Atlas" }, { id: "i1", name: "Iris Éloïse" }];
    assert.deepEqual(resolveAgentRefs(["atlas", "i1", "Atlas"], mates), { ids: ["a1", "i1"], unknown: [] });
    assert.deepEqual(resolveAgentRefs("iris eloise, Zed", mates), { ids: ["i1"], unknown: ["Zed"] });
    assert.deepEqual(resolveAgentRefs(undefined, mates), { ids: [], unknown: [] });
  });

  it("l'équipe d'un agent se lit dans les réglages du service", () => {
    const settings = { teams: [{ id: "t1", name: "Data", agent_ids: ["a", "b"], lead_id: "a" }, { id: "t2", agent_ids: ["c"] }, { nope: 1 }] };
    assert.equal(readTeams(settings).length, 2);
    assert.equal(findTeamOf(settings, "b")?.id, "t1");
    assert.equal(findTeamOf(settings, "c")?.name, "Équipe");
    assert.equal(findTeamOf(settings, "z"), null);
    assert.equal(findTeamOf(null, "a"), null);
  });
});

const { buildInternalToolset } = await import("../edge/_shared/internal-agent-tools.ts");

describe("machine d'équipe — dans la boîte à outils de l'agent", () => {
  // Une base vide qui accepte tout : chaque requête rend « rien », sans erreur.
  const chain = (): unknown => new Proxy(() => {}, {
    get: (_t, prop) => {
      if (prop === "then") return (ok: (v: unknown) => void) => ok({ data: [], error: null });
      if (prop === "maybeSingle" || prop === "single") return async () => ({ data: null, error: null });
      return () => chain();
    },
  });
  const admin = { from: () => chain() } as never;
  const machine = {
    agentId: "agent-n", agentName: "Nova",
    team: { id: "t1", name: "Data", agent_ids: ["agent-n", "agent-a"], lead_id: "agent-n" },
    machine: { team_id: "t1", dashboard_id: "d1", workspace_id: "ws-1", team_key: "data-0001", status: "active", allow_system_packages: false, url: null, machine_path: "/teams/data-0001" },
    teammates: [{ id: "agent-a", name: "Atlas" }],
    unixUser: "nova-0001", home: "/teams/data-0001/home/nova-0001", teamDir: "/teams/data-0001",
    folders: [{ id: "f1", name: "rachat", path: "/teams/data-0001/dossiers/rachat", purpose: null, role: "owner",
      members: [{ agent_id: "agent-n", name: "Nova", role: "owner" }, { agent_id: "agent-a", name: "Atlas", role: "member" }] }],
    config: { url: "http://127.0.0.1:1", token: "x".repeat(40) },
  };
  const build = (teamMachine: unknown) => buildInternalToolset([], {
    admin, workspaceId: "ws-1", projectId: "proj", agentId: "agent-n", agentName: "Nova", runId: "r-1",
    requestApproval: async () => "", logEvent: async () => {}, isCancelled: async () => false,
    createDeliverable: async () => {}, createArtifact: async () => {}, teamMachine,
  } as never);

  it("présente : les outils team_* en EXECUTION, appelables d'office, et la carte des lieux dans l'index", () => {
    const ts = build(machine);
    const names = ts.defsFor("core").map((d) => d.function.name);
    for (const n of ["team_shell", "team_files", "team_folders", "team_jobs"]) {
      assert.ok(names.includes(n), `${n} appelable sans load_toolset`);
      assert.equal(ts.familyOf(n), "EXECUTION");
    }
    assert.ok(!names.includes("team_install"), "apt fermé par défaut");
    assert.match(ts.capabilitySummary, /TEAM MACHINE « Data »/);
    assert.match(ts.capabilitySummary, /\/teams\/data-0001\/home\/nova-0001\) is PRIVATE/);
    assert.match(ts.capabilitySummary, /rachat \(\/teams\/data-0001\/dossiers\/rachat — avec Atlas, tu en es propriétaire\)/);
    assert.ok(!/secret[^s]*[A-Za-z0-9_-]{40}/.test(ts.capabilitySummary));
  });

  it("apt ouvert sur la machine de l'équipe : team_install apparaît", () => {
    const ts = build({ ...machine, machine: { ...machine.machine, allow_system_packages: true } });
    assert.ok(ts.defs.some((d) => d.function.name === "team_install"));
  });

  it("absente : aucun outil de machine", () => {
    const ts = build(null);
    for (const n of ["team_shell", "team_files", "team_folders", "team_jobs", "team_install"]) {
      assert.ok(!ts.defs.some((d) => d.function.name === n), n);
    }
  });

  it("machine éteinte : l'outil le dit, sans planter le run", async () => {
    const ts = build(machine);
    const out = String(await ts.executor("team_shell", { command: "ls" }));
    assert.match(out, /^ERROR: machine d'équipe injoignable/);
    assert.match(out, /ne réessaie pas en boucle/);
  });
});
