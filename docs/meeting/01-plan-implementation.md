# Réunions : des agents qui participent comme des collègues

Un agent sur lequel la fonction **Réunions** est activée peut rejoindre une réunion Microsoft Teams, Google Meet ou Zoom, écouter, parler, écrire dans le chat de la réunion, donner son avis et agir avec ses outils habituels. Il vit aussi dans les canaux de discussion (Slack, Teams, Google Chat) comme un membre de l'équipe, pas seulement comme un bot qu'on mentionne.

## 1. Ce que l'agent sait faire

| Moment | Comportement |
|---|---|
| Avant | Il est invité par un lien collé dans l'app, par une demande dans un canal (« @Léa, rejoins la réunion de 14 h »), plus tard par son agenda. 10 minutes avant, il prépare : ordre du jour, documents liés, compte rendu précédent, tâches ouvertes |
| En entrant | Il s'annonce à voix haute et dans le chat : nom, nature (agent IA), rôle, comment le solliciter, comment l'arrêter |
| Pendant | Il écoute (transcription avec le nom des intervenants), répond quand on l'interpelle, donne son avis au tour de table, corrige un fait, met les détails (liens, chiffres, listes) dans le chat, lance des recherches en fond et revient avec le résultat |
| Après | Compte rendu (décisions, actions avec responsables, questions ouvertes) dans l'app et dans le canal lié ; actions proposées dans le suivi de travail ; transcription indexée pour la recherche ; ce qu'il a appris va dans sa mémoire |
| Dans les canaux | Il suit les fils où il est membre, intervient quand c'est utile même sans mention, publie les comptes rendus, peut être envoyé en réunion depuis le canal |

Hors v1 : avatar vidéo, partage d'écran, salles de sous-groupes, huddles Slack (voir 3.1), plusieurs agents FounderOS qui parlent dans la même réunion.

## 2. Ce qui existe déjà

| Existant | Où | Ce qu'on en fait |
|---|---|---|
| Canaux Slack, Teams, Telegram, Discord, WhatsApp | `supabase/functions/slack-gateway`, `teams-gateway`, `messaging-gateway` ; table `internal_agent_channels` (0100, 0252) ; `AgentChannelsTab.tsx` | Base des canaux « collègue » : on ajoute un mode d'écoute ambiante et Google Chat |
| Un tour, un seul principal | `_shared/turn-principal.ts` | Même règle en réunion : la personne qui a invité l'agent est le principal ; les autres voix sont des données |
| Approbations depuis un canal | `_shared/channel-approval.ts` | Une action d'écriture demandée en réunion part en approbation chez le principal |
| Pont vocal Twilio ⇄ Deepgram STT/TTS | `runner/src/voice.js` | Modèle du pipeline voix (STT en flux, TTS Aura), clé `DEEPGRAM_API_KEY` déjà configurée |
| Proxy STT temps réel en Node | `backend/src/ws/deepgram-stream.ts` | Modèle pour brancher un WebSocket média sur le serveur du backend |
| Harnais OpenCode | `backend/src/harness/chat.ts` (`startChatTurn`) | Le travail « en fond » pendant la réunion : outils, recherche, mémoire |
| Caractère et préférences | `soul` / `preferences` (0210) | Manière de parler en réunion ; on y ajoute la voix |
| Niveau d'autonomie | `autonomy_level` (0266) | Borne ce que l'agent peut faire seul pendant la réunion |
| Routes de modèles par agent | 0303 | Nouvelle route `@voice` pour le modèle rapide |
| Machines Docker à la demande | `backend/src/platform/machine-provisioner.ts` (0311) | Lancer un conteneur de bot par réunion en auto-hébergé |
| Registre d'appels, consommation | 0299, `llm_usage` | Compter les minutes de bot, de STT et de TTS |
| Calendrier | `connector-actions.ts` (google-calendar), Composio googlecalendar / outlook | Invitations automatiques (phase M5) |

## 3. Les choix techniques

### 3.1 Entrer dans la réunion

Aucune plateforme n'offre une API simple pour qu'un bot parle en réunion :

| Plateforme | Voie officielle | Réalité |
|---|---|---|
| Teams | Real-time Media Platform (bot .NET sur Windows Server). L'interop Azure Communication Services n'expose pas l'audio brut | Les bots du marché rejoignent en invité via un navigateur, avec salle d'attente selon la politique du tenant |
| Google Meet | Meet Media API : préversion, réception seulement, arrêt annoncé | Chrome sans interface qui rejoint en invité (ou compte Google dédié) |
| Zoom | Meeting SDK Linux (audio brut entrant et sortant). RTMS : réception seulement | App « General App » avec Meeting SDK ; une publication Marketplace peut être exigée pour les réunions hors de son compte (à vérifier) |
| Slack huddles | Aucune API | Seulement un compte utilisateur dans Chrome, fragile |

