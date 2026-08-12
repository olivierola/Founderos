"use client";

import { motion, useInView, type Variants } from "framer-motion";
import type { ReactNode, RefObject } from "react";

/**
 * Révélation en cascade pilotée par UN SEUL conteneur.
 *
 * Chaque enfant observe le même `timelineRef` et reçoit son rang via `custom`,
 * ce qui laisse les variantes calculer leur propre délai. C'est ce qui distingue
 * ce composant d'un `whileInView` par élément : les cartes s'enchaînent dans
 * l'ordre voulu même si elles entrent dans le viewport en même temps, et une
 * carte déjà visible au chargement ne se déclenche pas seule.
 *
 * NOTE : le composant d'origine importe `motion/react`. Ce projet est sur
 * framer-motion v12, dont l'API est identique — on garde donc l'import du repo
 * plutôt que d'ajouter un paquet qui fait la même chose.
 */

const TAGS = {
  div: motion.div,
  span: motion.span,
  h1: motion.h1,
  h2: motion.h2,
  h3: motion.h3,
  p: motion.p,
  li: motion.li,
  section: motion.section,
} as const;

export type TimelineTag = keyof typeof TAGS;

export interface TimelineContentProps {
  children?: ReactNode;
  /** Rang dans la cascade — passé aux variantes via `custom`. */
  animationNum: number;
  /** Conteneur observé. Tous les enfants d'une même séquence partagent le sien. */
  timelineRef: RefObject<HTMLElement | null>;
  customVariants?: Variants;
  className?: string;
  as?: TimelineTag;
  /** false = rejoue l'animation à chaque passage. */
  once?: boolean;
  style?: React.CSSProperties;
}

const DEFAULT_VARIANTS: Variants = {
  visible: (i: number) => ({
    y: 0,
    opacity: 1,
    filter: "blur(0px)",
    transition: { delay: i * 0.1, duration: 0.5 },
  }),
  hidden: { filter: "blur(10px)", y: -20, opacity: 0 },
};

export function TimelineContent({
  children,
  animationNum,
  timelineRef,
  customVariants,
  className,
  as = "div",
  once = true,
  style,
}: TimelineContentProps) {
  // `amount: 0.1` plutôt que le défaut : une grille de cartes plus haute que le
  // viewport ne se déclencherait jamais si on attendait qu'elle soit entière.
  const inView = useInView(timelineRef, { once, amount: 0.1 });
  const Tag = TAGS[as];

  return (
    <Tag
      custom={animationNum}
      initial="hidden"
      animate={inView ? "visible" : "hidden"}
      variants={customVariants ?? DEFAULT_VARIANTS}
      className={className}
      style={style}
    >
      {children}
    </Tag>
  );
}

export default TimelineContent;
