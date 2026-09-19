import { CompassIcon } from "@phosphor-icons/react";
import { DemoProjectCard } from "./DemoProjectCard";
import {
  Callout, Figure, Key, ShellFigure, Shot, Step, Steps, TrackerPanelFigure, Ui,
} from "./figures";
import { Defs, H, LI, Lede, P, UL } from "./prose";
import type { DocSection } from "./types";

export const START_SECTION: DocSection = {
  key: "start",
  label: "Démarrer",
  icon: CompassIcon,
  articles: [
    {
      slug: "overview",
      title: "Ce qu'est un tableau de service",
      summary: "À quoi sert cet espace, et ce qui le distingue du reste de l'application.",
      keywords: ["dashboard", "service", "vue d'ensemble", "introduction"],
      body: () => (
        <>
          <Lede>
            Un tableau de service est l'espace de travail d'une équipe — humaine et
            artificielle — autour d'un même sujet : le support, le marketing, la
            production, ce que vous voulez. Il réunit au même endroit le travail à
            faire, les agents qui en prennent une part, et ce qui en sort.
          </Lede>

          <P>
            La différence avec le reste de FounderOS tient en une phrase : ici,
            <strong> une machine et une personne apparaissent sur la même ligne</strong>.
            Un work item peut être porté par quelqu'un, par un agent, ou par les
            deux ; une mission confiée à un agent produit un livrable rattaché à la
            demande qui l'a motivée ; et le graphe de travail montre les deux
            familles avec leurs liens.
          </P>

          <H>Trois zones, toujours les mêmes</H>
          <P>
            L'écran ne change jamais de structure, quel que soit l'endroit où vous
            vous trouvez. C'est ce qui permet de se déplacer sans réapprendre.
          </P>

          <Figure caption="Le rail (à gauche) porte les grandes sections ; le panneau contextuel montre la navigation de la section choisie ; le contenu occupe le reste.">
            <ShellFigure />
          </Figure>

          <Defs
            rows={[
              [<>Le rail</>, <>Quatre destinations : <Ui>Travail</Ui>, <Ui>Assistant</Ui>, <Ui>Ressources</Ui>, <Ui>Paramètres</Ui>. En bas : l'assistant, le thème, votre profil — et cette documentation.</>],
              [<>Le panneau</>, <>La navigation de la section en cours. Sous <Ui>Travail</Ui>, il liste vos projets et déplie leurs sections. Il se replie avec le bouton en haut du rail.</>],
              [<>Le contenu</>, <>L'écran proprement dit. Il porte sa propre barre de titre, ses filtres et ses actions.</>],
            ]}
          />

          <Callout kind="tip" title="Le raccourci qui remplace la navigation">
            <Key>Ctrl</Key> <Key>K</Key> ouvre la palette de commandes depuis
            n'importe quel écran du module de suivi : elle cherche dans les projets,
            les work items, les cycles et les pages, et crée un work item sans
            quitter l'écran courant.
          </Callout>

          <H>Ce que ce manuel couvre</H>
          <P>
            Chaque page du tableau a son article. Les schémas montrent
            l'organisation des écrans ; pour les parcourir avec de vraies données,
            créez le projet de démonstration décrit à l'article suivant.
          </P>
        </>
      ),
    },

    {
      slug: "demo",
      title: "Le projet de démonstration",
      summary: "Créer un projet rempli de données réalistes pour suivre ce manuel.",
      keywords: ["démo", "exemple", "données", "test", "essai"],
      body: () => (
        <>
          <Lede>
            La documentation est plus utile avec quelque chose à regarder. Ce bouton
            fabrique un projet complet — vingt et un work items, deux cycles, trois
            modules, des demandes non triées, des pages et des notes — pour que
            chaque écran de ce manuel ait de la matière à afficher.
          </Lede>

          <DemoProjectCard />

          <H>Ce qui est créé</H>
          <Defs
            rows={[
              [<>Le projet</>, <>« Refonte du portail client », ouvert à l'espace, avec ses cinq états par défaut et cinq labels.</>],
              [<>21 work items</>, <>Répartis sur tous les états, avec priorités, échéances, labels, sous-items et un epic. Un item est en retard, un autre annulé — les écrans qui servent à repérer ces cas ont ainsi quelque chose à montrer.</>],
              [<>2 cycles</>, <>Un en cours, un à venir. Le burndown a donc une pente et la page Cycles a deux sections à séparer.</>],
              [<>3 modules</>, <>Authentification, Tableau de bord client, Facturation — dont un seulement planifié.</>],
              [<>3 demandes</>, <>Dans l'Intake, non triées : c'est l'état dans lequel cette page a un sens.</>],
              [<>3 pages et 3 notes</>, <>Pour les Pages du projet et le mur de notes du service.</>],
            ]}
          />

          <Callout kind="warn" title="C'est un projet ordinaire">
            Rien ne le marque comme « démo » en base. Il se modifie, s'archive et se
            supprime comme les autres — et il compte dans les statistiques du
            service. Supprimez-le quand il a fini de servir.
          </Callout>
        </>
      ),
    },

    {
      slug: "navigation",
      title: "Se déplacer dans le module",
      summary: "Le panneau Travail, ses trois familles de destinations, et comment le configurer.",
      keywords: ["sidebar", "navigation", "panneau", "épingler", "raccourcis"],
      body: () => (
        <>
          <Lede>
            Le panneau du rail <Ui>Travail</Ui> mélange trois choses différentes, et
            les distinguer une fois suffit à ne plus jamais chercher où cliquer.
          </Lede>

          <Figure caption="Trois familles : ce qui vous concerne, ce qui concerne le service entier, et ce qui appartient à un projet ouvert.">
            <TrackerPanelFigure />
          </Figure>

          <UL>
            <LI>
              <strong>La reprise</strong> — <Ui>Home</Ui>, <Ui>Mon travail</Ui>,
              <Ui>Brouillons</Ui>. Ce qui vous est propre, et par où l'on recommence
              le matin.
            </LI>
            <LI>
              <strong>L'espace</strong> — <Ui>Projets</Ui>, <Ui>Initiatives</Ui>,
              <Ui>Cycles actifs</Ui>, <Ui>Workgraph</Ui>, <Ui>Wiki</Ui>,
              <Ui>Notes</Ui>… Des destinations qui portent sur TOUT le service, tous
              projets confondus.
            </LI>
            <LI>
              <strong>Un projet</strong> — quand vous ouvrez un projet, ses sections
              se déplient en dessous, en retrait. Ce retrait est la seule chose qui
              les distingue des destinations d'espace : sans lui, <Ui>Cycles</Ui> du
              projet et <Ui>Cycles actifs</Ui> du service se liraient au même rang.
            </LI>
          </UL>

          <H>Épingler ce qui compte</H>
          <P>
            Le panneau peut afficher beaucoup de destinations, et toutes ne servent
            pas à tout le monde. Les <strong>Paramètres du service → Navigation</strong>
            permettent d'en masquer, et de choisir l'écran sur lequel le tableau
            s'ouvre.
          </P>

          <Callout>
            Masquer une destination ne supprime rien : ses URL continuent de
            résoudre, et un lien partagé vers un écran masqué s'ouvre normalement.
          </Callout>

          <H>Replier le panneau</H>
          <Steps>
            <Step>Le bouton sous le sélecteur de tableau, en haut du rail, replie le panneau.</Step>
            <Step>Le contenu occupe alors toute la largeur — utile sur le Gantt et le Workgraph.</Step>
            <Step>Le choix est mémorisé pour la prochaine visite.</Step>
          </Steps>

          <Shot
            file="docs/navigation-panneau.png"
            alt="Le panneau Travail déplié sur un projet, montrant les trois familles de destinations les unes sous les autres."
          />
        </>
      ),
    },
  ],
};