On n'écrit donc pas quatre intégrations natives. On passe par un **service de bots de réunion**, derrière une interface `MeetingTransport` pour pouvoir en changer.

| Option | Plateformes | Parler | Chat | Hébergement | Verdict |
|---|---|---|---|---|---|
| **Attendee** (open source) | Zoom, Meet, Teams, Webex | Oui (« bots can speak arbitrary audio », audio entrant et sortant) | Lecture et envoi | Une image Docker Django + Postgres + Redis, ou version hébergée avec la même API | **Par défaut** : cohérent avec PLATFORM=self et la piste sur site, les données restent chez nous |
| **Recall.ai** (SaaS) | Zoom, Meet, Teams, Webex | Oui : le bot charge une page web dont l'audio devient son micro (16 kHz mono) | Envoi (Meet limité à 500 caractères, Teams hors réunions de canal) et lecture | Régions US, UE (Francfort), JP. 0,50 $ par heure de bot | **En option** : démarrage le plus rapide, moins d'exploitation |
| Vexa (Apache-2.0) | Meet, Teams, Zoom | Prouvé côté bot, pas exposé par l'API (0.12) | Lecture seulement | Auto-hébergé | Pas maintenant |
| Appel téléphonique | Toute réunion avec un numéro d'accès | Oui, via le pont Twilio existant | Non | Déjà là | Repli : pas de noms d'intervenants, 8 kHz, pas de chat |
| Natif par plateforme | Une à la fois | Oui | Oui | Lourd (.NET Windows pour Teams) | Non |

Point d'attention Attendee : le lancement par défaut (Celery) n'est pas fait pour la production (bots tués au redémarrage, périphériques audio partagés) et le lanceur Kubernetes officiel relève d'une offre payante. On écrira notre lanceur : **un conteneur par bot**, avec le provisionneur de machines (0311) en local et un Job Kubernetes sur OpenShift (`docs/openshift-implementation.md`). La licence d'Attendee est à lire avant toute distribution sur site.

L'interface normalise ce que le reste du code voit :

```ts
interface MeetingTransport {
  join(input: { url: string; botName: string; meetingId: string }): Promise<{ botId: string }>;
  leave(botId: string): Promise<void>;
  sendChat(botId: string, text: string, to?: "everyone" | string): Promise<void>;
  // Entrant, par webhook signé ou WebSocket, converti en événements communs :
  // state (joining, waiting_room, in_call, ended, failed), participant (join, leave),
  // utterance (orateur, texte, partiel ou final), speech (début, fin), chat (auteur, texte)
  // Média : audio PCM16 16 kHz entrant et sortant sur un WebSocket du backend
}
```

### 3.2 Le cerveau en réunion : deux vitesses

En vocal, il faut commencer à répondre **moins de 2 secondes** après la fin de la question. Un tour du harnais OpenCode (session, outils, modèles gratuits OpenRouter avec quotas) en prend beaucoup plus. D'où deux étages :

| Étage | Rôle | Modèle | Contexte |
|---|---|---|---|
| **Réflexe** | Décider à chaque fin d'énoncé : parler, écrire dans le chat, se taire, déléguer. Formuler une réponse courte | Modèle rapide payant, en flux (route `@voice`) | Caractère, préférences, ordre du jour, résumé courant, 3 à 5 dernières minutes de transcription, faits prêts |
| **Fond** | Travail qui prend du temps : chercher dans la base, lire un document, interroger le suivi, préparer un chiffre | Harnais OpenCode habituel | Une conversation interne liée à la réunion ; `startChatTurn` |
| **Notes** | Mettre à jour le résumé, les décisions et les actions toutes les 60 secondes environ | Modèle léger | Transcription depuis la dernière mise à jour |

Déroulé d'une délégation : le réflexe répond tout de suite « je regarde » ; il écrit la demande dans la conversation de la réunion et lance un tour du harnais ; à la fin du run, le résultat devient un **fait prêt** ; le réflexe le dit à la prochaine ouverture ou le met dans le chat si la discussion est passée à autre chose.

Pipeline voix en cascade (STT → modèle → TTS), parce que Deepgram est déjà intégré et que les outils, la mémoire et la gouvernance restent dans FounderOS. Les modèles parole-à-parole (temps réel) restent possibles plus tard derrière la même interface `VoiceEngine`.

