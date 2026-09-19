import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
// Le format du jeton vient du langage partagé : c'est le compilateur qui le
// résout, et deux écritures du même format finiraient par diverger.
import { chipToken } from "./context";

// Une ligne de procédure : du texte, et des blocs POSÉS DEDANS.
//
// C'est la différence entre « charge le contexte, puis demande la commande » et
// « demande la commande [Get order info] puis confirme au client ». La première
// forme est celle qu'un canevas impose — une carte avant une autre carte. La
// seconde est celle qu'on écrit vraiment, et elle a besoin que le bloc puisse
// vivre AU MILIEU d'une phrase.
//
// D'où un contenteditable plutôt qu'un textarea. Trois règles le rendent
// gérable, parce qu'un contenteditable contrôlé par React est une source
// classique de curseurs qui sautent :
//
//   1. Il est NON CONTRÔLÉ. On n'écrit dans le DOM que si la valeur entrante
//      diffère de la dernière qu'on a émise — donc jamais pendant la frappe.
//   2. Les pastilles sont des `contenteditable="false"` avec un `data-chip` :
//      le navigateur les traite comme un caractère, et la sérialisation les
//      relit comme le jeton `{{b:id}}` que le compilateur comprend.
//   3. Les clics sur une pastille passent par DÉLÉGATION sur le conteneur. Sans
//      ça il faudrait monter du React à l'intérieur d'un innerHTML, ce qui
//      redevient un contenteditable contrôlé par la bande.

export interface ChipInfo {
  id: string;
  /** Le verbe, en gras : « Utilise », « Contexte », « Produit »… */
  verb: string;
  label: string;
  /** Teinte du point, alignée sur la couleur du bloc dans le catalogue. */
  color: string;
}

const CHIP_RE = /\{\{b:([A-Za-z0-9_-]+)\}\}/g;
export { chipToken };

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Le HTML d'une pastille. Écrit à la main plutôt que rendu par React : il vit
 *  à l'intérieur d'un innerHTML, et une pastille est un atome — elle n'a pas
 *  d'état propre à re-rendre. */
function chipHtml(info: ChipInfo | undefined, id: string): string {
  const verb = escapeHtml(info?.verb ?? "Bloc");
  const label = escapeHtml(info?.label ?? "supprimé");
  const color = info?.color ?? "#94a3b8";
  return (
    `<span class="wf-chip" data-chip="${escapeHtml(id)}" contenteditable="false">` +
    `<span class="wf-chip-dot" style="background:${escapeHtml(color)}"></span>` +
    `<b>${verb}</b>` +
    `<span class="wf-chip-label">${label}</span>` +
    `<span class="wf-chip-menu" data-chip-menu="${escapeHtml(id)}">⋮</span>` +
    `</span>`
  );
}

/** Remettre à jour les pastilles déjà présentes, sans toucher au reste.
 *
 *  C'est la seule modification du DOM autorisée pendant la frappe : remplacer
 *  l'innerHTML complet replacerait le curseur au début de la ligne. Ici on
 *  n'écrit que dans des `contenteditable="false"`, où le curseur ne peut pas
 *  se trouver. */
function refreshChips(root: HTMLElement, chips: Map<string, ChipInfo>) {
  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-chip]"))) {
    const id = el.getAttribute("data-chip")!;
    const next = chipHtml(chips.get(id), id);
    // On compare la pastille entière puis on remplace son contenu : le nœud
    // lui-même doit survivre, c'est lui que la sélection encadre.
    const holder = document.createElement("div");
    holder.innerHTML = next;
    const fresh = holder.firstElementChild as HTMLElement | null;
    if (!fresh || fresh.innerHTML === el.innerHTML) continue;
    el.innerHTML = fresh.innerHTML;
  }
}

function toHtml(value: string, chips: Map<string, ChipInfo>): string {
  let out = "";
  let last = 0;
  for (const m of value.matchAll(CHIP_RE)) {
    out += escapeHtml(value.slice(last, m.index!)).replace(/\n/g, "<br>");
    out += chipHtml(chips.get(m[1]), m[1]);
    last = m.index! + m[0].length;
  }
  out += escapeHtml(value.slice(last)).replace(/\n/g, "<br>");
  return out;
}

