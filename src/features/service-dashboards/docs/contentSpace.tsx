import { GraphIcon } from "@phosphor-icons/react";
import { Callout, Figure, GraphFigure, Shot, Step, Steps, Ui } from "./figures";
import { Defs, H, LI, Lede, P, UL } from "./prose";
import type { DocSection } from "./types";

export const SPACE_SECTION: DocSection = {
  key: "space",
  label: "L'espace",
  icon: GraphIcon,
  articles: [
    {
      slug: "initiatives",
      title: "Initiatives",
      summary: "Le niveau au-dessus du projet : un objectif que plusieurs projets servent.",
      keywords: ["initiatives", "objectif", "portefeuille", "programme"],
      body: () => (
        <>
          <Lede>
            Une initiative rassemble plusieurs projets sous un même but. « Réduire le
            temps de réponse du support » peut mobiliser un projet produit, un projet
            data et un projet formation.
          </Lede>

          <UL>
            <LI>Elle porte une <strong>date cible</strong> et un état de santé — en bonne voie, à risque, en retard.</LI>
            <LI>Son avancement est <strong>dérivé</strong> de celui de ses projets : on ne le saisit pas à la main.</LI>
            <LI>Un projet peut servir plusieurs initiatives.</LI>
          </UL>

          <Callout kind="tip" title="Quand faut-il une initiative ?">
            Quand la question « où en est-on ? » se pose à quelqu'un qui ne connaît
            pas vos projets par leur nom. Si la réponse tient dans un projet,
            l'initiative n'apporte qu'un niveau de plus à traverser.
          </Callout>
        </>
      ),
    },

    {
      slug: "workgraph",
      title: "Workgraph",
      summary: "La carte de tout ce que contient le service, avec ses liens.",
      keywords: ["workgraph", "graphe", "carte", "canevas", "relations", "liens"],
      body: () => (
        <>
          <Lede>
            Une carte navigable de l'espace de travail. Elle montre les projets, les
            cycles, les modules, les work items, les epics, les notes, les
            <strong> personnes</strong> et les <strong>agents</strong> — et surtout ce
            qui les relie.
          </Lede>

          <Figure caption="Les traits pleins portent l'appartenance (un item dans un cycle) ; les pointillés portent l'assignation (un agent sur un item).">
            <GraphFigure />
          </Figure>

          <H>S'en servir</H>
          <Steps>
            <Step>Les <strong>familles</strong> se filtrent depuis la légende : masquer les work items ne garde que le squelette projets/cycles.</Step>
            <Step>La <strong>recherche</strong> ne filtre pas, elle <em>atténue</em> : ce qui ne correspond pas s'estompe au lieu de disparaître, pour que les liens restent lisibles.</Step>
            <Step>Cliquer un nœud le met au centre et fait ressortir <strong>tout son voisinage</strong> — ses parents, ses enfants, ses assignés.</Step>
            <Step>Un double-clic ouvre l'objet réel : le work item, le projet, la fiche de l'agent.</Step>
          </Steps>

          <P>
            Un mode <strong>tableau</strong> présente les mêmes données en liste, avec
            leurs liaisons en colonnes. Il sert quand on cherche une valeur précise
            plutôt qu'une forme.
          </P>

          <Callout>
            Le graphe se lit surtout par ses <strong>absences</strong> : un projet sans
            cycle, un cycle sans item, un agent relié à rien. Ce sont les nœuds isolés
            qui apprennent quelque chose.
          </Callout>

          <Shot
            file="docs/workgraph.png"
            alt="Le Workgraph peuplé : projets, cycles, work items et agents reliés, avec la légende des familles ouverte."
          />
        </>
      ),
    },

    {
      slug: "active-cycles",
      title: "Cycles actifs",
      summary: "Tous les cycles en cours du service, côte à côte.",
      keywords: ["cycles actifs", "sprints en cours", "avancement"],
      body: () => (
        <>
          <Lede>
            Chaque projet a ses cycles ; cet écran les réunit. Il répond à une seule
            question : parmi tous les sprints en cours du service, lesquels sont en
            difficulté ?
          </Lede>

          <P>
            Chaque carte porte le projet, les dates, l'avancement et le nombre
            d'items restants. Les cycles en retard remontent en tête — un écran
            trié par ordre alphabétique n'aurait servi à rien ici.
          </P>
        </>
      ),
    },

    {
      slug: "stickies",
      title: "Notes",
      summary: "Le mur de notes du service : ce qui n'a pas encore de forme.",
      keywords: ["notes", "stickies", "post-it", "pense-bête"],
      body: () => (
        <>
          <Lede>
            Un mur de petites notes manuscrites, propre au tableau de service. Pour
            ce qui n'est pas encore une tâche : un rappel, un numéro, une idée de
            réunion.
          </Lede>

          <UL>
            <LI>Une note se crée depuis la barre du haut, s'écrit directement et s'enregistre seule.</LI>
            <LI>Sa <strong>couleur</strong> se change depuis son menu — c'est le seul classement qu'elle connaît.</LI>
            <LI>Elles se réorganisent par glisser-déposer.</LI>
          </UL>

          <Callout kind="tip">
            Une note qui survit à trois semaines de mur est probablement un work
            item déguisé. Le mur n'a ni échéance, ni assigné, ni recherche : ce
            qu'on veut retrouver ne doit pas y rester.
          </Callout>
        </>
      ),
    },

    {
      slug: "wiki",
      title: "Wiki",
      summary: "Les documents du service, hors projet.",
      keywords: ["wiki", "documentation interne", "pages", "procédures"],
      body: () => (
        <>
          <Lede>
            Le même éditeur que les Pages d'un projet, mais au niveau du service :
            les procédures, les décisions, les modes d'emploi qui ne dépendent
            d'aucun projet en particulier.
          </Lede>

          <P>
            La barre latérale du wiki présente l'arborescence des pages, dépliable.
            Une page peut en contenir d'autres sur autant de niveaux que nécessaire.
          </P>

          <Callout>
            Wiki et Pages ne sont pas deux produits : c'est le même objet rattaché
            soit au service, soit à un projet. Une page de service est visible de
            tous les projets ; une page de projet reste dans son projet.
          </Callout>
        </>
      ),
    },

    {
      slug: "rooms",
      title: "Rooms",
      summary: "Les conversations d'équipe, dans le même panneau que le travail.",
      keywords: ["rooms", "chat", "conversation", "messages", "discussion", "agents"],
      body: () => (
        <>
          <Lede>
            Des salons de discussion rattachés au service. Ils sont sous les projets
            dans le panneau, et non derrière un autre rail : une room est une
            conversation <em>sur</em> du travail, et changer de section pour passer
            du board à ce qu'on en dit casse le fil.
          </Lede>

          <H>Ce qui les distingue d'un chat ordinaire</H>
          <UL>
            <LI>
              <strong>Les agents y participent.</strong> On les mentionne avec
              <Ui>@</Ui> ; ils répondent dans le fil, avec leurs outils.
            </LI>
            <LI>
              <strong>Les commandes</strong> s'appellent avec <Ui>/</Ui> depuis le
              composeur.
            </LI>
            <LI>
              <strong>La dictée</strong> est disponible dans le composeur, comme
              partout ailleurs dans le produit.
            </LI>
            <LI>
              Le travail d'un agent lancé depuis une room reste visible dans la
              room : ses étapes, ses appels d'outils, ses demandes d'autorisation.
            </LI>
          </UL>

          <Callout kind="warn" title="Autorisations dans le fil">
            Quand un agent veut faire une <strong>écriture</strong> — envoyer un
            message, modifier une fiche —, il demande l'autorisation dans la
            conversation et attend. Les lectures ne demandent rien. Vous pouvez
            autoriser une fois, ou tout autoriser pour cet outil.
          </Callout>

          <Shot
            file="docs/room.png"
            alt="Une room avec une conversation mêlant personnes et agents, et une demande d'autorisation en attente dans le fil."
          />
        </>
      ),
    },
  ],
};