| Étape | Cible |
|---|---|
| Détection de fin d'énoncé | 300 à 600 ms |
| Transcription finale | 100 à 300 ms |
| Premiers mots du réflexe (en flux) | 400 à 800 ms |
| Premier morceau de TTS (en flux) | 150 à 300 ms |
| Retour dans la réunion | 100 à 300 ms |
| **Total** | **1,2 à 2 s** (à mesurer en M0) |

Fournisseurs derrière une interface : STT Deepgram (présent), TTS Deepgram Aura (présent) ou ElevenLabs ou Azure Speech selon la qualité en français ; en sur site, Whisper et un TTS local en dégradé.

### 3.3 Quand parler : la politique de parole

C'est ce qui fait la différence entre un collègue et un bot bavard.

| Mode | Comportement | Usage |
|---|---|---|
| `observer` | Écoute et prend des notes ; ne parle jamais ; répond dans le chat seulement si on l'y interpelle | Réunions sensibles, premiers essais |
| `on_demand` (**par défaut**) | Parle quand on l'interpelle par son nom ou qu'on lui pose une question directe | Cas général |
| `participant` | Peut aussi intervenir de lui-même : fait erroné, question restée sans réponse, tour de table | Équipes habituées à l'agent |

Règles communes :
- **Interpellation** : son nom et ses alias, avec tolérance phonétique (« Léa », « Lea », « l'agent »), questions adressées (« qu'en penses-tu, Léa ? »), tour de table.
- **Ne jamais couper la parole** : il parle seulement après la fin d'énoncé ; si quelqu'un parle pendant qu'il parle, la synthèse s'arrête aussitôt et le reste est abandonné.
- **Pas d'écho** : ses propres paroles sont exclues de la transcription (orateur = le bot, ou STT suspendu pendant qu'il parle si l'audio est mixé).
- **Budgets** : 20 secondes par intervention ; au plus 2 interventions spontanées par tranche de 10 minutes ; pause après chaque intervention spontanée.
- **Spontané d'abord discret** : en mode `participant`, il commence par un message dans le chat (« j'ai un chiffre sur ce point, je peux ? ») avant de prendre la parole.
- **Le long va dans le chat** : listes, liens, chiffres détaillés ; à l'oral, il résume et renvoie au chat.
- Chaque décision (parlé, écrit, tu, délégué, interrompu) est tracée avec sa raison et sa latence, pour régler la politique sur des faits.

### 3.4 Sécurité, confidentialité, droit

- **Principal** : la personne qui a invité l'agent (sinon son propriétaire). Une action d'écriture demandée par une autre voix part en approbation chez le principal, dans l'app. **Une voix qui dit « vas-y » n'est jamais une preuve d'identité.**
- **Transcription = données, pas consignes** : tout ce qui est dit ou écrit en réunion est encadré comme contenu non fiable dans le prompt (injection par la parole ou le chat).
- **Participants externes** : si la réunion compte des personnes hors de l'organisation (domaine de l'invitation, tenant, noms inconnus), l'agent passe en confidentialité restreinte : seulement les collections marquées publiables de ses pools, aucune donnée client ni chiffre interne sans approbation.
- **Transparence** : annonce à l'entrée (agent IA, prise de notes, comment l'arrêter), nom affiché « Léa (IA) », lien vers une notice dans le chat. Répond aux obligations d'information du RGPD et de transparence de l'AI Act (art. 50).
- **Arrêt** : « Léa, arrête » ou « Léa, sors » à voix haute ; l'hôte peut l'exclure ; le propriétaire peut couper son micro ou le retirer depuis l'app.
- **Conservation** : l'audio n'est pas gardé par défaut, seulement la transcription, avec une durée réglable ; les données sont supprimées chez le transporteur après la réunion.
- **Secrets** : clés du transporteur et des fournisseurs voix côté serveur seulement (même principe que `internal_agent_channel_tokens`), webhooks signés (HMAC) et vérifiés avant lecture.

### 3.5 Les canaux de discussion en collègue

Ce qui manque à l'existant pour passer de « bot qu'on mentionne » à « membre de l'équipe » :

| Manque | Solution |
|---|---|
| `trigger` vaut `mention` ou `all` : `all` répond à tout | Nouveau `ambient` : il lit tout, décide s'il doit répondre (même politique que 3.3, en texte), avec un budget par fil et par jour |
| Un seul nom de bot pour tous les agents | Slack : portée `chat:write.customize` pour publier avec le nom et l'avatar de l'agent depuis une seule app. Teams : nom de l'agent dans la carte du message en v1 |
| Pas de Google Chat | Fournisseur `googlechat` dans `messaging-gateway` (Supabase plafonne à 100 fonctions et celle-ci est la centième) |
| Canal et réunion sans lien | Une réunion peut être liée à un canal : question préparatoire avant, compte rendu après, « @Léa rejoins » depuis le fil |

