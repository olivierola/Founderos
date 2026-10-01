import { useRef, useState } from "react";
import type { Node } from "reactflow";
import {
  PlusIcon as Plus,
  XIcon as X,
  CodeIcon as Code2,
  ArrowLineRightIcon as ArrowRightToLine,
} from "@phosphor-icons/react";
import { cn } from "@/lib/utils";
import { Picker } from "./inspector-ui";
import { patchBlock } from "./outline";
import { codeToolOf, cleanArgs } from "./model";
import type { Ctx } from "./editor-ctx";

// Les champs PROPRES à une automatisation : le code d'une étape, le nom sous
// lequel son résultat est rangé, ses paramètres, sa politique d'échec, et la
// condition d'une bifurcation.
//
// Ils vivaient dans les lignes du document, qui en était le seul lecteur. La
// vue graphe édite les mêmes blocs : sans eux, on pouvait câbler une action sur
// le canevas mais pas lui écrire son code ni nommer sa sortie — il aurait fallu
// rebasculer sur le document pour la moitié des réglages, ce qui aurait fait de
// la carte une jolie consultation plutôt qu'un éditeur.

/**
 * Écrire le code d'une étape, sur la ligne.
 *
 * Un outil se CHOISIT ; du code s'ÉCRIT. Un champ « paramètres » n'a aucun sens
 * pour lui — le paramètre, c'est le programme. Et le mettre dans un panneau
 * qu'il faut ouvrir masquerait ce que l'étape fait réellement, alors que c'est
 * la seule chose qu'on veut relire.
 *
 * Les variables déjà nommées plus haut sont proposées au-dessus : le vrai
 * obstacle n'est pas d'écrire `{{deals}}`, c'est de se rappeler que `deals`
 * existe sans aller relire les étapes précédentes.
 */
export function CodeEditor({ node, ctx, vars }: { node: Node; ctx: Ctx; vars: string[] }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const d = (node.data ?? {}) as Record<string, unknown>;
  const lang = codeToolOf(d);
  const code = String(d.code ?? "");
  if (!lang) return null;

  const write = (next: string) => ctx.apply((g) => patchBlock(g, node.id, { code: next }));

  /** Poser `{{nom}}` au curseur, pas à la fin : on insère une variable au
   *  milieu d'une ligne qu'on est en train d'écrire. */
  const insertVar = (name: string) => {
    const el = ref.current;
    const token = `{{${name}}}`;
    if (!el) { write(code + token); return; }
    const a = el.selectionStart ?? code.length;
    const b = el.selectionEnd ?? a;
    const next = code.slice(0, a) + token + code.slice(b);
    write(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + token.length, a + token.length);
    });
  };

  return (
    <div className="mt-1.5 overflow-hidden rounded-xl border border-border bg-muted/20">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-2.5 py-1.5">
        <Code2 className="h-3.5 w-3.5 text-blue-400" />
        <span className="text-[11px] font-medium">{lang.label}</span>
        {vars.length > 0 && (
          <>
            <span className="ml-1 text-[11px] text-muted-foreground">insérer</span>
            {vars.map((v) => (
              <button
                key={v} type="button" onClick={() => insertVar(v)}
                title={`Insérer {{${v}}}`}
                className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
              >{v}</button>
            ))}
          </>
        )}
        <span className="ml-auto">
          <OutputVarPill node={node} ctx={ctx} />
        </span>
      </div>
      <textarea
        ref={ref}
        value={code}
        onChange={(e) => write(e.target.value)}
        onKeyDown={(e) => {
          // Tab indente au lieu de quitter le champ : dans un éditeur de code,
          // perdre le focus sur Tab rend l'indentation impossible.
          if (e.key !== "Tab") return;
          e.preventDefault();
          const el = e.currentTarget;
          const a = el.selectionStart, b = el.selectionEnd;
          write(code.slice(0, a) + "  " + code.slice(b));
          requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2));
        }}
        rows={Math.max(3, Math.min(code.split("\n").length + 1, 20))}
        spellCheck={false}
        placeholder={lang.language === "python"
          ? "deals = {{deals}}\nretenus = [d for d in deals if d['amount'] > 1000]\nretenus"
          : "// La dernière expression est le résultat."}
        className="w-full resize-y bg-transparent px-3 py-2.5 font-mono text-[12.5px] leading-relaxed outline-none placeholder:text-muted-foreground/40"
      />
    </div>
  );
}

