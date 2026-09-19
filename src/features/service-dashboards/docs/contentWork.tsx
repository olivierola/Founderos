import { KanbanIcon } from "@phosphor-icons/react";
import {
  BoardFigure, Callout, Figure, GanttFigure, IssueRowFigure, Key, LayoutsFigure,
  Shot, Step, Steps, Ui,
} from "./figures";
import { Defs, H, LI, Lede, P, UL } from "./prose";
import type { DocSection } from "./types";

export const WORK_SECTION: DocSection = {
  key: "work",
  label: "Le travail",
  icon: KanbanIcon,
  articles: [
    {
      slug: "home",
      title: "Home",
      summary: "Le point de reprise, et le composeur qui ouvre une conversation avec vos agents.",
      keywords: ["accueil", "home", "reprise", "widgets", "room", "agent", "mention"],
      body: () => (
        <>
          <Lede>
            L'écran sur lequel le tableau s'ouvre. Il fait deux choses : vous laisser
            <strong> reprendre</strong> où vous en étiez, et vous laisser
            <strong> demander</strong> quelque chose à votre équipe — humaine ou
            machine — sans changer d'écran.
          </Lede>

          <H>Le composeur</H>
          <P>
            Le champ en haut n'est pas une barre de recherche. Vous y écrivez ce
            qu'il y a à faire, et la conversation <strong>existe</strong> : une room
            est créée, titrée d'après ce que vous avez écrit, et elle s'ouvre.
          </P>

          <Steps>
            <Step>Écrivez votre demande. <Key>Entrée</Key> envoie, <Key>Maj</Key>+<Key>Entrée</Key> passe à la ligne.</Step>
            <Step>Mentionnez un agent avec <Ui>@</Ui> — il est <strong>ajouté à la room</strong> et peut donc y répondre. Sans mention, la room reste entre humains.</Step>
            <Step>Tapez <Ui>/</Ui> pour les commandes, joignez des fichiers, ou dictez au micro.</Step>
          </Steps>

          <Callout kind="tip" title="Pourquoi une room, et pas l'assistant">
            L'assistant répond dans un panneau latéral qui n'appartient à personne :
            la réponse se lit et se perd. Une room est un <strong>objet du
            service</strong> — elle a des participants, elle garde son historique,
            les agents y travaillent avec leurs outils, et on y revient. L'assistant
            reste à un clic, par le bouton d'agrandissement du bloc, pour ce qui n'a
            pas vocation à laisser de trace.
          </Callout>

          <Callout kind="warn">
            Si l'envoi échoue, votre texte n'est <strong>pas perdu</strong> : il
            s'affiche sous le champ avec un bouton <Ui>Réessayer</Ui>, qui réutilise
            la room déjà créée au lieu d'en laisser une vide derrière elle.
          </Callout>

          <H>Ce qu'on trouve en dessous</H>
          <Defs
            rows={[
              [<>Salutation et date</>, <>Le repère temporel, qui évite de confondre « hier » et « la semaine dernière » en lisant les échéances.</>],
              [<>Widgets</>, <>Vos items assignés, ceux qui arrivent à échéance, les projets récents. Chacun est une liste courte qui renvoie vers l'écran complet.</>],
              [<>Récents</>, <>Ce que vous avez ouvert en dernier, tous types confondus — un projet, un work item, une page.</>],
              [<>Vos notes</>, <>Le mur de pense-bêtes, visible de vous seul.</>],
            ]}
          />

          <P>
            La composition est <strong>personnelle</strong> : le bouton
            <Ui>Gérer les widgets</Ui> range l'accueil à votre main sans toucher à
            celui des autres. C'est le contraire des liens rapides, qui appartiennent
            à l'équipe.
          </P>

          <Callout>
            Home est configurable comme écran d'ouverture du tableau, mais ce n'est
            pas obligatoire : <strong>Paramètres → Navigation</strong> permet de
            démarrer sur <Ui>Mon travail</Ui> ou directement sur un projet.
          </Callout>

          <Shot
            file="docs/home.png"
            alt="La page Home : le composeur en haut avec une mention d'agent en cours de frappe, puis les widgets — items assignés, échéances, projets récents."
          />
        </>
      ),
    },

    {
      slug: "my-work",
      title: "Mon travail",
      summary: "Tout ce qui vous est assigné, tous projets confondus.",
      keywords: ["mon travail", "assigné", "à faire", "mes tâches"],
      body: () => (
        <>
          <Lede>
            La seule page qui traverse les projets pour ne montrer que vous. Elle
            répond à la question du matin : qu'est-ce que j'ai à faire aujourd'hui,
            et où.
          </Lede>

          <P>
            Chaque ligne porte son projet d'origine, parce qu'un titre seul ne suffit
            pas à savoir de quoi il s'agit quand on travaille sur cinq projets à la
            fois. Le regroupement par état sépare ce qui est en cours de ce qui
            attend.
          </P>

          <H>Ce qui n'y figure pas</H>
          <UL>
            <LI>Les items <strong>terminés</strong>, sauf en changeant le filtre : une liste de tâches qui garde ses tâches faites cesse d'être une liste de tâches.</LI>
            <LI>Les items <strong>archivés</strong>, jamais — ils ont leur propre écran.</LI>
            <LI>Les <strong>brouillons</strong>, qui ne sont assignés à personne tant qu'ils ne sont pas publiés.</LI>
          </UL>
        </>
      ),
    },

    {
      slug: "projects",
      title: "Projets",
      summary: "La liste des projets du service, et comment en créer un.",
      keywords: ["projets", "créer un projet", "identifiant", "préfixe"],
      body: () => (
        <>
          <Lede>
            Un projet est un périmètre de travail avec ses propres états, ses labels,
            ses cycles et ses membres. C'est l'unité que tout le reste du module
            présuppose.
          </Lede>

          <H>Créer un projet</H>
          <Steps>
            <Step>Depuis la liste, le bouton <Ui>Nouveau projet</Ui>.</Step>
            <Step>Donnez-lui un <strong>nom</strong> et un <strong>identifiant</strong> court — deux à cinq lettres.</Step>
            <Step>Choisissez une icône : sur quinze projets aux noms qui se ressemblent, c'est elle qu'on repère.</Step>
            <Step>Réglez la <strong>visibilité</strong> : ouvert à l'espace, ou privé.</Step>
          </Steps>

          <Callout kind="warn" title="L'identifiant ne se change pas à la légère">
            Il préfixe la référence de chaque work item — <Ui>DEMO-14</Ui> — et ces
            références circulent dans les commentaires, les messages et les liens. Le
            modifier réécrit toutes les références existantes.
          </Callout>

          <H>Les sections d'un projet</H>
          <P>
            Une fois ouvert, un projet déplie ses sections dans le panneau. Toutes ne
            sont pas actives par défaut : <Ui>Cycles</Ui>, <Ui>Modules</Ui>,
            <Ui>Vues</Ui>, <Ui>Pages</Ui> et <Ui>Intake</Ui> s'activent dans les
            réglages du projet. Une section désactivée <strong>disparaît</strong> de
            la navigation au lieu d'y rester grisée.
          </P>
        </>
      ),
    },

    {
      slug: "project-overview",
      title: "Overview du projet",
      summary: "La page de garde : description longue, avancement, raccourcis.",
      keywords: ["overview", "aperçu", "description", "résumé"],
      body: () => (
        <>
          <Lede>
            La page qu'on montre à quelqu'un qui arrive sur le projet. Elle porte la
            description longue — un vrai document, pas un champ de formulaire — et
            l'état d'avancement.
          </Lede>

          <UL>
            <LI><strong>La description</strong> s'édite en place, avec titres, listes et liens. Elle est faite pour contenir le cadrage du projet, pas une phrase.</LI>
            <LI><strong>L'avancement</strong> résume la répartition des work items par état et le nombre d'items en retard.</LI>
            <LI><strong>Les raccourcis</strong> mènent au cycle en cours, aux modules et aux membres.</LI>
          </UL>

          <Shot
            file="docs/projet-overview.png"
            alt="La page Overview d'un projet, avec sa couverture, sa description longue et les indicateurs d'avancement."
          />
        </>
      ),
    },

    {
      slug: "issues",
      title: "Work items",
      summary: "L'écran principal : la liste du travail, ses six dispositions, ses filtres.",
      keywords: ["work items", "tâches", "issues", "board", "kanban", "liste"],
      body: () => (
        <>
          <Lede>
            L'écran où l'on passe la journée. Une même liste de travail, présentée de
            six façons, filtrable et groupable — et c'est le même contenu à chaque
            fois, jamais six listes différentes.
          </Lede>

          <H>Six dispositions</H>
          <Figure caption="La disposition change la FORME, pas le contenu : les mêmes filtres s'appliquent partout.">
            <LayoutsFigure />
          </Figure>

          <Defs
            rows={[
              [<>Liste</>, <>Le défaut. Dense, groupée, la plus rapide à parcourir.</>],
              [<>Kanban</>, <>Des colonnes qu'on glisse. Pour faire avancer plutôt que pour lire.</>],
              [<>Tableau</>, <>Une grille de propriétés, éditable cellule par cellule. Pour corriger vingt échéances d'affilée.</>],
              [<>Calendrier</>, <>Par échéance. Pour voir un mois se remplir.</>],
              [<>Gantt</>, <>Dans le temps, avec les durées. Voir l'article dédié.</>],
              [<>Feuille</>, <>La hiérarchie parents/sous-items dépliée.</>],
            ]}
          />

          <H>L'anatomie d'une ligne</H>
          <Figure caption="Tout se modifie depuis la ligne, sans ouvrir l'item : l'état, la priorité, l'échéance, les assignés.">
            <IssueRowFigure />
          </Figure>

          <H>Filtrer, grouper, afficher</H>
          <P>
            Deux boutons commandent ce que vous voyez, et leur différence mérite
            d'être retenue.
          </P>
          <UL>
            <LI>
              <strong>Filtres</strong> retire des items de la liste. Le bouton nomme
              les champs filtrés — « Priorité · Assignés » — plutôt que d'afficher un
              simple compteur : ce qui explique une liste courte, c'est de savoir
              QUOI est écarté.
            </LI>
            <LI>
              <strong>Affichage</strong> ne retire rien mais réorganise : le
              groupement, l'ordre, les propriétés visibles, et le fait de montrer ou
              non les sous-items.
            </LI>
          </UL>

          <Callout kind="warn" title="Une liste vide alors qu'il y a du travail">
            L'affichage retient un réglage par écran. Si <Ui>Work items</Ui> semble
            vide alors que la page <Ui>Vues</Ui> montre des items, vérifiez le bouton
            d'affichage : un filtre <Ui>Type : actifs</Ui> ou un masquage des
            sous-items s'y trouve probablement encore.
          </Callout>

          <H>Créer un work item</H>
          <Steps>
            <Step>Le bouton <Ui>Nouveau</Ui> de la barre, ou <Key>C</Key> depuis n'importe quel écran du projet.</Step>
            <Step>Le titre suffit à enregistrer ; tout le reste se règle après.</Step>
            <Step><strong>Créer un autre</strong> garde le formulaire ouvert avec les mêmes propriétés — pour saisir une réunion de cadrage d'une traite.</Step>
          </Steps>

          <H>La fiche d'un item</H>
          <P>
            Un clic ouvre la fiche en aperçu, sans quitter la liste. Elle porte le
            titre, la description, les propriétés, les sous-items, les liens vers
            d'autres items, les pièces jointes, les <strong>missions confiées aux
            agents</strong>, puis les commentaires et l'activité.
          </P>
          <P>
            L'aperçu s'agrandit : panneau latéral, fenêtre centrée ou plein écran,
            selon la place dont vous avez besoin.
          </P>

          <Shot
            file="docs/work-items-liste.png"
            alt="La liste des work items groupée par état, avec la barre de filtres et le bouton d'affichage."
          />
        </>
      ),
    },

    {
      slug: "gantt",
      title: "Gantt",
      summary: "Le travail dans le temps : durées, chevauchements, retards.",
      keywords: ["gantt", "planning", "timeline", "chronologie", "dates"],
      body: () => (
        <>
          <Lede>
            La seule disposition qui montre la <strong>durée</strong>. Une liste dit
            qu'un item est dû le 12 ; le Gantt dit qu'il commence le 3, qu'il dure
            neuf jours et qu'il chevauche deux autres chantiers.
          </Lede>

          <Figure caption="Une barre par item, entre sa date de début et son échéance. La colonne teintée est aujourd'hui.">
            <GanttFigure />
          </Figure>

          <H>Les crans de zoom</H>
          <Defs
            rows={[
              [<>Jour</>, <>Une colonne par jour. Pour une semaine chargée où l'on cherche un créneau.</>],
              [<>Semaine</>, <>Le cran de travail courant : un trimestre tient à l'écran.</>],
              [<>Mois</>, <>Pour une feuille de route sur l'année.</>],
              [<>Trimestre</>, <>La vue de recul, où l'on ne lit plus les titres mais les masses.</>],
            ]}
          />

          <UL>
            <LI>Une barre se <strong>déplace</strong> et se <strong>redimensionne</strong> à la souris : les dates s'enregistrent aussitôt.</LI>
            <LI>Un item <strong>sans dates</strong> n'a pas de barre — il apparaît dans la colonne de gauche, sans rien à sa droite. C'est le signal qu'il reste à planifier.</LI>
            <LI>Une échéance <strong>dépassée</strong> se teinte : c'est ce qu'on vient chercher.</LI>
          </UL>

          <Callout kind="tip">
            Repliez le panneau de navigation avant d'ouvrir le Gantt : il gagne
            268 pixels, soit deux à trois colonnes de plus au cran Jour.
          </Callout>
        </>
      ),
    },

    {
      slug: "cycles",
      title: "Cycles",
      summary: "Des périodes bornées dans le temps, avec leur burndown.",
      keywords: ["cycles", "sprint", "itération", "burndown"],
      body: () => (
        <>
          <Lede>
            Un cycle est un intervalle de dates dans lequel on range du travail :
            un sprint, une quinzaine, un mois. Ce qui le distingue d'un simple
            filtre, c'est qu'il a une <strong>fin</strong> — et donc un bilan.
          </Lede>

          <H>Les trois états d'un cycle</H>
          <Defs
            rows={[
              [<>À venir</>, <>Sa date de début est dans le futur. On y range du travail sans qu'il compte encore.</>],
              [<>En cours</>, <>Aujourd'hui est entre ses deux dates. C'est le cycle que montre <Ui>Cycles actifs</Ui>.</>],
              [<>Terminé</>, <>Sa date de fin est passée. Le travail non fini n'est pas déplacé automatiquement : c'est une décision, pas une conséquence.</>],
            ]}
          />

          <H>Le burndown</H>
          <P>
            La courbe compare ce qu'il reste à faire à ce qu'il devrait rester si le
            travail avançait régulièrement. Au-dessus de la diagonale, le cycle prend
            du retard ; en dessous, il est en avance. Une courbe <strong>plate puis
            verticale</strong> à la fin est le motif classique du travail terminé en
            bloc le dernier jour.
          </P>

          <Callout>
            Un work item n'appartient qu'à <strong>un seul cycle</strong> à la fois.
            L'ajouter à un autre le retire du premier — c'est ce qui rend le bilan
            d'un cycle interprétable.
          </Callout>

          <H>Archiver un cycle</H>
          <P>
            Un cycle terminé s'archive : il quitte la liste sans être détruit et
            reste consultable depuis <Ui>Archives</Ui>. Ses items, eux, ne sont pas
            archivés.
          </P>
        </>
      ),
    },

    {
      slug: "modules",
      title: "Modules",
      summary: "Des regroupements de travail par sujet, sans borne de temps.",
      keywords: ["modules", "chantiers", "epic", "regroupement", "lot"],
      body: () => (
        <>
          <Lede>
            Un module regroupe du travail par <strong>sujet</strong> là où le cycle le
            regroupe par <strong>période</strong>. « Authentification » est un module ;
            « Sprint 12 » est un cycle. Un même item appartient normalement aux deux.
          </Lede>

          <Defs
            rows={[
              [<>Statut</>, <>Planifié, en cours, en pause, terminé, annulé. Il se règle à la main : un module ne devient pas « terminé » parce que ses items le sont.</>],
              [<>Responsable</>, <>Une personne qui répond du module. Facultatif, mais un module sans responsable a tendance à ne jamais avancer.</>],
              [<>Dates</>, <>Un début et une cible, qui alimentent la barre d'avancement.</>],
              [<>Appartenance</>, <>Un item peut être dans <strong>plusieurs</strong> modules — contrairement aux cycles.</>],
            ]}
          />

          <P>
            La fiche d'un module montre ses items groupés par état et son taux
            d'avancement. C'est l'écran de la réunion hebdomadaire par chantier.
          </P>
        </>
      ),
    },

    {
      slug: "epics",
      title: "Epics",
      summary: "Les gros sujets qui traversent plusieurs cycles.",
      keywords: ["epics", "epic", "gros sujet", "parent"],
      body: () => (
        <>
          <Lede>
            Un epic est un work item marqué comme tel. Il n'a pas de table à part et
            se comporte comme les autres : il a un état, une priorité, des assignés,
            et surtout des <strong>sous-items</strong> qui portent le travail réel.
          </Lede>

          <P>
            La page <Ui>Epics</Ui> les liste avec leur avancement — combien de leurs
            enfants sont terminés. C'est la vue de niveau au-dessus : elle répond à
            « où en est la refonte ? » quand la liste des work items répond à « que
            fait-on aujourd'hui ? ».
          </P>

          <Callout kind="tip" title="Epic ou module ?">
            Un <strong>epic</strong> est un travail qui a une fin et un résultat
            livrable ; il se termine. Un <strong>module</strong> est un domaine
            permanent du produit ; il dure. « Refondre l'espace client » est un epic,
            « Facturation » est un module.
          </Callout>
        </>
      ),
    },

    {
      slug: "views",
      title: "Vues",
      summary: "Des filtres enregistrés, partageables, avec leur propre disposition.",
      keywords: ["vues", "views", "filtres enregistrés", "partager"],
      body: () => (
        <>
          <Lede>
            Une vue est une combinaison de filtres, de groupement et de disposition à
            laquelle on donne un nom. « Urgences en cours », « À relire », « Bugs du
            trimestre » — ce sont des questions qu'on repose chaque semaine.
          </Lede>

          <H>Créer une vue</H>
          <Steps>
            <Step>Depuis <Ui>Work items</Ui>, réglez les filtres et l'affichage jusqu'à obtenir la liste voulue.</Step>
            <Step>Ouvrez <Ui>Vues</Ui> puis <Ui>Ajouter une vue</Ui>.</Step>
            <Step>Nommez-la, et choisissez si elle est <strong>privée</strong> ou visible par le projet.</Step>
          </Steps>

          <P>
            Une vue ouverte se comporte comme la page des work items : on peut y
            modifier les filtres pour explorer, sans altérer la vue enregistrée tant
            qu'on ne l'enregistre pas.
          </P>

          <Callout>
            Il existe aussi des <strong>vues d'espace</strong>, hors projet, listées
            sous <Ui>Vues</Ui> dans la famille « Espace » du panneau. Elles couvrent
            tous les projets à la fois.
          </Callout>
        </>
      ),
    },

    {
      slug: "pages",
      title: "Pages",
      summary: "Les documents du projet : décisions, comptes rendus, procédures.",
      keywords: ["pages", "document", "wiki", "notes", "éditeur"],
      body: () => (
        <>
          <Lede>
            Un éditeur de documents rattaché au projet. Pour ce qui ne rentre pas
            dans un work item : un compte rendu, une décision d'architecture, une
            checklist de mise en production.
          </Lede>

          <UL>
            <LI>Titres, listes, cases à cocher, tableaux, blocs de code, images.</LI>
            <LI>Les pages s'imbriquent : une page peut en contenir d'autres.</LI>
            <LI>Le <strong>Wiki</strong> du service est la même chose au niveau du tableau plutôt que du projet.</LI>
          </UL>

          <Callout kind="tip">
            Une page ne remplace pas un work item : elle ne s'assigne pas et
            n'apparaît dans aucun board. Si quelque chose doit être <em>fait</em>,
            c'est un work item, même si son contenu vit dans une page.
          </Callout>
        </>
      ),
    },

    {
      slug: "intake",
      title: "Intake",
      summary: "La boîte de réception du projet : les demandes non triées.",
      keywords: ["intake", "demandes", "boîte de réception", "triage", "support"],
      body: () => (
        <>
          <Lede>
            Tout ce qui arrive de l'extérieur — un signalement, une demande client,
            une idée — atterrit ici <strong>sans état</strong>, donc sans polluer le
            board. On les traite ensuite une par une.
          </Lede>

          <H>Les trois issues d'une demande</H>
          <Defs
            rows={[
              [<>Acceptée</>, <>Elle devient un work item ordinaire, avec un état, et rejoint le board.</>],
              [<>Refusée</>, <>Elle est classée sans suite, avec sa raison. Elle reste consultable.</>],
              [<>Doublon</>, <>Elle est rattachée à l'item qui la couvre déjà.</>],
            ]}
          />

          <Callout kind="warn">
            Une demande en attente n'apparaît <strong>nulle part ailleurs</strong> :
            ni dans les work items, ni dans les statistiques, ni dans <Ui>Mon
            travail</Ui>. C'est voulu — mais cela signifie qu'un Intake qu'on ne
            visite jamais est un trou noir. Regardez-le une fois par semaine.
          </Callout>
        </>
      ),
    },

    {
      slug: "drafts-archives",
      title: "Brouillons et archives",
      summary: "Ce qui n'est pas encore publié, et ce qui a quitté le board.",
      keywords: ["brouillons", "archives", "archiver", "restaurer", "supprimer"],
      body: () => (
        <>
          <Lede>
            Deux écrans pour deux moments opposés : avant l'existence publique d'un
            item, et après.
          </Lede>

          <H>Brouillons</H>
          <P>
            Un work item commencé et non enregistré devient un brouillon. Il n'est
            visible que de vous, n'a pas de référence, n'apparaît sur aucun board.
            L'ouvrir reprend la saisie là où elle s'était arrêtée.
          </P>

          <H>Archives</H>
          <P>
            Archiver retire un item — ou un cycle, ou un module — de tous les écrans
            de travail sans le détruire. C'est la bonne réponse à « on ne le fera
            pas, mais je ne veux pas perdre la trace ».
          </P>
          <UL>
            <LI>Un item archivé garde sa référence, ses commentaires et son historique.</LI>
            <LI>Il se <strong>restaure</strong> d'un clic, et revient dans l'état où il était.</LI>
            <LI>La suppression définitive, elle, est irréversible et se trouve dans les réglages du projet.</LI>
          </UL>
        </>
      ),
    },

    {
      slug: "analytics",
      title: "Analytics du projet",
      summary: "La répartition du travail, les tendances, les points de blocage.",
      keywords: ["analytics", "statistiques", "graphiques", "rapport", "mesures"],
      body: () => (
        <>
          <Lede>
            Ce que les listes ne montrent pas : la forme d'ensemble. Combien d'items
            par état, par assigné, par label ; combien terminés par semaine ; combien
            en retard.
          </Lede>

          <Figure caption="Le board dit ce qu'il y a à faire ; l'analytique dit si la répartition tient debout.">
            <BoardFigure />
          </Figure>

          <UL>
            <LI><strong>Répartition</strong> — par état, priorité, assigné, label, cycle ou module. C'est le graphique qui révèle qu'une personne porte la moitié du projet.</LI>
            <LI><strong>Tendance</strong> — créés contre terminés dans le temps. Si la première courbe monte plus vite que la seconde, la dette de travail grossit.</LI>
            <LI><strong>Retards</strong> — les échéances dépassées, groupées par responsable.</LI>
          </UL>

          <Callout>
            Les mêmes mesures existent au niveau du service, tous projets confondus,
            dans <Ui>Analytics</Ui> de la famille « Espace ».
          </Callout>
        </>
      ),
    },

    {
      slug: "project-settings",
      title: "Réglages du projet",
      summary: "États, labels, estimations, membres, sections actives.",
      keywords: ["réglages", "paramètres", "états", "labels", "estimations", "membres"],
      body: () => (
        <>
          <Lede>
            Tout ce qui définit le vocabulaire du projet. Ces réglages sont propres au
            projet : deux projets du même service peuvent avoir des états différents.
          </Lede>

          <Defs
            rows={[
              [<>États</>, <>Vos propres noms d'étapes, rangés dans cinq <strong>groupes</strong> : backlog, à faire, en cours, terminé, annulé. Le groupe compte plus que le nom — c'est lui que lisent le burndown et les statistiques.</>],
              [<>Labels</>, <>Des étiquettes transversales, avec leur couleur. Un item peut en porter plusieurs.</>],
              [<>Estimations</>, <>Une échelle de charge : points, t-shirt sizes, heures. Une seule échelle active à la fois.</>],
              [<>Membres</>, <>Qui travaille sur le projet, et à quel rang. Voir l'article <strong>Équipage</strong>.</>],
              [<>Sections</>, <>Activer ou désactiver Cycles, Modules, Vues, Pages, Intake. Une section désactivée disparaît de la navigation.</>],
            ]}
          />

          <Callout kind="warn" title="Renommer un état est sans danger, changer son groupe non">
            Le nom est décoratif ; le groupe est structurel. Faire passer « En
            relecture » de « en cours » à « terminé » modifie rétroactivement tous
            les burndowns et tous les taux d'avancement du projet.
          </Callout>
        </>
      ),
    },
  ],
};
