import { useMemo, useState } from "react";
import { useCategorical } from "@/features/crm/overview/vizPalette";
import { cn } from "@/lib/utils";
import { MemberAvatar, PriorityIcon, memberName } from "../pickers";
import { Tabs } from "../ui";
import { PRIORITIES, type Member, type PjIssue, type PjLabel, type PjState } from "../model";

/**
 * Les statistiques d'un cycle : qui porte quoi, et où ça bloque.
 *
 * Trois découpes — par personne, par label, par priorité — et une seule à la
 * fois. Les afficher ensemble tiendrait sur trois écrans, alors que la question
 * posée est toujours unique : « qui est surchargé », ou « quel type de travail
 * traîne », ou « les urgences avancent-elles ».
 *
 * Chaque ligne montre TERMINÉ sur TOTAL, pas un pourcentage seul. Sur des
 * groupes de tailles très différentes — quelqu'un a trois items, un autre en a
 * trente — un pourcentage seul met les deux au même rang et masque la charge.
 */

type Slice = "assignee" | "label" | "priority";

const SLICES: { key: Slice; label: string }[] = [
  { key: "assignee", label: "Assignés" },
  { key: "label", label: "Labels" },
  { key: "priority", label: "Priorité" },
];

interface Row {
  key: string;
  label: string;
  total: number;
  done: number;
  leading?: React.ReactNode;
  color?: string;
}

export function CycleStatsPanel({
  issues, states, members, labels,
}: {
  issues: PjIssue[];
  states: PjState[];
  members: Member[];
  labels: PjLabel[];
}) {
  const [slice, setSlice] = useState<Slice>("assignee");
  const palette = useCategorical();

  const completed = useMemo(() => {
    const done = new Set(states.filter((s) => s.group === "completed").map((s) => s.id));
    return (i: PjIssue) => done.has(i.state_id ?? "");
  }, [states]);

  const rows = useMemo<Row[]>(() => {
    const acc = new Map<string, { total: number; done: number }>();
    const bump = (key: string, isDone: boolean) => {
      const cur = acc.get(key) ?? { total: 0, done: 0 };
      acc.set(key, { total: cur.total + 1, done: cur.done + (isDone ? 1 : 0) });
    };

    for (const i of issues) {
      const isDone = completed(i);
      if (slice === "assignee") {
        // Les non-assignés forment une ligne à part et ne sont pas omis : sur
        // un cycle en difficulté, c'est souvent la ligne la plus grosse.
        if (!i.assignee_ids.length) bump("__none__", isDone);
        else for (const a of i.assignee_ids) bump(a, isDone);
      } else if (slice === "label") {
        if (!i.label_ids.length) bump("__none__", isDone);
        else for (const l of i.label_ids) bump(l, isDone);
      } else {
        bump(i.priority, isDone);
      }
    }

    const out: Row[] = [...acc.entries()].map(([key, v], index) => {
      if (slice === "assignee") {
        const member = members.find((m) => m.user_id === key);
        return {
          key, ...v,
          label: key === "__none__" ? "Non assigné" : memberName(member),
          leading: key === "__none__"
            ? <span className="h-5 w-5 shrink-0 rounded-full bg-muted" />
            : <MemberAvatar member={member} />,
          color: palette[index % palette.length],
        };
      }
      if (slice === "label") {
        const label = labels.find((l) => l.id === key);
        return {
          key, ...v,
          label: key === "__none__" ? "Sans label" : label?.name ?? "Label supprimé",
          leading: (
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ background: label?.color ?? "hsl(var(--muted-foreground))" }}
            />
          ),
          color: label?.color ?? palette[index % palette.length],
        };
      }
      const meta = PRIORITIES.find((p) => p.key === key);
      return {
        key, ...v,
        label: meta?.label ?? key,
        leading: <PriorityIcon priority={key as PjIssue["priority"]} />,
        color: key === "urgent" ? "#e34948" : palette[index % palette.length],
      };
    });

    // Le plus chargé en haut : c'est là que se trouve le problème quand il y
    // en a un, et c'est ce qu'on vient chercher.
    return out.sort((a, b) => b.total - a.total);
  }, [issues, slice, members, labels, palette, completed]);

  return (
    <div>
      <div className="pb-2.5">
        <Tabs value={slice} onChange={setSlice} options={SLICES} />
      </div>

      {!rows.length ? (
        <p className="py-6 text-center text-11 text-muted-foreground">
          Aucun work item dans ce cycle.
        </p>
      ) : (
        <ul className="max-h-[240px] space-y-2 overflow-y-auto pr-1">
          {rows.map((r) => {
            const percent = r.total ? Math.round((r.done / r.total) * 100) : 0;
            return (
              <li key={r.key}>
                <div className="flex items-center gap-2 pb-1">
                  {r.leading}
                  <span className={cn(
                    "min-w-0 flex-1 truncate text-12",
                    r.key === "__none__" && "italic text-muted-foreground",
                  )}>
                    {r.label}
                  </span>
                  {/* Terminé sur total, puis le pourcentage : le premier dit la
                      charge, le second l'avancement, et l'un sans l'autre
                      induit en erreur. */}
                  <span className="shrink-0 text-11 tabular-nums text-muted-foreground">
                    {r.done}/{r.total}
                  </span>
                  <span className="w-8 shrink-0 text-right text-11 tabular-nums">{percent}%</span>
                </div>
                <span className="block h-1.5 rounded-full bg-muted">
                  <span
                    className="block h-full rounded-full transition-[width] duration-500"
                    style={{ width: `${percent}%`, background: r.color }}
                  />
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