export function OutputVarPill({ node, ctx }: { node: Node; ctx: Ctx }) {
  const d = (node.data ?? {}) as Record<string, unknown>;
  const raw = String(d.output_var ?? "");
  const [editing, setEditing] = useState(false);

  if (!raw && !editing) {
    return (
      <button
        type="button" onClick={() => setEditing(true)}
        title="Ranger le résultat dans une variable"
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
      ><ArrowRightToLine className="h-3 w-3" /> variable</button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-[12px]">
      <ArrowRightToLine className="h-3 w-3 text-muted-foreground" />
      <input
        autoFocus={editing}
        value={raw}
        onChange={(e) => ctx.apply((g) => patchBlock(g, node.id, { output_var: e.target.value }))}
        onBlur={() => setEditing(false)}
        placeholder="nom"
        size={Math.max(6, Math.min(raw.length + 1, 24))}
        className="bg-transparent font-mono text-[12px] outline-none placeholder:text-muted-foreground/50"
      />
    </span>
  );
}

export function ArgPills({ node, ctx }: { node: Node; ctx: Ctx }) {
  const d = (node.data ?? {}) as Record<string, unknown>;
  if (node.type !== "tool") return null;
  // Un outil qui exécute du code n'a pas de paramètres : son paramètre EST le
  // programme, écrit sur la ligne.
  if (codeToolOf(d)) return <OutputVarPill node={node} ctx={ctx} />;
  const args = (d.args ?? {}) as Record<string, unknown>;
  const entries = Object.entries(args);

  /**
   * Réécrire la table ENTIÈRE à partir des paires.
   *
   * Deux raisons. Renommer une clé autrement la déplacerait à la fin, alors que
   * l'ordre est celui dans lequel on les a écrites. Et une paire dont la clé
   * n'est pas encore tapée doit SURVIVRE : la filtrer ici ferait disparaître le
   * paramètre à l'instant où on l'ajoute. Ce sont `toolCall` et le moteur qui
   * écartent les paires incomplètes, au moment où elles comptent vraiment.
   */
  const write = (pairs: Array<[string, unknown]>) =>
    ctx.apply((g) => patchBlock(g, node.id, { args: Object.fromEntries(pairs) }));

  const grow = (v: string, min = 3, max = 24) => Math.max(min, Math.min(v.length + 1, max));

  return (
    <>
      {entries.map(([name, value], i) => (
        <span
          key={i}
          className="group/arg inline-flex items-center gap-0.5 rounded-md bg-muted/60 px-1.5 py-0.5 text-[12px]"
        >
          <input
            value={name}
            onChange={(e) => write(entries.map((p, j) => (j === i ? [e.target.value, p[1]] : p)))}
            size={grow(name)}
            placeholder="param"
            className="bg-transparent font-mono text-[11px] text-muted-foreground outline-none"
          />
          <span className="text-muted-foreground/60">=</span>
          <input
            value={String(value ?? "")}
            onChange={(e) => write(entries.map((p, j) => (j === i ? [p[0], e.target.value] : p)))}
            size={grow(String(value ?? ""), 4, 28)}
            placeholder="valeur"
            className="bg-transparent font-mono text-[12px] outline-none"
          />
          <button
            type="button"
            onClick={() => write(entries.filter((_, j) => j !== i))}
            title="Retirer ce paramètre"
            className="ml-0.5 rounded text-muted-foreground/60 opacity-0 transition-opacity hover:text-destructive group-hover/arg:opacity-100"
          ><X className="h-3 w-3" /></button>
        </span>
      ))}
      <button
        type="button"
        onClick={() => write([...entries, ["", ""]])}
        title="Ajouter un paramètre"
        className="inline-flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground"
      ><Plus className="h-3 w-3" /></button>
      <OutputVarPill node={node} ctx={ctx} />
    </>
  );
}

/**
 * Ce que fait la chaîne quand CETTE étape échoue.
 *
 * Par défaut, elle s'arrête : continuer sur une valeur qui n'existe pas est
 * pire qu'un arrêt. Mais une étape accessoire (prévenir Slack, écrire un
 * journal) ne devrait pas coûter toute l'automatisation — celle-là peut
 * continuer, et les étapes suivantes testent `steps.<id>.error`.
 * Les nouveaux essais ne concernent que les pannes passagères ; une écriture
 * n'est rejouée que si elle a été refusée avant d'être exécutée (le moteur y
 * veille, l'écran n'a pas à le demander).
 */
export function ErrorPolicy({ node, ctx }: { node: Node; ctx: Ctx }) {
  const d = (node.data ?? {}) as Record<string, unknown>;
  const onError = d.on_error === "continue" ? "continue" : "stop";
  const retries = d.retries == null || d.retries === "" ? "2" : String(d.retries);
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
      <span>En cas d'échec</span>
      <div className="w-56">
        <Picker
          value={onError}
          onChange={(v) => ctx.apply((g) => patchBlock(g, node.id, { on_error: v === "continue" ? "continue" : undefined }))}
          options={[
            { value: "stop", label: "Arrêter l'automatisation" },
            { value: "continue", label: "Continuer (étape accessoire)" },
          ]}
        />
      </div>
      <span>nouveaux essais</span>
      <div className="w-20">
        <Picker
          value={retries}
          onChange={(v) => ctx.apply((g) => patchBlock(g, node.id, { retries: Number(v) }))}
          options={["0", "1", "2", "3"].map((n) => ({ value: n, label: n }))}
        />
      </div>
    </div>
  );
}

