import { useMemo } from "react";
import { BotAvatar, type BotAvatarState } from "bot-avatars";
import { cn } from "@/lib/utils";
import { BOT_PREFIX, autoBody, botAvatarLookProps, nameHash, parseBotLook } from "@/lib/bot-avatar-look";
import { HUMAN_PREFIX, parseHumanLook } from "@/lib/human-avatar-look";
import { HumanAvatar } from "@/components/human-avatar/HumanAvatar";

// An agent's visual identity: an ANIMATED bot (bot-avatars) rather than the
// frozen DiceBear portrait it used to be. One component, so every surface —
// roster, room thread, chat header, mission cards — shows the same agent as
// the same creature.
//
// What the avatar studio chose — body, colour, texture, hat… — is read from
// `avatar_url` (see bot-avatar-look.ts), and from nothing else: not from the
// agent's accent, which only some surfaces passed, so one agent came out in
// two colours. Left unchosen, the body is derived from the agent's name and
// wears its own colour; the animation offset always is, so a row of them never
// blinks in unison. A portrait the user actually uploaded still wins: it is
// their choice, not a default.
//
// The studio also makes 3D humanoids (`human:…`, see human-avatar-look.ts),
// on the same contract — the value says everything, the name fills the gaps
// — drawn by the shared WebGL engine, with the bot standing in when the
// browser gives no WebGL.

const GENERATED_HOSTS = ["dicebear.com", "api.dicebear"];

/** True for the auto-assigned portrait services — those are the "frozen
 *  avatars" the bots replace, as opposed to a real uploaded image. */
function isGeneratedPortrait(url: string | null | undefined): boolean {
  if (!url) return true;
  if (url.startsWith(BOT_PREFIX) || url.startsWith(HUMAN_PREFIX)) return true;
  return GENERATED_HOSTS.some((h) => url.includes(h));
}

export function AgentIdentity({
  url, seed, size = 32, rounded = "rounded-2xl", className, state = "default",
  face = "eyes", interactive = true, paused, framing,
}: {
  style?: "avatar" | "orb" | null;
  url?: string | null;
  /** Identity of the agent — its name or id. Picks the body and the offset. */
  seed?: string;
  size?: number;
  /** Tailwind rounding, applied to an uploaded portrait (a bot needs none). */
  rounded?: string;
  className?: string;
  /** What the agent is doing: working = hops and spins, sleeping = at rest. */
  state?: BotAvatarState;
  /** The face, when the studio did not choose one. */
  face?: "eyes" | "mouth";
  /** The eyes follow the pointer and a click makes it hop. Off in dense lists. */
  interactive?: boolean;
  paused?: boolean;
  /** A person only: the head and shoulders, or the bust. By default the head
   *  below 48 px, where a whole bust would leave a face of a few pixels. */
  framing?: "head" | "bust";
  glow?: boolean;
  lightOrb?: boolean;
}) {
  const key = seed || "agent";
  const { look, human, offset } = useMemo(() => ({
    look: botAvatarLookProps(parseBotLook(url) ?? {}, autoBody(key)),
    human: parseHumanLook(url),
    offset: ((nameHash(key) >>> 8) % 1000) / 1000,
  }), [key, url]);

  // A portrait the user uploaded stays a portrait.
  if (url && !isGeneratedPortrait(url)) {
    return (
      <span
        className={cn("inline-block shrink-0 overflow-hidden", rounded, className)}
        style={{ width: size, height: size }}
      >
        <img src={url} alt="" className="h-full w-full object-cover" loading="lazy" draggable={false} />
      </span>
    );
  }

  // Two things the library's own box does not give us:
  //
  //  · SHARPNESS. It sizes its canvas from the element's box, so asking for a
  //    bigger `size` and shrinking it with width/height changes nothing. Scaled
  //    down with a transform, the box stays big and the backing store with it —
  //    a real 2× supersample. Only worth it where it shows: a screen without
  //    device pixels to spare, and an avatar big enough to read.
  //  · FOOTPRINT. The canvas is 1.5× the body (room for the hop). Left in the
  //    flow it pushed everything around; centred in a box of exactly `size`, the
  //    body matches the portraits it replaces and the jump just overflows.
  // Netteté : la lib cale le backing canvas à `size × min(2, dpr)`. Sur un écran
  // standard (dpr 1) un petit avatar n'est donc pas suréchantillonné et bave.
  // On rend volontairement plus grand puis on réduit en CSS pour viser ~3× de
  // backing partout, quel que soit l'écran (vrai supersampling).
  // Plafonné pour les GRANDS avatars, et serré : chaque image de l'animation
  // redessine tout le canvas puis l'envoie à la carte graphique, et ce coût
  // croît avec le carré de la taille de rendu — la fourrure, calculée à cette
  // taille, aussi. Une grille de cartes à 100 px rendues à 216 (×1,5 de marge
  // pour le saut, ×dpr) ramait au point que les sauts paraissaient au ralenti.
  // Au-delà de ~32 px, les pixels de l'écran suffisent à la netteté : le
  // suréchantillonnage décroît avec la taille et s'éteint vers 96 px.
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const libMult = Math.min(2, dpr);
  const MAX_RENDER_PX = 96;
  // Arrondi au centième, comme avant : la taille de rendu fait partie de la
  // clé de cache de la librairie, une valeur flottante instable la viderait.
  const ss = Math.max(1, Math.round(Math.min(3 / libMult, MAX_RENDER_PX / (size * libMult)) * 100) / 100);

  const bot = (
    <span
      className="absolute left-1/2 top-1/2 leading-none"
      style={{ transform: `translate(-50%, -50%) scale(${1 / ss})` }}
    >
      <BotAvatar
        face={face}
        {...look}
        state={state}
        size={size * ss}
        seed={offset}
        interactive={interactive}
        paused={paused}
        aria-label={seed ? `${seed}, avatar` : "Avatar"}
      />
    </span>
  );

  return (
    <span
      className={cn("relative inline-block shrink-0 align-middle", className)}
      style={{ width: size, height: size }}
    >
      {human ? (
        <HumanAvatar
          look={human}
          seed={key}
          size={size}
          state={state}
          interactive={interactive}
          paused={paused}
          closeUp={framing ? framing === "head" : undefined}
          fallback={bot}
          label={seed ? `${seed}, avatar` : "Avatar"}
        />
      ) : bot}
    </span>
  );
}