### 3.6 Où ça tourne

Dans le **backend Node seulement** (PLATFORM=self), dans un nouveau module `backend/src/meeting/`, pas dans les fonctions edge :
- les fonctions edge ne tiennent pas de WebSocket audio de longue durée ;
- le plafond de 100 fonctions Supabase est atteint ;
- c'est la direction prise avec la migration OpenCode (mode local principal).

En mode cloud, la fonction s'affiche « indisponible », comme la création de machines.

## 4. Architecture

```
Teams / Meet / Zoom
        │  bot Chrome (Attendee auto-hébergé, ou Recall)
        ▼
MeetingTransport ── état, participants, énoncés, chat (webhooks signés)
        │  audio PCM 16 kHz ⇅ (WebSocket du backend)
        ▼
backend/src/meeting/
  session.ts      une réunion = une session : état, participants, transcription glissante
  transport/      attendee.ts, recall.ts (puis phone.ts sur le pont Twilio)
  voice/          stt.ts, tts.ts, détection de parole, interruption
  floor.ts        politique de parole (3.3)
  reflex.ts       modèle rapide : dire, écrire, se taire, déléguer
  background.ts   délégation au harnais OpenCode, faits prêts
  notes.ts        résumé courant, décisions, actions, compte rendu
  routes.ts       API de l'app, webhooks, WebSocket média
        │
        ▼
PostgreSQL (tables 4.1) ── realtime ──► app : onglet Réunions, vue en direct, compte rendu
```