/** Le DOM relu comme du texte + des jetons. On marche l'arbre plutôt que de
 *  lire `innerText` : innerText perd les pastilles, qui n'ont pas de texte
 *  propre à rendre. */
function serialize(root: HTMLElement): string {
  let out = "";
  const walk = (n: ChildNode) => {
    if (n.nodeType === Node.TEXT_NODE) { out += n.textContent ?? ""; return; }
    if (!(n instanceof HTMLElement)) return;
    const chip = n.getAttribute("data-chip");
    if (chip) { out += chipToken(chip); return; }
    if (n.tagName === "BR") { out += "\n"; return; }
    const block = /^(DIV|P)$/.test(n.tagName);
    if (block && out && !out.endsWith("\n")) out += "\n";
    n.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
  // Le navigateur ajoute volontiers un <br> final dans un contenteditable vide.
  return out.replace(/\n+$/, "");
}

export interface SlashOption {
  id: string;
  label: string;
  hint?: string;
  color?: string;
  /** L'intertitre sous lequel l'option se range. Les options d'un même groupe
   *  doivent se suivre — le rendu ne trie pas, il coupe quand le groupe change. */
  group?: string;
  /** Rendu en tête de liste, séparé — « créer un nouveau… ». */
  create?: boolean;
}

/**
 * L'invite d'une ligne vide, qui fait défiler ce qu'on peut y faire.
 *
 * Une ligne neuve ne montre rien : ni que `/` ouvre un menu, ni qu'on peut y
 * poser un outil ou un agent. Ces gestes ne se devinent pas, et une note d'aide
 * posée à côté encombrerait le document en permanence pour n'être lue qu'une
 * fois. Ici, l'invite occupe la place déjà vide, et disparaît au premier
 * caractère.
 *
 * Elle s'immobilise sur la première phrase si le système demande à réduire les
 * animations : du texte qui change tout seul est exactement ce que ce réglage
 * existe pour empêcher.
 */
function CyclingHint({ hints }: { hints: string[] }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (hints.length < 2) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setI((v) => (v + 1) % hints.length), 3400);
    return () => clearInterval(t);
  }, [hints.length]);

  return (
    <span key={i} className="wf-hint inline-block">
      {hints[i % hints.length]}
    </span>
  );
}