/** Les opérateurs, repris du moteur — c'est lui qui les évalue, et une liste
 *  recopiée ici proposerait tôt ou tard un test que le moteur ne connaît pas. */
export const TEST_OPS: Array<{ id: string; label: string; needsRight: boolean }> = [
  { id: "equals", label: "est égal à", needsRight: true },
  { id: "not_equals", label: "est différent de", needsRight: true },
  { id: "contains", label: "contient", needsRight: true },
  { id: "not_contains", label: "ne contient pas", needsRight: true },
  { id: "gt", label: "est supérieur à", needsRight: true },
  { id: "lt", label: "est inférieur à", needsRight: true },
  { id: "exists", label: "existe", needsRight: false },
  { id: "empty", label: "est vide", needsRight: false },
];

type TestValue = { left?: string; op?: string; right?: string };

/**
 * Une condition en trois cases : une donnée, un opérateur, une valeur — et,
 * au besoin, plusieurs conditions reliées par « toutes » ou « au moins une ».
 *
 * Pauvre exprès. Le moteur n'interprète pas d'expression et n'appelle aucun
 * modèle : ce qui n'entre pas dans ces trois cases ne serait pas évaluable, et
 * un champ libre qui accepte tout produirait des conditions qui échouent
 * silencieusement à l'exécution.
 *
 * Écrit `tests` + `match`, et recopie la première dans `test` : tout ce qui
 * lisait une condition unique (revue de l'assistant, anciens runs) continue
 * de la trouver.
 */