Lancement des bots Attendee : en local, un conteneur par réunion via le provisionneur de machines ; le serveur Attendee tourne à côté du backend dans le même réseau Docker (pas besoin de ngrok). Avec Recall, le backend doit être joignable depuis Internet (ngrok en local, comme la machine d'équipe).

### 4.1 Base de données (migration 0313)

| Table / colonne | Contenu |
|---|---|
| `internal_agents.meeting_enabled` | Booléen, faux par défaut |
| `internal_agents.meeting_settings` | jsonb : voix (fournisseur, identifiant), langue, mode de parole, budgets, texte d'annonce, alias, plateformes autorisées, conservation |
| `agent_meetings` | agent, espace, projet, plateforme, lien, titre, date prévue, invité par, principal, canal lié, transporteur, identifiant du bot, état, mode de parole, confidentialité, début, fin, résumé, erreur, minutes et consommation |
| `agent_meeting_participants` | nom affiché, référence externe, hôte, interne ou externe, utilisateur FounderOS rapproché, arrivée, départ |
| `agent_meeting_utterances` | orateur, texte, parole ou chat, par l'agent ou non, horodatage |
| `agent_meeting_events` | trace des décisions : parlé, écrit, tu, délégué, fait prêt, interrompu, approbation ; raison et latence |
| `agent_meeting_outputs` | décisions, actions (avec lien vers l'élément du suivi), questions ouvertes |
| `internal_agent_channels` | `trigger` accepte `ambient`, `provider` accepte `googlechat` |
| `search_index` (0308) | nouveau type `meeting`, portée = projet et participants |

RLS sur le modèle `has_internal_agent_access(agent_id)`. Les clés du transporteur sont des variables d'installation (`ATTENDEE_URL`, `ATTENDEE_API_KEY`, `RECALL_REGION`, `RECALL_API_KEY`) ajoutées à `backend/.env.self.example` et à `deploy/installer/config.mjs`.

### 4.2 Dans l'interface

- **Réglages de l'agent** : interrupteur Réunions ; voix avec bouton « écouter » ; langue ; mode de parole ; budgets ; texte d'annonce.
- **Onglet Réunions de l'agent** (gabarit `PageHeader`) : à venir et passées, bouton « Envoyer en réunion » (lien, maintenant ou à une heure).
- **Vue en direct** : transcription qui défile, ce que l'agent décide et pourquoi (« silence : pas interpellé »), boutons Couper le micro, Souffler une consigne, Retirer.
- **Compte rendu** : résumé, décisions, actions avec « Créer dans le suivi », transcription consultable.
- Accueil : réunion commencée ou terminée, approbations en attente. Live Space : l'agent va en salle de réunion (optionnel).

## 5. Les phases

### M0 : preuve de concept (4 à 5 jours)
Attendee auto-hébergé en Docker et compte d'essai Recall. Pour Teams, Meet et Zoom : rejoindre (y compris salle d'attente), transcription avec noms, faire dire une phrase, envoyer un message dans le chat. Mesurer : temps d'entrée, latence de transcription, latence fin de question → premier son avec Deepgram et un modèle rapide ; test d'écoute des voix françaises (Aura, ElevenLabs, Azure Speech). **Sortie : choix du transporteur, du TTS et du modèle réflexe.**

### M1 : présence silencieuse (1,5 semaine)
Migration 0313, module `backend/src/meeting/`, interface `MeetingTransport` et premier adaptateur, webhooks signés, sessions, envoi par lien, vue en direct, notes et compte rendu, compteur de coûts. L'agent est en mode `observer` seulement. Déjà utile : un preneur de notes qui connaît le contexte de l'équipe.

### M2 : le chat (1 semaine)
Lecture du chat de réunion, réponse quand on l'y interpelle, liens et chiffres ; délégation au harnais et faits prêts ; principal et approbations ; confidentialité avec externes.

### M3 : la voix (2 semaines)
Pipeline en flux STT → réflexe → TTS, politique `on_demand`, interruption, budget de latence, annonce d'entrée, réglages de voix. Mode `participant` derrière un drapeau.

### M4 : les canaux en collègue (1 à 1,5 semaine)
Déclencheur `ambient`, identité par agent sur Slack, Google Chat, réunion liée à un canal (avant, après, « rejoins »).

### M5 : agenda et préparation (1 semaine)
Synchronisation Google Agenda et Outlook, règles d'entrée automatique, préparation 10 minutes avant, actions de fin de réunion dans le suivi.

### M6 : durcissement (1 semaine)
Conservation et suppression, arrêt d'urgence, quotas et plafonds de coût par espace, évaluations dans `npm run eval` (doit se taire, doit répondre, injection par la parole, fuite vers un externe), plusieurs bots en parallèle, documentation `docs/meeting.md`, installeur.

**Total : 8 à 9 semaines.** Plus tard : huddles Slack, appel téléphonique de repli, avatar vidéo et partage d'écran, plusieurs agents dans la même réunion (un seul parle à la fois), modèles parole-à-parole.

## 6. Risques

| Risque | Parade |
|---|---|
| Les bots navigateur cassent quand Teams ou Meet change son interface | Projet maintenu (Attendee) ou SaaS (Recall), alerte sur les échecs d'entrée, repli téléphonique |
| Salle d'attente, accès invité désactivé par le tenant | État `waiting_room` visible, notification au propriétaire, consigne d'admission dans l'invitation |
| Zoom peut exiger une app publiée sur le Marketplace | À vérifier en M0 avant de promettre Zoom pour les réunions externes |
| Latence trop haute | Modèle réflexe payant et rapide, tout en flux, contexte court ; les modèles gratuits OpenRouter sont exclus pour la voix |
| L'agent parle trop ou mal à propos | `on_demand` par défaut, budgets, trace des décisions, évaluations |
| Fuite d'information vers un externe | Confidentialité restreinte automatique, approbation du principal |
| Cadre légal (enregistrement, information, IA) | Annonce, notice, audio non conservé, durée réglable, arrêt à la voix |
| Coût par heure (bot, STT, TTS, modèle) | Compteur par réunion, plafonds par espace, arrêt quand la réunion se vide |
| Lanceur Attendee de production payant | Notre lanceur : un conteneur par bot (provisionneur 0311, Job OpenShift) |
| M0 et les tests demandent des opérations Docker | À lancer seulement avec ton accord explicite |

## 7. Décisions à prendre

1. **Transporteur** : Attendee auto-hébergé par défaut et Recall en option (recommandé), ou Recall seul, ou Attendee seul.
2. **Voix** : garder Deepgram Aura ou passer à ElevenLabs ou Azure Speech, après le test d'écoute en M0.
3. **Modèle réflexe** : quel modèle rapide payant et quel budget par heure de réunion.
4. **Mode de parole par défaut** : `on_demand` (recommandé).
5. **Audio** : jamais conservé (recommandé) ou conservé N jours.
6. **Plateformes v1** : Teams, Meet et Zoom ; huddles Slack hors v1 (recommandé).
7. **Identité** : nom affiché « Prénom (IA) » ; une adresse e-mail par agent pour les invitations d'agenda, ou passage par l'agenda du propriétaire.
8. **Portée** : mode local seulement, comme le harnais OpenCode (recommandé).