export function RichLine({
  value, chips, onChange, onChipMenu, placeholder, slashOptions, onSlashPick,
  className, autoFocus, onFocus,
}: {
  value: string;
  chips: Map<string, ChipInfo>;
  onChange: (v: string) => void;
  /** Le ⋮ d'une pastille, avec l'élément pour ancrer le menu. */
  onChipMenu: (chipId: string, anchor: HTMLElement) => void;
  /** Une chaîne, ou plusieurs : plusieurs défilent, pour montrer sur la place
   *  déjà vide ce que la ligne sait faire. */
  placeholder?: string | string[];
  slashOptions: SlashOption[];
  /** Retourne le jeton à insérer, ou null si l'action ouvre autre chose. */
  onSlashPick: (optionId: string) => string | null;
  className?: string;
  autoFocus?: boolean;
  onFocus?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  /** Le conteneur positionné : le menu s ancre dessus. */
  const wrapRef = useRef<HTMLDivElement>(null);
  /** La dernière valeur que CE composant a produite. Tant que la valeur
   *  entrante lui est égale, le DOM est déjà juste et on n'y touche pas — c'est
   *  ce qui empêche le curseur de repartir au début à chaque frappe. */
  const emitted = useRef<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; query: string } | null>(null);
  const [active, setActive] = useState(0);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Deux raisons de réécrire le DOM, et une seule interdiction.
    //
    // Réécrire : le texte vient d'ailleurs (chargement, annulation, écriture de
    // l'assistant), ou une pastille a changé de nom parce qu'on vient de régler
    // le bloc qu'elle désigne.
    //
    // Interdiction : jamais pendant la frappe. Remplacer l'innerHTML replace le
    // curseur au début, et une ligne qui renvoie le curseur au début à chaque
    // caractère est inutilisable. Le champ ayant le focus est donc laissé
    // tranquille tant que sa valeur est celle qu'il a lui-même produite.
    const same = value === emitted.current;
    const focused = document.activeElement === el;
    // Le champ a le focus et le texte est celui qu'il a produit : on ne
    // reconstruit rien, mais les pastilles peuvent avoir changé de nom — c'est
    // le cas juste après en avoir posé une, puisque le bloc qu'elle désigne
    // vient d'être créé. On rafraîchit alors leur contenu SEUL, ce qui laisse
    // les nœuds de texte (et donc le curseur) exactement où ils sont.
    if (same && focused) { refreshChips(el, chips); return; }
    const html = toHtml(value, chips);
    if (el.innerHTML === html) { emitted.current = value; return; }
    if (focused) { refreshChips(el, chips); return; }
    el.innerHTML = html;
    emitted.current = value;
  }, [value, chips]);

  useEffect(() => { if (autoFocus) ref.current?.focus(); }, [autoFocus]);

  const emit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const next = serialize(el);
    emitted.current = next;
    onChange(next);
  }, [onChange]);

  /** Le texte qui précède le curseur dans son propre nœud — c'est là qu'on
   *  cherche le `/` et ce qui a été tapé derrière. */
  const readQuery = (): { text: string; node: Text; start: number } | null => {
    const sel = window.getSelection();
    if (!sel || !sel.isCollapsed || sel.rangeCount === 0) return null;
    const node = sel.anchorNode;
    if (!node || node.nodeType !== Node.TEXT_NODE) return null;
    const before = (node.textContent ?? "").slice(0, sel.anchorOffset);
    const slash = before.lastIndexOf("/");
    if (slash < 0) return null;
    // Un `/` collé à un mot (une URL, une date) n'ouvre pas de menu.
    if (slash > 0 && !/\s/.test(before[slash - 1])) return null;
    const q = before.slice(slash + 1);
    if (/\s/.test(q)) return null;
    return { text: q, node: node as Text, start: slash };
  };

  /**
   * Ouvrir le menu SOUS le curseur.
   *
   * Les coordonnées sont relatives au conteneur de la ligne, pas à l'écran. Le
   * menu était positionné en `fixed` à partir d'un rect de viewport : il restait
   * donc planté au même endroit de l'écran pendant que le document défilait
   * sous lui, et se retrouvait à côté d'une tout autre ligne. Ancré en
   * `absolute` dans le conteneur, il suit naturellement.
   */
  const openMenuAtCaret = (query: string) => {
    const sel = window.getSelection();
    const host = wrapRef.current;
    if (!sel || sel.rangeCount === 0 || !host) return;
    const caret = sel.getRangeAt(0).getBoundingClientRect();
    const box = host.getBoundingClientRect();
    setMenu({ x: caret.left - box.left, y: caret.bottom - box.top, query });
    setActive(0);
  };

  const insertChip = (token: string) => {
    const el = ref.current;
    const q = readQuery();
    if (!el) return;
    if (q) {
      // On efface `/requête` avant d'insérer, sinon la pastille arrive derrière
      // le texte qui a servi à la choisir.
      const range = document.createRange();
      range.setStart(q.node, q.start);
      range.setEnd(q.node, q.start + 1 + q.text.length);
      range.deleteContents();
      const holder = document.createElement("span");
      holder.innerHTML = toHtml(`${token} `, chips);
      const frag = document.createDocumentFragment();
      while (holder.firstChild) frag.appendChild(holder.firstChild);
      const lastNode = frag.lastChild;
      range.insertNode(frag);
      // Curseur APRÈS la pastille : sans ça la frappe suivante entre dedans.
      const sel = window.getSelection();
      if (sel && lastNode) {
        const after = document.createRange();
        after.setStartAfter(lastNode);
        after.collapse(true);
        sel.removeAllRanges();
        sel.addRange(after);
      }
    } else {
      el.innerHTML += toHtml(` ${token} `, chips);
    }
    setMenu(null);
    emit();
  };

  // La recherche porte sur le libellé ET sur le groupe : taper « conn » doit
  // trouver les collections de connaissances, dont aucune ne s'appelle ainsi.
  const filtered = menu
    ? slashOptions.filter((o) => {
        const q = menu.query.trim().toLowerCase();
        if (!q) return true;
        return `${o.label} ${o.group ?? ""} ${o.hint ?? ""}`.toLowerCase().includes(q);
      })
    : [];

  const pick = (optionId: string) => {
    const token = onSlashPick(optionId);
    if (token) insertChip(token);
    else {
      // L'option ouvre un panneau : on retire quand même le `/requête`, sinon
      // il reste dans la phrase comme une coquille.
      const q = readQuery();
      if (q) {
        const range = document.createRange();
        range.setStart(q.node, q.start);
        range.setEnd(q.node, q.start + 1 + q.text.length);
        range.deleteContents();
        emit();
      }
      setMenu(null);
    }
  };

  return (
    <div ref={wrapRef} className="relative">
      {/* Le placeholder est rendu par-dessus plutôt qu'en `:empty::before` :
          un contenteditable qu'on vide garde presque toujours un `<br>`, donc
          `:empty` cesse de matcher et l'invite disparaît pour de bon. */}
      {!value && placeholder && (
        <span className="pointer-events-none absolute inset-0 select-none truncate text-muted-foreground/60">
          {Array.isArray(placeholder) ? <CyclingHint hints={placeholder} /> : placeholder}
        </span>
      )}
      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        onFocus={onFocus}
        onInput={() => {
          emit();
          const q = readQuery();
          if (q) openMenuAtCaret(q.text); else setMenu(null);
        }}
        onBlur={() => { emit(); setTimeout(() => setMenu(null), 120); }}
        onKeyDown={(e) => {
          if (menu && filtered.length) {
            if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => (i + 1) % filtered.length); return; }
            if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => (i - 1 + filtered.length) % filtered.length); return; }
            if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(filtered[active].id); return; }
          }
          if (e.key === "Escape") { setMenu(null); return; }
          // Entrée termine la ligne au lieu d'ouvrir un paragraphe : une étape
          // est une phrase, pas un document. Shift+Entrée pour un vrai retour.
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); (e.target as HTMLElement).blur(); }
        }}
        onClick={(e) => {
          const el = (e.target as HTMLElement).closest?.("[data-chip-menu]") as HTMLElement | null;
          if (!el) return;
          e.preventDefault();
          e.stopPropagation();
          onChipMenu(el.getAttribute("data-chip-menu")!, el.parentElement ?? el);
        }}
        onPaste={(e) => {
          // Coller du HTML dans un contenteditable importe des styles, des
          // tableaux, parfois des scripts. On ne garde que le texte.
          e.preventDefault();
          const text = e.clipboardData.getData("text/plain");
          document.execCommand("insertText", false, text);
        }}
        className={cn("wf-richline", className)}
      />

      {menu && (
        <div
          className="absolute z-50 w-72 overflow-hidden rounded-xl border border-border bg-popover shadow-lg"
          style={{ left: menu.x, top: menu.y + 6 }}
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="max-h-80 overflow-y-auto py-1">
            {filtered.length === 0 && (
              <p className="px-3 py-2 text-xs text-muted-foreground">Rien ne correspond à « {menu.query} ».</p>
            )}
            {filtered.map((o, i) => (
              <div key={o.id}>
                {/* L'intertitre apparaît au CHANGEMENT de groupe. Avec une
                    recherche en cours, les groupes se réduisent parfois à une
                    ligne — c'est voulu : savoir qu'un résultat est une
                    collection et pas un outil vaut mieux qu'une liste plate. */}
                {o.group && o.group !== filtered[i - 1]?.group && (
                  <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
                    {o.group}
                  </p>
                )}
                <button
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(o.id)}
                  className={cn(
                    "flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm",
                    i === active ? "bg-muted" : "hover:bg-muted/60",
                  )}
                >
                  <span
                    className={cn("h-2 w-2 shrink-0 rounded-full", o.create && "ring-1 ring-inset ring-current")}
                    style={{ background: o.create ? "transparent" : (o.color ?? "hsl(var(--muted-foreground))"), color: o.color }}
                  />
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {o.hint && <span className="max-w-[45%] shrink-0 truncate text-[10px] text-muted-foreground">{o.hint}</span>}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
