# team-machine

La machine partagée d'une équipe d'agents FounderOS. Chaque agent y est un utilisateur Linux. Chaque dossier protégé y est un groupe Linux, que seul un secret ouvre.

Documentation complète : [docs/team-machine.md](../docs/team-machine.md).

```bash
TEAM_MACHINE_TOKEN=<32+ caractères> docker compose -f team-machine/compose.yaml up -d --build
docker exec team-machine node /opt/team-machine/src/selftest.mjs   # l'isolement, vérifié
npm test                                                           # hors conteneur : signatures, état, secrets, fichiers
```

| Fichier | Rôle |
| --- | --- |
| `src/server.mjs` | Superviseur HTTP (root dans le conteneur) : `GET /health`, `POST /v1/<opération>` signé |
| `src/auth.mjs` | Signature HMAC, fraîcheur, nonces |
| `src/machine.mjs` | Les opérations : équipes, agents, dossiers, exec, fichiers, jobs, apt |
| `src/exec.mjs` | Lancement sous l'identité d'un agent (setpriv, limites, environnement propre) |
| `src/fsop.mjs` | Opérations de fichiers, exécutées sous l'identité de l'agent |
| `src/system.mjs` | Comptes, groupes, droits, signaux |
| `src/state.mjs` | État persistant : identités et empreintes de secrets, jamais les secrets |
| `src/jobs.mjs` | Processus de fond et leurs journaux |
| `src/selftest.mjs` | Auto-test d'isolement, à lancer dans le conteneur |
