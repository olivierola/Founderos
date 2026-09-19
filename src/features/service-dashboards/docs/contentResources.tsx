import { DatabaseIcon } from "@phosphor-icons/react";
import { Callout, Ui } from "./figures";
import { Defs, H, LI, Lede, P, UL } from "./prose";
import type { DocSection } from "./types";

export const RESOURCES_SECTION: DocSection = {
  key: "resources",
  label: "Ressources et réglages",
  icon: DatabaseIcon,
  articles: [
    {
      slug: "memory",
      title: "Mémoire",
      summary: "Ce que le service sait : graphe, mémoires, sources documentaires.",
      keywords: ["mémoire", "memory", "connaissances", "rag", "sources", "documents"],
      body: () => (
        <>
          <Lede>
            La mémoire est ce sur quoi les agents s'appuient pour répondre autrement
            qu'en généralités. Elle se lit sous trois angles.
          </Lede>

          <Defs
            rows={[
              [<>Graph</>, <>Les entités connues du service et leurs relations. La vue d'ensemble de ce que la mémoire contient.</>],
              [<>Memories</>, <>Les faits retenus, un par un, avec leur origine. C'est ici qu'on corrige ou supprime ce qui est devenu faux.</>],
              [<>Sources</>, <>Les documents versés : PDF, tableurs, pages. Ils sont découpés et indexés pour être retrouvés par le sens, pas par mot-clé.</>],
            ]}
          />

          <Callout kind="warn">
            Une mémoire fausse est pire qu'une mémoire vide : l'agent y puise avec la
            même assurance. Quand une information change, corrigez-la ici — la
            corriger dans une conversation ne la remplace pas.
          </Callout>

          <H>Rattacher des connaissances à un agent</H>
          <P>
            Les collections de connaissances s'activent <strong>par agent</strong>. Un
            agent sans collection attachée ne cherche nulle part ; un agent qui les a
            toutes cherche partout, ce qui coûte du temps et dilue les réponses.
          </P>
        </>
      ),
    },

    {
      slug: "connectors",
      title: "Connexions",
      summary: "Les outils externes que les agents peuvent atteindre.",
      keywords: ["connexions", "connecteurs", "intégrations", "oauth", "mcp", "outils externes"],
      body: () => (
        <>
          <Lede>
            Une connexion donne à un agent l'accès à un service extérieur — une boîte
            mail, un CRM, un dépôt de code. Sans connexion, un agent ne peut agir que
            dans FounderOS.
          </Lede>

          <Defs
            rows={[
              [<>Connexions de l'espace</>, <>Des comptes partagés, utilisables par tous les agents du tableau. Pour les outils de l'équipe.</>],
              [<>Mes connexions</>, <>Vos propres comptes. Un agent agit alors <strong>en votre nom</strong> — ce qui est parfois exactement ce qu'on veut, et parfois pas du tout.</>],
            ]}
          />

          <Callout kind="warn" title="La portée compte plus que l'outil">
            Un compte partagé et votre boîte personnelle ne sont pas deux filtres
            d'une même liste : ce sont deux niveaux de risque différents. C'est
            pourquoi ils sont deux destinations séparées et non un menu déroulant.
          </Callout>

          <P>
            À la connexion, le tiroir montre les <strong>actions</strong> que le
            branchement autorise. Lisez-les : c'est la seule occasion de voir ce que
            l'agent pourra faire avant qu'il le fasse.
          </P>

          <H>Serveurs MCP</H>
          <P>
            Au-delà des connecteurs, un agent peut recevoir des outils fournis par un
            serveur <strong>MCP</strong> distant, déclaré dans l'espace puis attaché à
            l'agent. Ses outils apparaissent alors dans sa liste comme les autres.
          </P>
        </>
      ),
    },

    {
      slug: "workflows",
      title: "Workflows",
      summary: "Des procédures écrites que les agents exécutent.",
      keywords: ["workflows", "automatisation", "procédure", "enchaînement"],
      body: () => (
        <>
          <Lede>
            Un workflow est une procédure : une suite d'étapes qu'on veut voir
            exécutée de la même façon à chaque fois. Il s'écrit comme un
            <strong> texte</strong>, avec des blocs posés dans les phrases.
          </Lede>

          <P>
            Ce parti pris remplace le canevas de boîtes et de flèches. Une procédure
            se lit et se relit ; sous forme de graphe, elle demande d'être décodée
            avant d'être comprise, et personne ne la relit jamais.
          </P>

          <UL>
            <LI>Les <strong>blocs</strong> sont les actions : appeler un agent, écrire quelque part, attendre une validation.</LI>
            <LI>Le texte autour porte les conditions et les intentions.</LI>
            <LI>Un workflow se déclenche à la demande, sur planification, ou par un événement.</LI>
          </UL>
        </>
      ),
    },

    {
      slug: "settings",
      title: "Paramètres du service",
      summary: "Général, navigation, assistant, agents, rooms, zone de danger.",
      keywords: ["paramètres", "réglages", "settings", "supprimer", "renommer"],
      body: () => (
        <>
          <Lede>
            Les réglages du tableau lui-même — à ne pas confondre avec les réglages
            d'un projet, qui définissent son vocabulaire de travail.
          </Lede>

          <Defs
            rows={[
              [<>Général</>, <>Nom, icône et description du tableau.</>],
              [<>Navigation</>, <>Quelles destinations apparaissent dans le panneau, et sur quel écran le tableau s'ouvre.</>],
              [<>Assistant</>, <>Le comportement de l'assistant du produit dans ce tableau.</>],
              [<>Agents</>, <>Les réglages communs aux agents du service : modèle par défaut, budgets, approbations.</>],
              [<>Rooms</>, <>La création et la visibilité des salons.</>],
              [<>Zone de danger</>, <>Suppression du tableau. Irréversible, et elle emporte les projets qu'il contient.</>],
            ]}
          />

          <Callout kind="warn" title="Supprimer un tableau supprime son travail">
            Les projets, work items, cycles, pages et notes rattachés au tableau
            disparaissent avec lui. Archivez les projets que vous voulez conserver, ou
            déplacez-les, <strong>avant</strong>.
          </Callout>

          <H>Modèles et coûts</H>
          <P>
            Deux modèles sont proposés pour les agents, et le choix se fait aussi
            depuis le composeur d'une conversation. Le coût de chaque run est
            comptabilisé et remonte dans <Ui>Dashboard</Ui> et dans les livrables :
            c'est ce qui rend l'usage des agents pilotable plutôt que subi.
          </P>
        </>
      ),
    },
  ],
};
