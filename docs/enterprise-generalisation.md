# FounderOS pour les entreprises : plan de généralisation

L'installation SCIC (`docs/openshift-implementation.md`) a été construite pour une infrastructure précise : OpenShift, Keycloak, un Vault par cluster, LiteLLM vers Azure OpenAI.

Depuis le 12/10/2026, l'architecture retenue pour l'infrastructure interne est l'[architecture Hub](architecture-hub.md). FounderOS y tourne sur le Hub, avec un serveur MCP par cluster et Azure OpenAI en direct, sans Keycloak ni Vault. Elle s'appuie sur ce que ce plan a rendu général : SSO réglable, jeton tournant, installateur.

Ce plan en tire un produit que **n'importe quelle entreprise** peut :
- **installer chez elle**, sur Kubernetes, OpenShift ou une machine virtuelle ;
- ou **utiliser depuis le cloud FounderOS**, en le connectant à ses outils internes sans ouvrir de port entrant.

Dans les deux cas, elle branche son SSO, choisit au nom de qui les agents agissent sur chaque outil, et décide de ce qui demande une approbation.

---

## 1. Les deux modes, un seul produit

| | Installé chez le client | Connecté depuis le cloud |
| --- | --- | --- |
| Où tourne FounderOS | Dans l'infrastructure du client (Helm ou VM) | Sur le cloud FounderOS |
| Comment il joint les outils | Directement, sur le réseau interne (mTLS en option) | Par le **relais** installé chez le client, en connexions sortantes seulement |
| Données et prompts | Ne quittent pas le client | Transitent par le cloud ; les secrets peuvent rester chez le client (relais) |
| LLM | La passerelle du client (LiteLLM, Azure, vLLM…) | Celle de FounderOS, ou celle du client |
| SSO des personnes | L'IdP du client, configuré dans l'interface | Idem |

Le code est le même. Seuls changent la **transport** vers les outils (direct ou relais) et l'endroit où vivent la base et les secrets.

---

## 2. Ce qui est déjà générique

| Brique | Où | État |
| --- | --- | --- |
| SSO des personnes : OIDC et SAML, modèles Entra ID, Keycloak et générique, rôles déduits des groupes | migration 0272, `sso-admin`, Administration → Authentification | Générique |
| Outils internes décrits par le client : URL de base, opérations déclarées, 9 schémas d'authentification (Bearer, clé, Basic, en-têtes, OAuth2 client credentials, OAuth2 + PKCE, session, mTLS…) | migration 0267, `custom-connectors.ts`, Ressources → Outils internes | Générique |
| Relais sortant : liste blanche d'hôtes et de binaires, secrets gardés chez le client, file chiffrée | `connector-relay/` (image, Helm) | Générique |
| Journal d'accès chaîné par empreinte, approbation des gestes destructifs | 0267, `custom_connector_calls` | Générique |
| Serveurs MCP distants : jeton d'API (par défaut), en-tête, OAuth, échange de jeton, contexte signé | `mcp_servers`, `mcp-gateway`, 0278 | Générique |
| Backend Express à la place des edge functions | `backend/` | Générique |
| Passerelle LLM imposée (LiteLLM ou Azure) | `llm-upstream.ts` | Générique, mais réglée par variables d'environnement |
| Approbations à quatre yeux, jeton signé, rejeu de l'action exacte ; règles d'approbation (qui, combien, en combien de temps) | 0275, 0281, `mcp-approval.ts`, `approval-policy.ts` | Générique : serveurs MCP et outils internes |
| Audit JSON et métriques des appels | `mcp-observe.ts`, `backend/src/shared/metrics.ts` | Générique, branché sur MCP seulement |
| Serveurs MCP prêts à l'emploi (OpenShift, Argo CD, Prometheus/Loki, ACM, Git, PRTG) | `MCP/` | Réutilisables tels quels |

## 3. Ce qui reste propre à SCIC

| Point | Aujourd'hui | Pourquoi ça bloque une autre entreprise |
| --- | --- | --- |
| Identité déléguée | Keycloak seulement, réglé par `KEYCLOAK_*` et `AGENT_IDP_CLIENTS` | Une entreprise sous Entra ID, Okta ou Ping ne peut pas faire agir un agent au nom d'une personne |
| Délégation | Seulement pour les serveurs MCP | Les outils internes (0267) agissent sous l'identité d'un profil, pas de la personne qui demande |
| Approbateurs | Résolu par G3 : des règles par espace ; `ai-ops-prd-approver` n'est plus que le défaut sans règle | — |
| Politique des tools | Catalogue OPA écrit pour les outils OpenShift | Rien n'est prévu pour les outils internes déclarés dans l'interface |
| Réglages | Variables d'environnement (LLM, approbations, hôtes internes, webhooks) | Un administrateur ne peut ni les voir, ni les changer, ni les diagnostiquer |
| Installation | Une doc de 2 300 lignes pour OpenShift | Pas d'installateur, pas de premier démarrage guidé |
| Provisioning | Les comptes naissent à la première connexion SSO | Pas de création ni de retrait automatique depuis l'annuaire (SCIM) |
| MCP depuis le cloud | Les serveurs MCP doivent être joignables en direct | En mode cloud, ils sont derrière le pare-feu du client |

---

## 4. Architecture cible

```
                 ┌──────────────── FounderOS (installé ou cloud) ─────────────────┐
 Personnes ──SSO─►  Fournisseurs d'identité ──► Identité déléguée par personne      │
 (Entra, Okta,   │        │                       (échange de jeton, OBO, contexte  │
  Keycloak…)     │        ▼                        signé, consentement OAuth)       │
                 │  Agents ── chacun a son identité machine auprès de l'IdP          │
                 │        │                                                         │
                 │        ▼                                                         │
                 │  Connexions  = transport × identité × environnement              │
                 │        │        (direct, relais, mTLS)  (dev, recette, prod)     │
                 │        ▼                                                         │
                 │  Politiques : qui peut quoi, ce qui demande une approbation,     │
                 │               par qui, en combien de temps                       │
                 │        │                                                         │
                 │  Audit et métriques : un événement par appel, même trace         │
                 └────────┼─────────────────────────────────────────────────────────┘
                          │ direct (installé)          │ relais sortant (cloud)
                          ▼                            ▼
                   Outils internes, serveurs MCP, API maison, CLI (helm, kubectl…)
```

