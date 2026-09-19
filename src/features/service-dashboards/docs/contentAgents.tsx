import { RobotIcon } from "@phosphor-icons/react";
import { Callout, Figure, Key, ProofFigure, Shot, Step, Steps, Ui } from "./figures";
import { Defs, H, LI, Lede, P, UL } from "./prose";
import type { DocSection } from "./types";

export const AGENTS_SECTION: DocSection = {
  key: "agents",
  label: "Les agents",
  icon: RobotIcon,
  articles: [
    {
      slug: "agents",
      title: "Les agents du service",
      summary: "Créer, configurer et suivre les agents qui travaillent dans ce tableau.",
      keywords: ["agents", "ia", "créer un agent", "roster", "workforce"],
      body: () => (
        <>
          <Lede>
            Un agent est un collaborateur artificiel rattaché au service. Il a un
            nom, un portrait, des instructions, des outils, une mémoire — et il
            apparaît dans le produit partout où une personne apparaît.
          </Lede>

          <H>Créer un agent</H>
          <Steps>
            <Step>Depuis l'onglet <Ui>Agents</Ui>, le bouton de création.</Step>
            <Step>Partez d'un <strong>modèle</strong> si l'un d'eux correspond, sinon décrivez le rôle en une phrase : la configuration est générée puis reste modifiable.</Step>
            <Step>Réglez ses <strong>outils</strong> : c'est ce qu'il a le droit de faire, et rien de plus.</Step>
            <Step>Attachez-lui des <strong>connaissances</strong> si son travail suppose de connaître vos documents.</Step>
          </Steps>

          <H>Les trois fichiers d'un agent</H>
          <Defs
            rows={[
              [<>Instructions</>, <>Ce qu'il doit faire, et comment. La partie qu'on modifie le plus souvent.</>],
              [<>Âme</>, <>Qui il est : son ton, ses partis pris, ce qu'il refuse. Elle change rarement.</>],
              [<>Préférences</>, <>Les habitudes apprises au fil des missions — les formats attendus, les pièges rencontrés.</>],
            ]}
          />

          <P>
            Le contexte réellement envoyé à chaque tâche est <strong>assemblé</strong> à
            partir de ces trois fichiers, des compétences pertinentes et des
            préférences applicables — pas concaténé en bloc.
          </P>

          <Callout kind="tip">
            La configuration d'un agent passe aussi par <strong>l'assistant</strong>
            du produit, ouvert depuis le rail : lui décrire ce qu'on veut changer est
            souvent plus rapide que de parcourir les onglets.
          </Callout>
        </>
      ),
    },

    {
      slug: "crew",
      title: "Équipage d'un projet",
      summary: "Mettre des personnes et des agents sur un projet — et ce que cela autorise.",
      keywords: ["équipage", "membres", "crew", "rôles", "périmètre", "autorisation"],
      body: () => (
        <>
          <Lede>
            L'onglet <Ui>Équipage</Ui> d'un projet réunit ses deux familles de
            porteurs : les personnes et les agents. Même page, même vocabulaire —
            mais pas les mêmes conséquences.
          </Lede>

          <H>Les personnes : un rang</H>
          <Defs
            rows={[
              [<>Admin</>, <>Règle le projet, ses états et ses membres.</>],
              [<>Membre</>, <>Crée et fait avancer le travail.</>],
              [<>Invité</>, <>Consulte sans modifier.</>],
            ]}
          />
          <P>
            Ces rangs filtrent <strong>l'interface</strong>. La sécurité réelle
            s'appuie sur l'appartenance à l'espace de travail : ajouter quelqu'un à
            un projet ne lui ouvre rien qu'il n'ait déjà.
          </P>

          <H>Les agents : un droit d'agir</H>
          <Callout kind="warn" title="Cette liste est un périmètre d'écriture">
            Un agent <strong>absent</strong> de l'équipage ne peut rien modifier dans
            le projet, même si on lui assigne un work item. Une liste vide veut dire
            « aucun accès », jamais « tous ». C'est l'inverse du réflexe habituel, et
            c'est délibéré.
          </Callout>

          <UL>
            <LI><strong>Agit</strong> — il peut lire et écrire dans ce projet. Il reçoit du même coup l'outil de suivi de travail, borné à ce périmètre.</LI>
            <LI><strong>Observe</strong> — lecture seule. Il ne peut pas recevoir de mission.</LI>
            <LI>Le retirer de la liste lui retire l'accès <strong>aussitôt</strong> : le périmètre est relu à chaque appel d'outil, pas au démarrage.</LI>
          </UL>

          <P>
            Chaque ligne affiche la <strong>charge</strong> portée — items ouverts sur
            total — pour repérer d'un coup d'œil qui tient le projet et qui n'y est
            que de nom.
          </P>

          <Shot
            file="docs/equipage.png"
            alt="L'onglet Équipage d'un projet : la section Personnes avec leurs rangs, et la section Agents avec leurs droits."
          />
        </>
      ),
    },

    {
      slug: "missions",
      title: "Confier du travail à un agent",
      summary: "La différence entre assigner et missionner, et comment lancer une mission.",
      keywords: ["mission", "confier", "lancer", "run", "autonome", "brief"],
      body: () => (
        <>
          <Lede>
            Assigner un agent à un work item est une <strong>étiquette</strong> : cela
            dit à qui revient le sujet, cela ne déclenche rien. Une
            <strong> mission</strong> est exécutable — elle porte un brief, des
            critères d'acceptation, et elle démarre un run.
          </Lede>

          <H>Lancer une mission</H>
          <Steps>
            <Step>Ouvrez le work item et repérez le bloc <Ui>Missions</Ui>.</Step>
            <Step><Ui>Confier à un agent</Ui> ouvre le formulaire. Seuls les agents <strong>autorisés en écriture</strong> sur le projet y sont proposés.</Step>
            <Step>Le <strong>brief</strong> est pré-rempli avec la description de l'item ; complétez-le avec le contexte et les contraintes.</Step>
            <Step>Renseignez les <strong>critères d'acceptation</strong> : c'est à eux que le livrable sera comparé.</Step>
            <Step><Ui>Lancer</Ui>. L'agent démarre aussitôt ; l'écran ne se bloque pas.</Step>
          </Steps>

          <Callout kind="warn" title="Les critères d'acceptation ne sont pas une politesse">
            Sans eux, vous obtenez un résultat que vous ne pouvez que croire sur
            parole. Avec eux, le contrôle prend trente secondes : on rouvre la
            demande et on compare. C'est la seule chose qui sépare un rapport
            vérifiable d'un rapport arrivé de nulle part.
          </Callout>

          <H>Ce que l'agent reçoit</H>
          <P>
            Le work item lui est transmis avec sa référence, sa description, sa
            priorité et son échéance. Il peut relire son état avant de commencer,
            commenter sa progression, et changer son état une fois les critères
            remplis.
          </P>

          <H>Suivre la mission</H>
          <P>
            Le bloc <Ui>Missions</Ui> affiche l'état de la dernière tentative :
            <strong> en file</strong>, <strong>en cours</strong>,
            <strong> abouti</strong> ou <strong>échoué</strong>. Une mission relancée
            plusieurs fois se juge à son dernier essai.
          </P>
          <P>
            La liste se <strong>met à jour seule</strong> tant qu'un agent travaille :
            inutile de recharger la page pour voir passer « en file » à « abouti ».
            Ce que l'agent produit apparaît <strong>sous la mission</strong> qui l'a
            produit, et s'ouvre d'un clic — la demande et son résultat restent côte
            à côte.
          </P>
        </>
      ),
    },

    {
      slug: "autonomous-work",
      title: "Laisser un agent travailler seul",
      summary: "Le champ « Travail à faire », le démarrage automatique, et ce qui peut l'arrêter.",
      keywords: ["autonome", "autorun", "travail à faire", "brief", "planifié", "ordonnanceur", "disjoncteur"],
      body: () => (
        <>
          <Lede>
            Un agent assigné à un work item peut s'en saisir <strong>sans qu'on le
            lance</strong> : il lit ce qu'il y a à faire, passe l'item en cours,
            travaille, rend compte et le marque terminé. Il faut pour cela deux
            choses sur l'item — une consigne écrite pour lui, et l'autorisation de
            démarrer seul.
          </Lede>

          <H>Mettre un item en travail autonome</H>
          <Steps>
            <Step>Dans <Ui>Équipage</Ui>, autorisez l'agent <strong>en écriture</strong> sur le projet.</Step>
            <Step>Assignez-le au work item, depuis la fiche ou en lot avec la barre d'actions (menu <Ui>Agent</Ui>).</Step>
            <Step>Remplissez <Ui>Travail à faire</Ui> : ce que l'agent doit produire, et à quoi on reconnaîtra que c'est fait.</Step>
            <Step>Activez <Ui>Travail autonome</Ui>. L'interrupteur reste grisé tant que le travail à faire est vide.</Step>
          </Steps>

          <Callout title="Pourquoi un champ séparé de la description">
            La description s'adresse à <strong>l'équipe</strong> : le contexte,
            l'historique, ce qui a été tenté. Le travail à faire s'adresse à la
            <strong> machine</strong> : la commande. Quand les deux divergent, l'agent
            suit le travail à faire.
          </Callout>

          <H>Quand il démarre</H>
          <P>
            L'ordonnanceur passe <strong>toutes les dix minutes</strong>. Il lance un
            item si toutes ces conditions sont réunies :
          </P>
          <UL>
            <LI>l'item est armé, a un travail à faire, et sa <strong>date de début</strong> est passée s'il en a une ;</LI>
            <LI>il n'est ni terminé ni annulé ;</LI>
            <LI>aucun item qui le <strong>bloque</strong> n'est encore ouvert — on ne rédige pas les notes de version d'une fonctionnalité inachevée ;</LI>
            <LI>un agent autorisé en écriture lui est assigné ;</LI>
            <LI>rien ne tourne déjà sur cet item.</LI>
          </UL>
          <P>
            Au démarrage, l'item passe <strong>en cours</strong>. Sur le board, un
            point bleu <strong>pulse</strong> à côté de l'agent tant qu'il travaille.
          </P>

          <H>Comment il rend compte</H>
          <Defs
            rows={[
              [<>Il a un résultat</>, <>Il commente l'item : ce qu'il a produit, et où.</>],
              [<>Il a fini</>, <>Il passe l'item en <strong>terminé</strong>.</>],
              [<>Il est bloqué</>, <>Il commente <strong>pourquoi</strong>, et laisse l'état tel quel.</>],
            ]}
          />
          <P>
            Commenter et faire avancer l'état de <strong>son propre</strong> work item
            ne demande aucune autorisation. Tout le reste — renommer l'item, changer
            sa priorité, toucher un autre item — passe par une validation humaine.
          </P>

          <H>Ce qui l'arrête</H>
          <Callout kind="warn" title="Trois échecs d'affilée">
            Si les trois dernières tentatives ont échoué, l'item est
            <strong> mis en pause</strong> : l'ordonnanceur ne le relance plus, pour ne
            pas dépenser sans fin sur une tâche que l'agent ne sait pas mener. La
            fiche le signale en rouge, et l'item apparaît dans <Ui>En attente de
            vous</Ui> sur la Home. Précisez le travail à faire, puis relancez-le à la
            main : un succès réarme le démarrage automatique.
          </Callout>
        </>
      ),
    },

    {
      slug: "mention-agent",
      title: "Mentionner un agent dans une discussion",
      summary: "Mettre un agent au travail depuis les commentaires d'un work item.",
      keywords: ["mention", "@", "commentaire", "discussion", "répondre", "agent"],
      body: () => (
        <>
          <Lede>
            La discussion d'un work item est l'endroit où se décide le travail. Un
            agent peut y être <strong>interpellé</strong> comme un collègue : il reçoit
            la demande, travaille sur l'item, et répond dans le même fil.
          </Lede>

          <Steps>
            <Step>Dans le champ de commentaire, tapez <Key>@</Key>. La liste propose les agents <strong>autorisés en écriture</strong> sur le projet.</Step>
            <Step>Choisissez-en un, à la souris ou avec <Key>↑</Key> <Key>↓</Key> puis <Key>Entrée</Key>.</Step>
            <Step>Écrivez votre demande. Sous le champ, une ligne bleue confirme qu'un agent se mettra au travail.</Step>
            <Step><Key>Ctrl</Key>+<Key>Entrée</Key> ou <Ui>Envoyer</Ui>.</Step>
          </Steps>

          <P>
            Le commentaire est publié <strong>avant</strong> que l'agent ne parte : si
            son lancement échoue, votre demande reste écrite dans le fil et peut être
            relancée sans être réécrite. Le fil se met à jour seul jusqu'à sa réponse,
            qui porte son avatar et un badge <Ui>agent</Ui>.
          </P>

          <Callout kind="tip">
            Effacer une mention avant d'envoyer annule la demande : seuls les agents
            encore mentionnés <strong>au moment de l'envoi</strong> sont mis au travail.
          </Callout>
        </>
      ),
    },

    {
      slug: "approvals",
      title: "Autoriser les actions d'un agent",
      summary: "Où apparaissent les demandes d'autorisation, et comment les traiter.",
      keywords: ["autorisation", "approbation", "valider", "refuser", "attente", "notification"],
      body: () => (
        <>
          <Lede>
            Certaines actions d'un agent attendent qu'une personne les autorise.
            Pendant ce temps, <strong>l'agent est arrêté</strong> : chaque demande
            laissée sans réponse est du travail qui n'avance pas.
          </Lede>

          <H>Où les trouver</H>
          <Defs
            rows={[
              [<>La cloche</>, <>Une notification <strong>« À autoriser »</strong>, en ambre, prévient les personnes qui suivent l'item et celle qui a lancé la mission.</>],
              [<>La Home</>, <>Le bloc <Ui>En attente de vous</Ui> rassemble toutes les demandes du service, et les items mis en pause après trois échecs. Il n'apparaît que s'il y a quelque chose à faire.</>],
              [<>La fiche de l'item</>, <>En tête du bloc agent : ce que l'agent veut faire, pourquoi, et depuis quand.</>],
            ]}
          />

          <H>Trancher</H>
          <P>
            Chaque demande dit ce que l'agent veut faire <strong>en clair</strong> —
            « modifier un work item », « découper en sous-tâches » — suivi du détail
            et de sa justification. <Ui>Autoriser</Ui> exécute l'action et relance
            l'agent ; <Ui>Refuser</Ui> la lui refuse, et il continue sans.
          </P>

          <Callout kind="warn" title="Répondre vite compte">
            Un run qui attend une autorisation depuis plus de trente minutes est
            déclaré mort par l'ordonnanceur. Trois fois de suite, et l'item est mis
            en pause.
          </Callout>
        </>
      ),
    },

    {
      slug: "agent-analytics",
      title: "Statistiques des agents",
      summary: "Exécutions, coûts, outils et fiabilité, filtrés par projet ou par demandeur.",
      keywords: ["statistiques", "analytics", "coût", "outils", "performance", "dashboard", "export"],
      body: () => (
        <>
          <Lede>
            L'onglet <Ui>Agents</Ui> des analytics dit ce que la force de travail a
            produit, ce qu'elle a coûté, et à quel point elle est fiable. Le même
            tableau existe à l'échelle de tout l'espace, dans le dashboard général.
          </Lede>

          <H>Filtrer</H>
          <UL>
            <LI><strong>Période</strong> — 30 jours, 90 jours ou 12 mois.</LI>
            <LI><strong>Projet</strong> — le sélecteur en haut de la page Analytics.</LI>
            <LI><strong>Demandeur</strong> — la personne qui a confié le travail.</LI>
            <LI><strong>Service</strong> — dans le dashboard général uniquement.</LI>
          </UL>
          <Callout title="Pourquoi un filtre peut écarter des exécutions">
            Le projet se lit par la mission. Un agent interrogé dans une room
            travaille sans mission, donc sans projet : filtrer par projet écarte ces
            exécutions. Un bandeau dit combien, et pourquoi.
          </Callout>

          <H>Ce qu'on y lit</H>
          <UL>
            <LI>Exécutions et coût <strong>dans le temps</strong>, sur deux graphes séparés.</LI>
            <LI>Exécutions et <strong>taux de réussite par agent</strong>, à lire ensemble : 100 % sur deux exécutions n'est pas de la fiabilité.</LI>
            <LI>Les <strong>outils</strong> : appels, taux d'erreur, répartition par famille.</LI>
            <LI>Les validations humaines, la santé de la boucle de raisonnement, la connaissance.</LI>
          </UL>
          <P>
            Toutes les tables se <strong>cherchent</strong> et s'<strong>exportent en
            CSV</strong>. Cliquer une ligne d'agent ouvre sa fiche statistique à
            droite : ses outils, ses dernières exécutions une par une, ses livrables.
          </P>
        </>
      ),
    },

    {
      slug: "deliverables",
      title: "Livrables et preuve de résultat",
      summary: "Ce que les agents ont produit, et de quoi le vérifier.",
      keywords: ["livrables", "preuve", "résultat", "vérifier", "run", "coût"],
      body: () => (
        <>
          <Lede>
            L'onglet <Ui>Livrables</Ui> d'un projet n'est pas une galerie de fichiers.
            Une galerie montre ce qui a été produit ; celui-ci montre en plus à quelle
            demande chaque chose répond, qui l'a produite, en combien de temps, à quel
            coût, et si la machine a réellement terminé.
          </Lede>

          <Figure caption="La chaîne complète. C'est le premier maillon — la demande — qui transforme un résultat en preuve.">
            <ProofFigure />
          </Figure>

          <H>La colonne la plus importante</H>
          <P>
            Ce n'est pas le contenu, c'est <strong>l'état du run</strong>. Un livrable
            produit par un run échoué existe bel et bien, et ne vaut rien. Le masquer
            serait mentir ; le présenter comme les autres aussi. D'où les trois
            onglets :
          </P>
          <Defs
            rows={[
              [<>Tout</>, <>Ce que le projet a produit, sans tri.</>],
              [<>Aboutis</>, <>Les livrables dont le run a réussi. Ceux sur lesquels on peut s'appuyer.</>],
              [<>À vérifier</>, <>Les autres : run échoué, encore en cours, ou sans run. Pas faux — <strong>invérifiés</strong>, ce qui n'est pas la même chose.</>],
            ]}
          />

          <H>La fiche d'un livrable</H>
          <P>
            Elle met le contenu et la provenance <strong>côte à côte</strong>, jamais
            l'un derrière l'autre : juger un résultat demande de voir en même temps ce
            qu'il dit et d'où il vient. Une provenance rangée dans un second onglet ne
            serait jamais ouverte.
          </P>
          <UL>
            <LI>La <strong>demande</strong> d'origine, avec sa référence.</LI>
            <LI>La <strong>mission</strong> et l'<strong>agent</strong>.</LI>
            <LI>La <strong>durée</strong> et le <strong>coût</strong> du run — deux nombres qui disent ce que la machine a réellement dépensé. Sans eux, « autonome » ne veut rien dire.</LI>
          </UL>

          <Shot
            file="docs/livrables.png"
            alt="L'onglet Livrables d'un projet, avec ses trois onglets et une fiche ouverte montrant contenu et provenance côte à côte."
          />
        </>
      ),
    },

    {
      slug: "assistant",
      title: "Assistant, Missions et Schedules",
      summary: "Le rail Assistant : conversation, tableau des missions, planifications, artifacts.",
      keywords: ["assistant", "missions", "schedules", "planification", "artifacts", "cron"],
      body: () => (
        <>
          <Lede>
            Le rail <Ui>Assistant</Ui> regroupe ce qui relève de la conversation et du
            pilotage des agents, par opposition au rail <Ui>Travail</Ui> qui porte le
            suivi.
          </Lede>

          <Defs
            rows={[
              [<>Missions</>, <>Le tableau de toutes les missions du service, en colonnes : backlog, en cours, terminées. C'est la vue collective de ce que les agents portent.</>],
              [<>Dashboard</>, <>Les statistiques du service : runs, coûts, taux de réussite, activité récente.</>],
              [<>Schedules</>, <>Les missions <strong>récurrentes</strong> : un agent qui produit un rapport chaque lundi, une veille quotidienne. Elles se déclenchent seules.</>],
              [<>Artifacts</>, <>Les documents, présentations et tableurs produits par les agents à l'échelle du service — là où l'onglet Livrables d'un projet reste dans son périmètre.</>],
            ]}
          />

          <Callout kind="tip" title="Mission ponctuelle ou planification ?">
            Une <strong>mission</strong> répond à une demande précise et se termine.
            Une <strong>planification</strong> répète la même demande dans le temps.
            Si vous vous surprenez à relancer la même mission chaque semaine, elle
            devrait être une planification.
          </Callout>
        </>
      ),
    },
  ],
};