export function TestEditor({ node, ctx }: { node: Node; ctx: Ctx }) {
  const d = (node.data ?? {}) as Record<string, unknown>;
  const tests: TestValue[] = Array.isArray(d.tests) && (d.tests as TestValue[]).length
    ? (d.tests as TestValue[])
    : [((d.test ?? {}) as TestValue)];
  const match = d.match === "any" ? "any" : "all";
  const write = (next: TestValue[], m: string = match) =>
    ctx.apply((g) => patchBlock(g, node.id, { tests: next, test: next[0] ?? {}, match: m }));

  return (
    <div className="space-y-1.5">
      {tests.map((t, i) => (
        <div key={i} className="flex items-center gap-1.5">
          {tests.length > 1 && (
            <span className="w-14 shrink-0 text-right text-[11px] text-muted-foreground">
              {i === 0 ? "si" : match === "any" ? "ou" : "et"}
            </span>
          )}
          <TestRow
            node={node} ctx={ctx} test={t}
            onChange={(patch) => write(tests.map((x, j) => (j === i ? { ...x, ...patch } : x)))}
          />
          {tests.length > 1 && (
            <button
              type="button" title="Retirer cette condition"
              onClick={() => write(tests.filter((_, j) => j !== i))}
              className="shrink-0 rounded-md p-1 text-muted-foreground/60 hover:bg-muted hover:text-foreground"
            ><X className="h-3.5 w-3.5" /></button>
          )}
        </div>
      ))}
      <div className="flex items-center gap-2 pl-0.5">
        <button
          type="button"
          onClick={() => write([...tests, { op: "contains" }])}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground"
        ><Plus className="h-3 w-3" /> condition</button>
        {tests.length > 1 && (
          <div className="w-52">
            <Picker
              value={match}
              onChange={(v) => write(tests, v)}
              options={[
                { value: "all", label: "Toutes doivent être vraies" },
                { value: "any", label: "Au moins une suffit" },
              ]}
            />
          </div>
        )}
      </div>
    </div>
  );
}

export function TestRow({ node, ctx, test, onChange }: {
  node: Node; ctx: Ctx; test: TestValue; onChange: (patch: TestValue) => void;
}) {
  const op = TEST_OPS.find((o) => o.id === (test.op ?? "contains")) ?? TEST_OPS[2];
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 rounded-xl border border-border bg-background p-2">
      {/* Le champ reste libre — une condition porte souvent sur un sous-champ
          (`trigger.from`, `deals.total`) qu'aucune liste ne peut deviner. Mais
          les variables déjà nommées sont proposées : le vrai obstacle est de se
          rappeler qu'elles existent, pas de taper un point. */}
      <span className="flex min-w-[9rem] flex-1 items-center gap-1 rounded-lg bg-muted/50 px-2.5 py-1.5 focus-within:bg-muted">
        <input
          value={test.left ?? ""}
          onChange={(e) => onChange({ left: e.target.value })}
          list={`vars-${node.id}`}
          placeholder="trigger.from"
          title="Le chemin d'une donnée : trigger.<champ>, une variable, steps.<bloc>.<champ> ou liste[0].champ"
          className="min-w-0 flex-1 bg-transparent font-mono text-[13px] outline-none placeholder:text-muted-foreground/50"
        />
        <datalist id={`vars-${node.id}`}>
          {ctx.vars.map((v) => <option key={v} value={v} />)}
          <option value="trigger" />
        </datalist>
      </span>
      <div className="w-40 shrink-0">
        <Picker
          value={op.id}
          onChange={(v) => onChange({ op: v })}
          options={TEST_OPS.map((o) => ({ value: o.id, label: o.label }))}
        />
      </div>
      {op.needsRight && (
        <input
          value={test.right ?? ""}
          onChange={(e) => onChange({ right: e.target.value })}
          placeholder="@acme.com"
          className="min-w-[7rem] flex-1 rounded-lg bg-muted/50 px-2.5 py-1.5 text-[13px] outline-none placeholder:text-muted-foreground/50 focus:bg-muted"
        />
      )}
    </div>
  );
}