Cinq notions, chacune configurable dans l'interface :

1. **Fournisseur d'identité.** Il connecte les personnes (déjà fait). Il sait aussi, s'il le permet, émettre un jeton au nom d'une personne pour un outil donné :
   - échange de jeton RFC 8693 : Keycloak, Okta, Ping, Auth0 ;
   - *On-Behalf-Of* : Entra ID.
2. **Identité d'un agent.** Un client de l'IdP par agent (`client_credentials`), ou un certificat. Elle donne à l'agent ses propres limites, qui s'ajoutent à celles de la personne.
3. **Connexion à un outil.** Un connecteur déclaré (0267) ou un serveur MCP, avec trois réglages :
   - un **transport** : direct, relais, mTLS ;
   - un **mode d'identité** : voir la section 5 ;
   - un **environnement** : développement, recette, production.
4. **Politique.** Quelles opérations sont permises, et lesquelles demandent une approbation :
   - selon le risque (lecture, écriture, destructif) et l'environnement ;
   - en précisant par qui (rôle FounderOS, groupe ou rôle de l'IdP), combien d'approbateurs et sous quel délai ;
   - avec toujours la règle des quatre yeux.
5. **Socle d'installation.** Passerelle LLM, emplacement des secrets (base chiffrée, Vault, relais), clé de signature des approbations, notifications, observabilité. Visibles et vérifiables dans une page « Installation ».

## 5. Au nom de qui un agent agit sur un outil

Le mode se choisit **par connexion**. L'entreprise y règle le compromis entre simplicité et traçabilité.

| Mode | Ce que voit l'outil | Quand le choisir | Exige |
| --- | --- | --- | --- |
| **Compte de service** (existe) | Un compte technique, le même pour tous | Outils en lecture, sans enjeu de traçabilité | Un secret par profil |
| **Consentement OAuth de la personne** (existe, à étendre) | La personne, après un premier consentement | SaaS internes avec OAuth (GitLab, Jira Server…) | Un jeton **par personne**, plus seulement par profil |
| **Échange de jeton** (fait pour Keycloak) | La personne **et** l'agent, dans un jeton court pour cet outil seul | Outils d'infrastructure critiques ; ce qu'a construit SCIC | Un IdP compatible RFC 8693 |
| **On-Behalf-Of Entra ID** (nouveau) | La personne et l'application | Entreprises sous Entra ID, API protégées par Entra | Une application Entra par agent |
| **Contexte utilisateur signé** (nouveau) | L'agent, avec la personne attestée par FounderOS (JWT court, même JWKS que les approbations) | IdP sans échange de jeton, outils maison, serveurs MCP FounderOS | La clé publique de FounderOS côté outil |
| **Jeton d'API du serveur** (par défaut pour les serveurs MCP, 0278, tournant depuis 0285) | Les droits du jeton ; la personne et l'agent, affirmés par FounderOS pour l'audit | Le cas courant : voir la section 5 bis | Une graine générée à l'installation du serveur ; le jeton change chaque jour et le serveur le livre lui-même |

Avec le contexte signé, la personne est attestée par FounderOS et non par l'IdP. L'écart est plus faible qu'il n'y paraît : avec l'échange de jeton, FounderOS conserve déjà les jetons des personnes connectées.

---

## 5 bis. Modèle simplifié (par défaut)

L'échange de jeton demande, pour chaque entreprise, un IdP compatible, un client par agent et des réglages de délégation. Le modèle simplifié retire ces pièces pour le cas courant. L'échange de jeton reste disponible comme option avancée.

### Se connecter à FounderOS

- **SSO de l'entreprise** ou **e-mail et mot de passe** : rien d'autre, **installé chez le client comme dans le cloud**.
- Deux modes (`SSO_MODE`, migration 0282) :

  | | Partagé (défaut : le cloud, une instance pour plusieurs organisations) | Dédié (une installation pour un client) |
  | --- | --- | --- |
  | Qui configure | Les owners et admins de **chaque** organisation | L'organisation « maison », revendiquée par le premier fournisseur |
  | Pour quelles adresses | Les domaines que l'organisation a **vérifiés** : enregistrement DNS TXT `_founderos-sso.<domaine>` ; un domaine n'est vérifié que par une organisation | Toutes, l'exploitant contrôle l'instance |
  | Garde | La base refuse toute connexion SSO dont l'adresse n'est pas d'un domaine vérifié par l'organisation du fournisseur (déclencheur sur `auth.identities`) ; sans cette garde installée, le mode reste fermé | Celle de 0272 |
  | Page de connexion | Aucun fournisseur listé (ce serait la liste des clients) : « Continue with company SSO », l'adresse trouve le fournisseur de son domaine | Un bouton par fournisseur |
  | « SSO seulement » | Par domaine : l'adresse est envoyée à son SSO au lieu du mot de passe | Pour toute l'installation |

  Sans cette garde, une organisation pourrait déclarer un IdP qui affirme les adresses d'une autre, et entrer sur leurs comptes : c'est ce que 0282 rend impossible.
- Le SSO se configure **depuis la page de connexion**, par le lien « Set up SSO » :
  1. `/login?next=/sso-setup` : connexion avec un compte propriétaire ou admin ;
  2. `/sso-setup` retrouve les organisations où la personne a ce rôle ;
  3. il ouvre Administration → Authentification (directement s'il n'y en a qu'une).
- Sur une installation neuve :
  - le premier compte se crée par e-mail ;
  - il configure le SSO ;
  - il peut ensuite imposer « SSO uniquement ».

### Brancher un serveur MCP

1. **À l'installation du serveur**, générer sa graine :

   ```bash
   npm run token -- seed --file seed.txt   # dans l'image : node dist/token-cli.js seed …
   ```

   - La graine (256 bits) devient le Secret `mcp-token-seed`, monté par le serveur (`auth.mode: rotating`, par défaut). Elle ne quitte jamais le serveur.
   - La commande affiche le **jeton du jour** : `mcpt_<id>_<secret>`. C'est le seul qui se recopie.
2. **Dans FounderOS**, Ressources → Serveurs MCP, mode « Jeton d'API du serveur », renseigner :
   - le jeton du jour ;
   - l'audience : le `MCP_AUDIENCE` du serveur, requis seulement si des tools demandent une approbation ;
   - le cluster.

   FounderOS garde le jeton chiffré. Il n'en affiche ensuite que l'indice (`mcpt_ab12cd34…x9Qz`).
3. **Chaque jour, le jeton change, sans intervention :**
   - le serveur calcule le nouveau jeton depuis sa graine (HMAC-SHA256 de la période) ; toutes ses répliques ont le même, sans rien partager ;
   - il le livre à FounderOS (`connector-action`, mode `mcp.token_push`, migration 0285), en présentant comme preuve le jeton que FounderOS détient ;
   - FounderOS remplace le jeton, chiffré, sur toutes les connexions qui le détenaient ;
   - l'ancien jeton reste accepté un jour de plus ; si FounderOS a manqué des livraisons, le serveur rattrape jusqu'à 7 jours.
4. **À chaque appel d'un agent**, FounderOS ajoute côté serveur :
   - `Authorization: Bearer <jeton>` ;
   - `X-FounderOS-User` (la personne) et `X-FounderOS-Agent` (l'agent) ;
   - le `traceparent` du run.

   Le serveur MCP :
   - compare le jeton à celui du jour et de la veille, en temps constant ;
   - accorde les rôles et scopes du jeton (`auth.roles`) ;
   - applique ensuite, comme avant, OPA, le catalogue de son cluster et les approbations (en production et sur le Hub) ;
   - agit avec les identifiants de son cluster : jetons courts par TokenRequest pour Kubernetes, Secrets montés pour les outils, ou Vault si l'installation en a un.

Les jetons fixes (`auth.mode: token`, `npm run token -- generate`, empreintes dans le Secret `mcp-tokens`) restent disponibles, pour un serveur qui ne peut pas joindre FounderOS.

### Est-ce sûr ?

Oui, avec les garanties suivantes, toutes en place et testées.

| Risque | Parade |
| --- | --- |
| Vol d'un jeton (journal, poste, base FounderOS) | Il ne vaut qu'un jour, plus un jour de grâce : le lendemain du suivant, il est refusé. Un jeton volé et périmé ne permet pas non plus de livrer un faux jeton à FounderOS, qui n'accepte que le jeton qu'il détient. |
| Vol de la graine sur le cluster | Elle permet de calculer les jetons : elle est rangée comme les autres secrets du serveur (Secret de son namespace, monté dans le seul conteneur MCP). La changer : `token seed --force`, puis réenrôler. |
| Fuite de la base FounderOS | Jeton chiffré (AES-GCM, `CREDENTIAL_ENCRYPTION_KEY`) dans `mcp_server_secrets` : aucune policy, aucun droit pour `anon` ni `authenticated`. L'empreinte SHA-256 qui sert à retrouver la ligne ne redonne pas le jeton. |
| Un faux serveur livre un jeton à FounderOS | Il lui faudrait le jeton que FounderOS détient. Même alors, le nouveau jeton ne part que vers l'adresse enregistrée de la connexion, où le vrai serveur le refuse : au pire, les appels échouent jusqu'au réenrôlement. |
| Le modèle, ou une injection de prompt, lit le jeton | Le jeton n'entre jamais dans le contexte du modèle : il est ajouté au moment de l'appel, côté serveur. |
| Un membre remplace l'URL du serveur par la sienne pour recevoir le jeton | Deux protections. **Les droits** (0279) : un serveur ne se modifie que par les propriétaires, les admins et le membre qui l'a ajouté ; les lecteurs ne créent ni ne modifient rien. **La destination** : le jeton y est lié. Si l'origine de l'URL (schéma, hôte, port), le relais, l'espace ou le mode changent, il est effacé (déclencheurs de 0278 et 0285) et doit être ressaisi. |
| La même chose sur un serveur OAuth : changer l'URL, ou le `token_endpoint` pour recevoir le refresh token et le client secret | Mêmes droits. Les secrets OAuth sont liés à l'origine de l'URL, au relais, à l'espace, au mode et aux points de terminaison déjà fixés (autorisation, jeton, enregistrement, ressource, `client_id`). Si l'un change, ils sont effacés et la connexion est à refaire (déclencheur de 0279). Connecter un serveur OAuth exige aussi le droit de le modifier. |
| Les en-têtes statiques d'un serveur (`Authorization`, une clé d'API) lisibles par tout membre | Chiffrés dans `mcp_server_headers`, que seul le backend lit ; la ligne du serveur ne garde qu'un aperçu (`Bearer …x9Qz`). Le déclencheur de 0280 y déplace toute valeur écrite, par n'importe quel chemin. Liés à leur destination comme le jeton. Un en-tête que FounderOS pose lui-même (`X-FounderOS-User`, `X-Approval-Token`, `traceparent`…) est refusé à la saisie et écarté à la lecture : il ne peut pas usurper une personne. |
| Jeton trop puissant | Rôles et scopes propres à chaque serveur, minimaux. OPA et le catalogue continuent de filtrer chaque tool. |
| Action en production | Approbation à quatre yeux et jeton d'approbation signé par FounderOS (ES256), lié aux paramètres exacts. Le jeton d'API seul ne suffit pas. |
| Jeton compromis | Il expire seul en deux jours au plus. Coupure immédiate : arrêter le serveur et changer sa graine, puis réenrôler. |
| Interception réseau | TLS et mTLS inchangés, NetworkPolicy, ou relais sortant. Dans la file du relais, le jeton est scellé comme les autres secrets. La livraison au FounderOS passe en HTTPS. |

**Le compromis.** La personne est **affirmée** par FounderOS, pas **prouvée** par l'IdP. Celui qui détiendrait le jeton pourrait agir sous n'importe quel nom, dans les limites du jeton, et au plus deux jours. Trois réponses :
- des rôles minimaux par serveur ;
- un jeton qui change chaque jour ;
- l'impossibilité de forger une approbation, qui exige la clé de signature de FounderOS.

L'audit garde, des deux côtés, la personne, l'agent et l'identifiant du jeton (`token_id`, le même de jour en jour) sous le même `trace_id`. Quand l'entreprise veut que l'IdP prouve la personne, elle choisit l'échange de jeton pour ce serveur.

### Livré (11/10/2026)

| Côté | Contenu |
| --- | --- |
| Serveur MCP | `src/lib/api-tokens.ts` (vérification en temps constant, rechargement à chaud), générateur `src/token-cli.ts` (`generate`, `list`, `revoke`), `AUTH_MODE=token`, Helm `auth.mode: token` |
| Base | Migration 0278 : mode `api_token`, `token_hint`, table `mcp_server_secrets`, déclencheur qui lie le jeton à sa destination. Migration 0279 : droits sur les serveurs MCP (lecture pour tous, modification par les admins et le créateur), secrets OAuth liés à leur destination. Migration 0280 : en-têtes statiques chiffrés, aperçus, liés à leur destination |
| FounderOS | `_shared/mcp-api-token.ts` ; appels des agents, découverte, approbations et rejeu ; `set_token` dans `mcp-gateway` ; formulaire des serveurs MCP |
| Connexion | Lien « Set up SSO » sur la page de connexion, page `/sso-setup` |
| Tests | 7 tests de bout en bout contre le vrai serveur MCP (`mcp-api-token.e2e.test.ts`) ; 10 tests des en-têtes (`mcp-headers.test.ts`) ; 28 contrôles SQL sur 0278, 31 sur 0279, 27 sur 0280 |

### Jeton tournant (12/10/2026)

| Côté | Contenu |
| --- | --- |
| Serveur MCP | `src/lib/rotating-token.ts` : jeton calculé par période depuis une graine, accepté le jour même et le lendemain, livraison à FounderOS avec rattrapage sur 7 jours ; `token seed` et `token current` ; `AUTH_MODE=rotating`, Helm `auth.mode: rotating` (défaut du chart MCP et de la passerelle) ; métrique `mcp_token_push_total` |
| Base | Migration 0285 : empreinte SHA-256 du jeton enregistré (retrouver la ligne sans tout déchiffrer), date et origine du dernier jeton reçu ; la garde de destination de 0278 les efface aussi |
| FounderOS | `acceptPushedMcpToken` (`_shared/mcp-api-token.ts`) : seul le jeton détenu prouve la livraison, comparé en temps constant après déchiffrement ; mode `mcp.token_push` de `connector-action` (la fonction des appelants sans session ; le projet cloud est à sa limite de fonctions) ; formulaire : date de la dernière livraison, réenrôlement |
| Tests | 15 tests MCP (`rotating-token.test.ts`) ; 6 tests de réception (`mcp-token-push.test.ts`) ; 4 étapes de bout en bout contre le vrai serveur MCP et le vrai livreur (`mcp-rotating-token.e2e.test.ts`) ; 8 contrôles SQL sur 0285 |

---

## 6. Lots

| Lot | Objet | État |
| --- | --- | --- |
| G1 | Fournisseurs d'identité délégués (tout IdP, Entra OBO) | **Fait** (11/10/2026) |
| G2 | Connexions unifiées (identité déléguée et contexte signé partout, MCP par le relais, environnement) | **Fait** (11/10/2026), sauf le consentement OAuth par personne |
| — | Modèle simplifié : SSO configuré depuis la page de connexion, jeton d'API pour les serveurs MCP (section 5 bis) | **Fait** (11/10/2026) ; jeton tournant, livré par le serveur (12/10/2026) |
| G3 | Politiques d'approbation | **Fait** (11/10/2026) |
| G4 | Réglages et diagnostic de l'installation | **Fait** (11/10/2026) |
| G5 | Installateur | **Fait** (11/10/2026) |
| G6 | Provisioning SCIM | **Version allégée faite** (11/10/2026) ; SCIM complet reporté |
| G7 | Passerelle d'entreprise | **Fait** (12/10/2026) |

### G1 : fournisseurs d'identité délégués (fait)

- **But :** l'identité déléguée de D2 et D3 vaut pour tout IdP OIDC, et se règle dans l'interface.
- **Fichiers :**
  - migration `0276_delegated_identity.sql` :
    - `delegation`, `token_endpoint` et `subject_claim` sur `enterprise_sso_providers` ;
    - `enterprise_sso_provider_secrets` : le secret du client du portail, chiffré ;
    - `agent_idp_identities` : le client de chaque agent, secret chiffré, jamais lisible côté client ;
    - `auth_config.provider` sur les serveurs MCP ;
  - `_shared/idp-directory.ts` : le fournisseur qui délègue et l'identité de chaque agent, lus en base, avec repli sur `KEYCLOAK_*` et `AGENT_IDP_CLIENTS` ;
  - `_shared/idp-tokens.ts` :
    - point de jeton explicite, au lieu du chemin Keycloak ;
    - claim d'identité `sub` ou `oid`, et jeton par ressource ;
    - révocation par le document de découverte ;
  - `_shared/mcp-auth.ts` : échange de jeton RFC 8693 **et** *On-Behalf-Of* d'Entra ID ; découverte des tools et pré-décision OPA pour tout IdP ;
  - `sso-admin` :
    - délégation enregistrée avec le fournisseur (point de jeton lu dans la découverte, `offline_access` ajouté, secret chiffré) ;
    - identités des agents ;
    - test d'émission d'un jeton ;
  - fonction native `idp-token` et `auth-context.tsx` : le jeton de la personne est conservé pour **le fournisseur de sa connexion**, s'il délègue ;
  - serveurs MCP :
    - jetons Entra (`oid`, `scp`, `roles`, `appid`) ;
    - `IDP_ISSUER` et `IDP_JWKS_URL` (alias des `KEYCLOAK_*`) ;
    - `CALL_TOKEN_MAX_LIFETIME` et `APPROVAL_AUDIENCE` ;
  - interface :
    - Authentification → réglage « Délégation aux agents » sur chaque fournisseur OIDC ;
    - section **Identités des agents**, avec un bouton « Tester » ;
    - champ « Fournisseur » sur les serveurs MCP en échange de jeton.
- **Une personne, une identité :** les jetons d'appel désignent la personne par `oid` s'il existe, sinon par `sub`. FounderOS (approbations, audit) et les serveurs MCP lisent la même chose. Chez Entra ID, le `sub` change d'une application à l'autre : la règle des quatre yeux compare donc des `oid`.
- **Compatibilité :** une installation réglée par variables (SCIC) continue sans rien changer. Les 22 tests de D2 et D3 passent inchangés, par le repli.

**Régler un IdP à échange de jeton (Keycloak, Okta…)**

1. Authentification → le fournisseur OIDC → Délégation aux agents : « Échange de jeton », puis ressaisir le secret client.
2. Un client confidentiel par agent :
   - échange de jeton permis ;
   - audiences permises : les serveurs MCP qu'il appelle ;
   - scopes : ceux de ses tools.

   Pour Keycloak, `configure-platform-realm.sh` les crée (openshift-implementation, 7.2).
3. Identités des agents → Ajouter : agent, fournisseur, client, secret. « Tester » avec l'audience d'un serveur, par exemple `mcp-prd`, doit émettre un jeton.

**Régler Entra ID (On-Behalf-Of)**

1. **Application du portail,** celle de la connexion des personnes :
   - URI de redirection : celle de l'Auth (Authentification → À déclarer chez votre IdP) ;
   - scopes `openid profile email offline_access` ;
   - permission déléguée sur l'API de chaque application d'agent (`access_as_user`), avec consentement administrateur.
2. **Une application par agent :**
   - une API exposée (`api://<id de l'application de l'agent>`, scope `access_as_user`) ;
   - un secret client ;
   - des permissions déléguées sur l'API de chaque serveur MCP, avec consentement administrateur ;
   - pour les exécutions planifiées, des rôles d'application attribués sur ces mêmes API.
3. **Une application par serveur MCP,** la ressource :
   - une API exposée (`api://mcp-prd`) avec ses scopes (`ocp.read`…) et ses rôles d'application ;
   - `accessTokenAcceptedVersion: 2` dans le manifeste, pour des jetons v2 (issuer `…/<tenant>/v2.0`).
4. **Dans FounderOS :**
   - le fournisseur Entra, avec la délégation « Entra ID On-Behalf-Of » ;
   - les identités des agents, en laissant la portée vide (`api://<id de l'application de l'agent>/.default`) ;
   - sur chaque serveur MCP : audience `api://mcp-prd`, et le fournisseur s'il y en a plusieurs.
5. **Sur le serveur MCP (chart) :**

   | Valeur | Réglage |
   | --- | --- |
   | `keycloak.issuer` | `https://login.microsoftonline.com/<tenant>/v2.0` |
   | `keycloak.jwksUrl` | `https://login.microsoftonline.com/<tenant>/discovery/v2.0/keys` |
   | `audience` | **l'ID d'application** de la ressource : l'`aud` d'un jeton v2 |
   | `keycloak.allowedAgents` | les ID d'application des agents |
   | `keycloak.maxTokenLifetime` | `5460`, sauf politique de durée de vie Entra (10 minutes au moins) |
   | `approval.audience` | `api://mcp-prd` : l'audience que FounderOS signe dans les jetons d'approbation |

   Les scopes d'Entra ne peuvent pas contenir « : ». Le catalogue OPA doit donc nommer les scopes comme l'API Entra (`ocp.read`), ou s'appuyer sur les rôles.

- **Vérifié par :**
  - 11 tests (`backend/src/shared/delegated-identity.test.ts`), contre un faux Entra et un faux IdP RFC 8693 :
    - fournisseur désigné, unique ou ambigu, et repli par variables ;
    - dépôt vérifié par `oid` ;
    - chaîne OBO complète, avec cache ;
    - assertion adressée à une autre application : refusée, avec la raison d'Entra ;
    - exécution planifiée par rôles d'application ;
    - quatre yeux par `oid` ;
    - point de jeton non Keycloak et audiences refusées ;
    - pré-décision OPA avec un jeton Entra ;
  - 2 tests côté serveur MCP : jeton Entra lu par `oid`, `scp`, `roles` et `appid` ; durée de vie Entra acceptée seulement si on l'autorise ;
  - 21 contrôles de la migration 0276 sur PGlite : contraintes, secrets illisibles, visibilité réservée aux admins, cascade.
- **À valider avec un vrai locataire Entra :**
  - où l'Auth range `oid` dans les données d'identité : premier niveau ou `custom_claims`, les deux sont lus ;
  - le consentement combiné (`knownClientApplications`).

### G2 : connexions unifiées (fait, sauf le consentement OAuth par personne)

- **But :** les connecteurs déclarés et les serveurs MCP partagent les modes d'identité, les transports, l'environnement et l'audit.
- **Fichiers :**
  - migration `0277_unified_connections.sql` :
    - schémas `delegated` et `signed_context` pour les outils internes (audience requise) ;
    - `auth_mode = 'signed_context'` et `relay_id` pour les serveurs MCP, avec un garde : relais du même espace ;
    - `environment` (development, staging, production) sur les deux ;
    - secrets de tâche chiffrés (`job_secrets_enc`) et `mcp_server_id` dans la file du relais ;
  - `_shared/user-context.ts` : le contexte utilisateur signé, et les rôles de la personne (jetons de l'IdP et groupes lus à la connexion SSO, jamais `user_metadata`) ;
  - `_shared/founderos-jwt.ts` : la clé et le JWKS de FounderOS, partagés par les approbations et le contexte signé (`typ` distinct) ;
  - `_shared/mcp-relay.ts` : le transport MCP par le relais ;
  - `_shared/mcp-client.ts` : transport remplaçable ;
  - `_shared/custom-connectors.ts` :
    - identité par appel, sans profil d'identifiants ;
    - `relayJob` générique, et remplissage des secrets de tâche à la réclamation ;
    - audit et métriques D7 ;
  - `_shared/mcp-auth.ts`, `internal-agent-run`, `internal-agent-tools`, `mcp-gateway`, `mcp-approval` : contexte signé et relais, pour les appels, la découverte et le rejeu des approbations ;
  - relais (`connector-relay/`) :
    - certificat client pour les serveurs MCP en mTLS (`RELAY_CLIENT_CERT_FILE`, `RELAY_CLIENT_KEY_FILE`, `RELAY_CLIENT_CERT_HOSTS`) ;
    - transmission de `mcp-session-id` et `www-authenticate` ;
  - serveurs MCP : le vérificateur d'approbation exige `typ: JWT`, si bien qu'un contexte signé n'est jamais pris pour une approbation ;
  - interface :
    - outils internes : schémas « Au nom de la personne » et « Contexte signé par FounderOS », environnement ;
    - serveurs MCP : mode « Contexte signé », choix « En direct » ou « Par le relais », environnement, et pastilles dans la liste.
- **Ce qui protège quoi :**
  - **dans la file du relais,** tout en-tête qui porte une identité (jeton d'appel, contexte signé, jeton d'approbation) devient un secret de tâche. Il est chiffré, et la requête n'en garde que le marqueur. FounderOS le déchiffre au moment où le relais réclame la tâche, puis l'efface ;
  - **par le relais,** c'est la liste blanche du relais, chez le client, qui décide des hôtes joignables. `MCP_INTERNAL_HOSTS` ne s'applique qu'en direct, et https reste exigé ;
  - **identité par appel :** l'identité déléguée exige un agent. Le journal d'accès note « personne via agent » ;
  - **le studio de code et les agents publics** ignorent les serveurs en identité déléguée, en contexte signé ou par relais.
- **Régler un serveur MCP en contexte signé :**
  - `keycloak.issuer` = `APPROVAL_ISSUER` de FounderOS ;
  - `keycloak.jwksUrl` = `<FounderOS>/functions/v1/approval-jwks` (ou une ConfigMap) ;
  - `keycloak.allowedAgents` = les noms des agents, et `founderos-discovery` pour la découverte des tools.

  Les rôles du contexte sont ceux de l'IdP. Le catalogue OPA les lit comme d'habitude.
- **Vérifié par :**
  - 9 tests (`backend/src/shared/unified-connections.test.ts`) :
    - en-têtes scellés ;
    - mise en file sans jeton en clair, puis secrets remplis et effacés à la réclamation ;
    - contexte signé vérifié par le code du serveur MCP, et refusé comme approbation ;
    - provenance des rôles ;
    - **serveur MCP de bout en bout par le vrai code du relais**, avec la liste blanche du relais qui refuse un hôte non déclaré ;
    - outil interne en contexte signé par le relais : jeton chiffré dans la file, identité au journal, événement d'audit avec l'environnement ;
  - 15 contrôles de la migration 0277 sur PGlite ;
  - les tests existants inchangés : 213 côté backend, 87 côté MCP, 3 côté relais.
- **Reste à faire :** le jeton **par personne** pour le schéma OAuth + PKCE (`custom_connector_user_tokens`). Aujourd'hui, un profil OAuth porte l'identité de la personne qui l'a connecté. Le schéma « Au nom de la personne » couvre déjà ce besoin pour tout outil protégé par l'IdP de l'entreprise.

### G3 : politiques d'approbation

- **But :** D6 devient une règle que chaque entreprise écrit, pour tout outil.
- **Contenu :**
  - une table `approval_policies`, avec :
    - une portée : connexion, environnement, risque, opération ;
    - des approbateurs : rôle FounderOS, ou groupe ou rôle de l'IdP ;
    - un quorum (1 ou plus), une échéance et les quatre yeux, toujours appliqués ;
  - le trigger de 0275 généralisé, avec le rôle et l'environnement lus dans la politique, et non plus écrits en dur ;
  - le jeton d'approbation signé, aussi pour les connecteurs (en-tête relayé à l'outil s'il sait le vérifier) ;
  - l'écran « Approbations PRD » devient « Approbations », filtré par environnement.
- **Acceptation :** les tests de D6, rejoués sur une politique « prod, écriture, 2 approbateurs du groupe Ops ».

#### Livré (11/10/2026)

PolicyGuard décidait déjà **s'il** faut une approbation (niveau de risque, grille par équipe, autopilote). Une règle d'approbation dit **qui** approuve, **combien** de personnes et en **combien de temps**. Les deux se complètent : aucune ne retire une approbation que l'autre demande.

| Point | Ce qui est en place |
| --- | --- |
| Règles | Table `approval_policies` (0281), écran Administration → Approbations → Règles (owners et admins écrivent, membres lisent). Portée : type de connexion, connexion, environnement (`production`, `staging`, `development` : celui de la connexion, G2), risque minimal, opérations. Approbateurs : rôle FounderOS, ou rôle ou groupe de l'IdP. Quorum de 1 à 5, échéance de 1 à 1440 minutes, priorité. |
| Quelle règle | La plus petite priorité, puis la plus précise, puis la plus ancienne. Une règle de production ne vaut que pour une connexion déclarée en production. |
| Serveur MCP | Le serveur décide toujours de demander (OPA). La règle fixe les approbateurs, le quorum et l'échéance. Sans règle : le comportement d'avant (`ai-ops-prd-approver`, 1 approbateur, 15 minutes). SCIC ne change pas tant qu'il n'écrit pas de règle. |
| Outil interne | FounderOS exécute l'appel : une règle qui s'applique **impose** l'approbation, même en autopilote. Sans règle : rien ne change. |
| Copie | La demande garde une copie de sa règle (approbateurs, quorum, échéance, nom). Modifier ou supprimer la règle ne change pas une demande en cours, et la base refuse toute modification de cette copie. |
| Votes | Une voix par approbateur (`internal_agent_approval_votes`), une seule par identité IdP même avec deux comptes. La base refuse le passage à « approuvée » tant que le quorum n'est pas atteint, et toute voix de la personne au nom de qui l'agent agit, sous son compte comme sous son identité IdP. Un approbateur qui refuse rejette la demande ; le demandeur peut la retirer. |
| Jeton d'approbation (MCP) | Il porte tous les approbateurs (`approvers`). Le serveur MCP vérifie qu'aucun n'est le demandeur, et peut exiger son **propre** quorum par cluster (`approval_quorum` du catalogue) : une règle FounderOS mal réglée ne descend pas sous ce que le cluster exige. |
| Groupes | Les groupes de l'IdP comptent : claim `groups` des jetons délégués, et groupes du SSO de l'interface, relevés à chaque connexion dans `user_idp_roles`. Ils servent à voir les demandes (RLS) et à décider (relus dans un jeton frais pour l'échange de jeton). |
| Écran | « Approbations PRD » devient « Approbations » : filtre par environnement, demandes des outils internes, règle appliquée, votes (1/2) et qui a voté. |

| Jeton pour un outil interne | Facultatif, par outil : « Jeton d'approbation envoyé à l'outil (audience) » dans sa politique. Chaque appel approuvé porte alors `X-Approval-Token`, signé par FounderOS (même clé et même JWKS que pour MCP) seulement si la demande est bien approuvée, relue en base. Revendications : `sub` (la personne), `jti` (la demande), `approver`, `approvers`, `connector`, `operation`, et la requête exacte (`method`, `path`, `body_sha256` ; `query` pour information). Par le relais, il voyage chiffré comme le jeton d'identité. |

### G4 : réglages et diagnostic de l'installation

- **But :** un administrateur voit et vérifie tout ce qui était en variables d'environnement.
- **Contenu :**
  - une table `installation_settings`, sans secret : passerelle LLM et alias, hôtes internes, webhook des approbateurs, émetteur des approbations ;
  - les secrets restent dans l'environnement ou Vault, et l'écran indique seulement s'ils sont présents ;
  - une page **Administration → Installation** qui teste chaque brique : LLM (un appel court), IdP (découverte OIDC), clé d'approbation (JWKS servi), relais (dernier contact), serveurs MCP (`tools/list`), métriques ;
  - l'environnement reste prioritaire : une installation pilotée par GitOps garde la main.
- **Acceptation :** une installation neuve se règle sans éditer un seul fichier, et chaque brique en panne est nommée avec sa cause.

#### Livré (11/10/2026)

Construit pour le backend Express (dossier `backend/`), qui sert les installations :

| Point | Ce qui est en place |
| --- | --- |
| Réglages | `installation_settings` (0283) et la page Administration → Installation. Catalogue fermé : passerelle LLM (LiteLLM ou Azure, alias, déploiements, hôtes permis), hôtes MCP internes, OPA, adresse publique, émetteur des jetons signés, résolveur DNS du SSO. |
| Priorité | Une variable d'environnement verrouille le réglage (affiché « environnement », non modifiable). Sinon le réglage d'installation, sinon le défaut. Le backend sert ces réglages par `Deno.env.get` de sa couche de compatibilité : le code porté des ~90 fonctions n'a pas changé. Appliqués aussitôt par le backend qui enregistre, en moins d'une minute par les autres réplicas. |
| Secrets | Jamais en base : l'écran dit seulement s'ils sont présents (et si la clé de chiffrement n'a pas la bonne forme). |
| Traçabilité | Chaque changement : qui, quand, avant, après (`installation_settings_history`). |
| Diagnostic | Base et migrations, chiffrement, clé de signature et JWKS public, passerelle LLM (un appel court), IdP (découverte OIDC, métadonnées SAML), garde SSO, relais (dernier contact), serveurs MCP (`tools/list` par `mcp-gateway`), port de métriques, OPA. Chaque panne : sa cause et ce qu'il faut faire. |
| Qui administre | `INSTALLATION_ADMINS`, ou les owners et admins de l'organisation propriétaire. Instance neuve : l'owner de la seule organisation la revendique à l'écran, sans fichier à éditer. Sur le cloud partagé (plusieurs organisations), personne ne revendique : l'exploitant renseigne `INSTALLATION_ADMINS`. |

Sur une instance Supabase hébergée sans le backend, la page le dit : les réglages restent les secrets des fonctions.

### G5 : installateur

- **But :** installer FounderOS en une commande.
- **Contenu :**
  - un chart Helm parapluie, `deploy/helm/founderos` :
    - backend, interface, migrations (Job) ;
    - Supabase (chart amont ou services fournis) ;
    - en option : OPA, LiteLLM, relais, serveurs MCP ;
  - un `docker-compose` pour une machine virtuelle unique : petites équipes, essai ;
  - un fichier `founderos.yaml` : domaine, IdP, passerelle LLM, secrets (Vault ou générés), stockage ;
  - un script le transforme en valeurs Helm ou en `.env` ;
  - premier démarrage : création du premier administrateur, puis assistant SSO ;
  - la doc OpenShift de SCIC devient **un profil** parmi d'autres (Kubernetes, OpenShift, VM).
- **Acceptation :** depuis une machine vierge, `helm install`, puis connexion SSO et premier agent, en moins d'une heure.

#### Livré (11/10/2026)

Le guide est [docs/install](install/README.md).

| Point | Ce qui est en place |
| --- | --- |
| `founderos.yaml` et installateur | `deploy/installer` : un fichier commenté et trois profils (Kubernetes, OpenShift SCIC, VM). Le script en tire les valeurs Helm, les Secrets générés ou des ExternalSecret (Vault), le `.env` du compose, et les clés d'un Supabase auto-hébergé. Les secrets générés sont gardés d'une exécution à l'autre ; `--rotate` les renouvelle. Toutes les erreurs du fichier sont dites d'un coup. |
| Chart parapluie | `deploy/helm/founderos` : backend, interface, Job des migrations, Ingress (Kubernetes) ou Routes (OpenShift), ServiceMonitor. Supabase est fourni ; les serveurs MCP, le relais, LiteLLM et OPA gardent leurs charts, chacun là où il doit tourner. |
| Migrations | `deploy/migrations` : le registre de la CLI Supabase, chaque migration dans sa transaction, un verrou, une baseline pour une base migrée à la main. |
| Interface | Une seule image publiée pour toutes les installations : les adresses se donnent au démarrage (`/config.js`, politique de contenu). Avant, il fallait une image par environnement. |
| Machine virtuelle | `deploy/compose` : migrations, backend, interface et Caddy (HTTPS automatique) à côté du compose officiel de Supabase. |
| Premier démarrage | `/setup` : compte administrateur, installation rattachée, diagnostic, SSO, premier agent, cochés en direct. |
| SCIC | Un profil parmi les autres (`openshift-scic.yaml`). La doc OpenShift garde le détail propre à SCIC. |

L'acceptation complète (`helm install` sur un cluster vierge, en moins d'une heure) reste à jouer sur un vrai cluster. Ici, le chart passe `helm lint` et `helm template` avec les valeurs générées pour chaque profil.

### G6 : provisioning SCIM

- **But :** les comptes suivent l'annuaire.
- **Contenu :**
  - un endpoint SCIM 2.0 (`/scim/v2/Users`, `/Groups`), avec un jeton par IdP ;
  - à la désactivation d'un compte : accès retiré, jetons délégués révoqués (G1), demandes d'approbation en attente annulées ;
  - les groupes SCIM alimentent les correspondances groupe → rôle (0272) et les approbateurs (G3).
- **Acceptation :** désactiver une personne dans Entra ou Okta coupe ses accès FounderOS et ceux de ses agents en moins de 5 minutes.

#### Décision du 11/10/2026 : une version allégée d'abord

Le SSO règle qui se connecte, et son rôle à la connexion. Les jetons d'API règlent comment FounderOS parle aux serveurs MCP. SCIM règle ce qui se passe **sans** connexion : arrivées, départs, changements de groupe. Trois trous restaient sans lui ; la version allégée les couvre presque entièrement :

| Trou | Version allégée (livrée) |
| --- | --- |
| Une personne désactivée dans l'IdP garde sa session FounderOS (Supabase la rafraîchit sans fin) | **Sessions bornées** dans l'Auth : 24 h au plus, 8 h sans activité (`[auth.sessions]`, `GOTRUE_SESSIONS_*`, option `sessions` de l'installateur). |
| Un membre retiré garde ses demandes, ses jetons délégués, ses groupes relevés | **Départ** (0284), qu'il vienne d'un admin ou du SSO : demandes en attente retirées, jetons IdP des agents et groupes relevés de l'organisation effacés, sessions fermées s'il n'appartient plus à aucune organisation ; journalisé et visible (Authentification → Départs). |
| Les groupes d'un approbateur datent de sa dernière connexion | **Connexion SSO récente** exigible par règle d'approbation pour voter ; et une voix d'un membre parti ne compte plus au quorum. L'échange de jeton relit déjà l'IdP à chaque appel. |

Le SCIM complet (comptes créés avant la première connexion, départ en moins de 5 minutes, groupes poussés par l'annuaire) devient utile pour un client avec beaucoup d'utilisateurs et de mouvements, ou qui l'exige dans un audit ou un appel d'offres. Il reste le contenu ci-dessus.

### G7 : passerelle d'entreprise

- **But :** en mode cloud, un seul composant installé chez le client.
- **Contenu :**
  - le relais (`connector-relay/`) et les serveurs MCP (`MCP/`) sont livrés ensemble : une image, un chart ;
  - le relais devient le seul chemin sortant, et les serveurs MCP ne sont joignables que par lui ;
  - les secrets restent chez le client : Vault, Secret Kubernetes ou fichier ;
  - la liste blanche du relais reste l'autorité finale.
- **Acceptation :** depuis le cloud, un agent diagnostique un déploiement Kubernetes du client sans qu'aucun port ne soit ouvert chez lui.

#### Livré (12/10/2026)

Le guide est dans [docs/install](install/README.md#mode-cloud--la-passerelle-dentreprise).

| Point | Ce qui est en place |
| --- | --- |
| Une image | `deploy/gateway/Dockerfile` : le relais, les serveurs MCP compilés, la politique OPA et le catalogue de cette version. UBI Node 22, utilisateur 1001, système de fichiers en lecture seule. `WITH_K8S_TOOLS=true` ajoute helm et kubectl pour les commandes du relais. |
| Un chart | `deploy/helm/founderos-gateway`. Un pod, deux conteneurs de la même image : le relais et le serveur MCP. Ils partagent la boucle locale du pod ; chacun ne monte que ses propres secrets : le jeton du relais d'un côté, Vault et les jetons d'API de l'autre. OPA tourne en sidecar, avec la politique livrée dans l'image ou celle du dépôt de politiques. |
| Aucun port entrant | Le serveur MCP n'écoute que sur 127.0.0.1. Aucun Service ni Route ne le publie. La NetworkPolicy refuse toute entrée, sauf la supervision vers `/metrics`, et ne laisse sortir que le DNS, le HTTPS vers FounderOS et les plages déclarées. |
| Le relais, seul chemin | La liste blanche du relais reçoit d'office `127.0.0.1:<port MCP>`, et rien d'autre de local. Un autre port de la machine est refusé, chez le client. |
| Les secrets chez le client | Vault, avec un jeton de compte de service d'audience Vault et de courte durée, ou des identifiants locaux : le jeton du compte de service, borné par `rbac`, ou un Secret. Le jeton d'API du serveur MCP ne passe dans la file du relais que scellé. |
| Sans Kubernetes | `deploy/gateway/docker-compose.yml` : un conteneur, et le lanceur `gateway.mjs` démarre les deux processus. Chacun ne reçoit que ses variables. Si l'un s'arrête, la passerelle s'arrête. |
| FounderOS | Un serveur MCP joint par un relais peut être en http sur la boucle locale, `http://127.0.0.1:8443/mcp` ; en direct, cette adresse reste refusée. Le formulaire des serveurs MCP l'indique. |

**Acceptation, jouée en test** (`backend/src/shared/enterprise-gateway.e2e.test.ts`). Le vrai lanceur démarre le vrai relais et le vrai serveur MCP, avec un jeton d'API. Le client MCP de FounderOS passe par la file du relais, sur le protocole `relay.claim` / `relay.complete`, et `pods_list` répond depuis un faux Kubernetes. Le test vérifie aussi :

- le jeton n'apparaît jamais en clair dans la file ;
- un jeton faux est refusé ;
- le relais refuse tout autre port local ;
- le port MCP ne répond pas sur l'adresse réseau de la machine ;
- un serveur MCP qui tombe arrête la passerelle.

Le chart passe `helm lint` et `helm template` en relais seul et en configuration complète (Vault, OPA, approbations). Il reste à l'installer sur un vrai cluster client.

---

## 7. Ordre recommandé

1. **G1 puis G2 :** la gestion d'authentification que demandent toutes les entreprises, et la base de tout le reste.
2. **G3 :** les approbations, dès que les connexions sont unifiées.
3. **G4 puis G5 :** ce qui rend l'installation autonome.
4. **G6 et G7,** selon les premiers clients : SCIM pour les grands comptes, la passerelle pour le mode cloud.

## 8. Questions à trancher

- **IdP à couvrir en premier,** en plus de Keycloak : Entra ID (OBO), Okta (échange de jeton) ?
- **Mode d'identité par défaut** d'une nouvelle connexion : compte de service (le plus simple) ou contexte signé (traçable sans dépendre de l'IdP) ?
- **Supabase dans l'installateur :** l'embarquer (chart amont), ou exiger une instance fournie par le client ?
- **Priorité commerciale :** installé chez le client, cloud connecté, ou les deux d'emblée ?
