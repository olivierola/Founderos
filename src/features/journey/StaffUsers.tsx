import { useMemo, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeftIcon, CaretDownIcon, CheckCircleIcon, CircleNotchIcon as Loader2, DownloadSimpleIcon,
  MagnifyingGlassIcon, UserPlusIcon, UsersThreeIcon, ArrowBendUpRightIcon, type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { Logo, Wordmark } from "@/components/Logo";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { formatRelative } from "@/features/tracker/pickers";
import { QUESTIONS, choiceLabel, type QuestionKey } from "./questions";
import { useIsPlatformStaff } from "./api";

/**
 * La vue de l'équipe sur ses utilisateurs : qui s'inscrit, d'où il vient, ce
 * qu'il attend, ce qu'il veut faire. Réservée aux comptes de platform_staff ;
 * la RPC le vérifie aussi, cette page ne fait que l'afficher.
 */

interface Row {
  user_id: string; email: string; signed_up_at: string | null; last_sign_in_at: string | null;
  first_name: string | null; persona: string | null; job_title: string | null; industry: string | null;
  company_size: string | null; discovery_source: string | null; discovery_detail: string | null;
  goals: string[]; use_cases: string[]; ai_experience: string | null; expectations: string | null;
  completed_at: string | null; skipped_at: string | null; workspaces: number;
}

const DAY = 86_400_000;

function tally(rows: Row[], key: QuestionKey): Array<{ label: string; n: number }> {
  const m = new Map<string, number>();
  for (const r of rows) {
    const raw = (r as unknown as Record<string, unknown>)[key];
    const vals = Array.isArray(raw) ? raw : raw ? [raw] : [];
    for (const v of vals) {
      const label = choiceLabel(key, String(v));
      m.set(label, (m.get(label) ?? 0) + 1);
    }
  }
  return [...m.entries()].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n);
}

function csv(rows: Row[]): string {
  const cols: Array<[string, (r: Row) => string]> = [
    ["email", (r) => r.email], ["prénom", (r) => r.first_name ?? ""],
    ["rôle", (r) => choiceLabel("persona", r.persona)], ["poste", (r) => r.job_title ?? ""],
    ["secteur", (r) => choiceLabel("industry", r.industry)], ["équipe", (r) => choiceLabel("company_size", r.company_size)],
    ["source", (r) => choiceLabel("discovery_source", r.discovery_source)], ["détail source", (r) => r.discovery_detail ?? ""],
    ["attentes", (r) => r.goals.map((g) => choiceLabel("goals", g)).join(" | ")],
    ["cas d'usage", (r) => r.use_cases.map((g) => choiceLabel("use_cases", g)).join(" | ")],
    ["niveau IA", (r) => choiceLabel("ai_experience", r.ai_experience)], ["message", (r) => r.expectations ?? ""],
    ["inscrit le", (r) => r.signed_up_at ?? ""], ["parcours", (r) => (r.completed_at ? "terminé" : r.skipped_at ? "passé" : "à faire")],
    ["organisations", (r) => String(r.workspaces)],
  ];
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  return [cols.map(([h]) => esc(h)).join(","), ...rows.map((r) => cols.map(([, f]) => esc(f(r))).join(","))].join("\n");
}

export function StaffUsersPage() {
  const navigate = useNavigate();
  const { data: isStaff, isLoading: staffLoading } = useIsPlatformStaff();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"all" | "done" | "skipped" | "todo">("all");
  const [open, setOpen] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["platform_user_overview"],
    enabled: isStaff === true,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("platform_user_overview");
      if (error) throw new Error(error.message);
      return (data ?? []) as Row[];
    },
  });

  const rows = data ?? [];
  const stats = useMemo(() => {
    const now = Date.now();
    const week = rows.filter((r) => r.signed_up_at && now - new Date(r.signed_up_at).getTime() < 7 * DAY).length;
    const done = rows.filter((r) => r.completed_at).length;
    const skipped = rows.filter((r) => r.skipped_at && !r.completed_at).length;
    const answered = rows.filter((r) => r.completed_at || r.persona);
    return {
      total: rows.length, week, done, skipped,
      pct: rows.length ? Math.round((done / rows.length) * 100) : 0,
      persona: tally(answered, "persona"), source: tally(answered, "discovery_source"),
      useCases: tally(answered, "use_cases"), goals: tally(answered, "goals"),
      size: tally(answered, "company_size"), industry: tally(answered, "industry"),
    };
  }, [rows]);

  const q = search.trim().toLowerCase();
  const filtered = rows.filter((r) => {
    if (status === "done" && !r.completed_at) return false;
    if (status === "skipped" && !(r.skipped_at && !r.completed_at)) return false;
    if (status === "todo" && (r.completed_at || r.skipped_at)) return false;
    if (!q) return true;
    return [r.email, r.first_name, r.job_title, r.expectations, choiceLabel("persona", r.persona), choiceLabel("industry", r.industry)]
      .some((v) => (v ?? "").toLowerCase().includes(q));
  });

  if (staffLoading) return <div className="flex min-h-screen items-center justify-center bg-background"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  if (isStaff === false) return <Navigate to="/orgs" replace />;

  function exportCsv() {
    const blob = new Blob(["﻿" + csv(filtered)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `utilisateurs-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b border-border bg-background px-6">
        <button onClick={() => navigate("/orgs")} className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Retour">
          <ArrowLeftIcon className="h-4 w-4" />
        </button>
        <span className="flex items-center gap-2.5"><Logo size={18} color="currentColor" /><Wordmark size={17} /></span>
        <span className="h-5 w-px bg-border" />
        <span className="text-[13px] text-muted-foreground">Équipe plateforme</span>
      </header>

      <div className="mx-auto w-full max-w-[1400px] space-y-5 px-6 py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-[26px] font-medium tracking-tight">Utilisateurs</h1>
            <p className="mt-1 text-[13px] text-muted-foreground">Leurs réponses au parcours d'arrivée</p>
          </div>
          <button
            onClick={exportCsv}
            disabled={!filtered.length}
            className="inline-flex h-9 items-center gap-2 rounded-full border border-border px-4 text-[13px] font-medium transition-colors hover:bg-muted disabled:opacity-40"
          >
            <DownloadSimpleIcon className="h-4 w-4" /> Exporter en CSV
          </button>
        </div>

        {error && <div className="rounded-2xl border border-red-500/30 bg-red-500/[0.06] p-4 text-[13px] text-red-700 dark:text-red-400">{(error as Error).message}</div>}

        <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr))]">
          <Kpi icon={UsersThreeIcon} label="Comptes" value={stats.total} sub={`${stats.week} cette semaine`} />
          <Kpi icon={CheckCircleIcon} label="Parcours terminés" value={stats.done} sub={`${stats.pct} % des comptes`} meter={stats.pct} />
          <Kpi icon={ArrowBendUpRightIcon} label="Parcours passés" value={stats.skipped} sub="sans répondre" />
          <Kpi icon={UserPlusIcon} label="Nouveaux, 7 j" value={stats.week} sub="inscriptions" />
        </div>

        <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr))]">
          <Distribution title="Rôles" items={stats.persona} />
          <Distribution title="Comment ils nous ont connus" items={stats.source} />
          <Distribution title="Par quoi ils commencent" items={stats.useCases} />
          <Distribution title="Ce qu'ils attendent" items={stats.goals} />
          <Distribution title="Taille d'équipe" items={stats.size} />
          <Distribution title="Secteurs" items={stats.industry} />
        </div>

        <section className="rounded-2xl border border-border bg-card">
          <div className="flex flex-wrap items-center gap-3 px-5 pb-3 pt-5">
            <h2 className="text-[17px] font-semibold tracking-tight">Comptes</h2>
            <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">{filtered.length}</span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <div className="relative">
                <MagnifyingGlassIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Rechercher"
                  className="h-9 w-56 rounded-full border border-border bg-background pl-9 pr-3 text-[13px] outline-none focus:border-primary/60"
                />
              </div>
              <div className="inline-flex gap-1 rounded-full bg-muted/70 p-1">
                {([["all", "Tous"], ["done", "Terminés"], ["skipped", "Passés"], ["todo", "À faire"]] as const).map(([k, l]) => (
                  <button
                    key={k} onClick={() => setStatus(k)}
                    className={cn("rounded-full px-3 py-1 text-[12px] transition-colors", status === k ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground")}
                  >
                    {l}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {isLoading ? (
            <div className="flex justify-center py-14"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[960px] text-left text-[13px]">
                <thead>
                  <tr className="border-y border-border/70 bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-5 py-2 font-medium">Personne</th>
                    <th className="px-3 py-2 font-medium">Rôle</th>
                    <th className="px-3 py-2 font-medium">Secteur</th>
                    <th className="px-3 py-2 font-medium">Équipe</th>
                    <th className="px-3 py-2 font-medium">Source</th>
                    <th className="px-3 py-2 font-medium">Cas d'usage</th>
                    <th className="px-3 py-2 font-medium">Inscrit</th>
                    <th className="px-3 py-2 font-medium">Parcours</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/70">
                  {filtered.map((r) => (
                    <UserRow key={r.user_id} r={r} open={open === r.user_id} onToggle={() => setOpen(open === r.user_id ? null : r.user_id)} />
                  ))}
                  {!filtered.length && (
                    <tr><td colSpan={9} className="px-5 py-12 text-center text-muted-foreground">Aucun compte dans cette vue.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function UserRow({ r, open, onToggle }: { r: Row; open: boolean; onToggle: () => void }) {
  const status = r.completed_at ? { label: "Terminé", cls: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" }
    : r.skipped_at ? { label: "Passé", cls: "bg-muted text-muted-foreground" }
    : { label: "À faire", cls: "bg-amber-500/10 text-amber-700 dark:text-amber-400" };
  return (
    <>
      <tr onClick={onToggle} className="cursor-pointer transition-colors hover:bg-muted/30">
        <td className="px-5 py-3">
          <div className="font-medium">{r.first_name || r.email.split("@")[0]}</div>
          <div className="text-[12px] text-muted-foreground">{r.email}</div>
        </td>
        <td className="px-3 py-3">
          <div>{choiceLabel("persona", r.persona) || "–"}</div>
          {r.job_title && <div className="text-[12px] text-muted-foreground">{r.job_title}</div>}
        </td>
        <td className="px-3 py-3">{choiceLabel("industry", r.industry) || "–"}</td>
        <td className="px-3 py-3">{choiceLabel("company_size", r.company_size) || "–"}</td>
        <td className="px-3 py-3">{choiceLabel("discovery_source", r.discovery_source) || "–"}</td>
        <td className="px-3 py-3">
          <div className="flex max-w-[260px] flex-wrap gap-1">
            {r.use_cases.slice(0, 2).map((u) => (
              <span key={u} className="truncate rounded-md bg-muted px-1.5 py-0.5 text-[11px]">{choiceLabel("use_cases", u)}</span>
            ))}
            {r.use_cases.length > 2 && <span className="text-[11px] text-muted-foreground">+{r.use_cases.length - 2}</span>}
          </div>
        </td>
        <td className="px-3 py-3 text-muted-foreground">{r.signed_up_at ? formatRelative(r.signed_up_at) : "–"}</td>
        <td className="px-3 py-3">
          <span className={cn("status-mono rounded-md px-1.5 py-0.5 text-[11px] font-medium uppercase tracking-wide", status.cls)}>{status.label}</span>
        </td>
        <td className="pr-4"><CaretDownIcon className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", open && "rotate-180")} /></td>
      </tr>
      {open && (
        <tr className="bg-muted/20">
          <td colSpan={9} className="px-5 py-4">
            <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
              {QUESTIONS.filter((q) => q.key !== "first_name").map((q) => {
                const raw = (r as unknown as Record<string, unknown>)[q.key];
                const v = Array.isArray(raw) ? raw.map((x) => choiceLabel(q.key, String(x))).join(", ") : choiceLabel(q.key, raw as string | null);
                return (
                  <div key={q.key} className={q.kind === "long" ? "sm:col-span-2 lg:col-span-3" : undefined}>
                    <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{q.title.replace(/ \?$/, "")}</dt>
                    <dd className="mt-0.5 text-[13px]">{v || "–"}</dd>
                  </div>
                );
              })}
              {r.discovery_detail && (
                <div>
                  <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Détail de la source</dt>
                  <dd className="mt-0.5 text-[13px]">{r.discovery_detail}</dd>
                </div>
              )}
              <div>
                <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Activité</dt>
                <dd className="mt-0.5 text-[13px]">
                  {r.workspaces} organisation{r.workspaces > 1 ? "s" : ""}
                  {r.last_sign_in_at ? ` · vu ${formatRelative(r.last_sign_in_at)}` : ""}
                </dd>
              </div>
            </dl>
          </td>
        </tr>
      )}
    </>
  );
}

function Kpi({ icon: Icon, label, value, sub, meter }: { icon: PhosphorIcon; label: string; value: number; sub: string; meter?: number }) {
  return (
    <section className="flex flex-col rounded-2xl border border-border bg-card p-5">
      <div className="flex items-center gap-2.5">
        <span className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-background text-muted-foreground"><Icon className="h-4 w-4" /></span>
        <span className="text-[13px] text-muted-foreground">{label}</span>
      </div>
      <div className="mt-4 text-[30px] font-semibold leading-none tracking-tight tabular-nums">{value.toLocaleString("fr-FR")}</div>
      <div className="mt-1.5 text-[12px] text-muted-foreground">{sub}</div>
      {meter != null && (
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-primary/15">
          <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(meter > 0 ? 3 : 0, meter)}%` }} />
        </div>
      )}
    </section>
  );
}

function Distribution({ title, items }: { title: string; items: Array<{ label: string; n: number }> }) {
  const max = Math.max(1, ...items.map((i) => i.n));
  const top = items.slice(0, 7);
  return (
    <section className="rounded-2xl border border-border bg-card p-5">
      <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
      {top.length === 0 ? (
        <p className="mt-4 text-[13px] text-muted-foreground">Pas encore de réponse.</p>
      ) : (
        <ul className="mt-4 space-y-2.5">
          {top.map((i) => (
            <li key={i.label}>
              <div className="flex items-center justify-between gap-3 text-[13px]">
                <span className="min-w-0 truncate">{i.label}</span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{i.n}</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-primary/10">
                <div className="h-full rounded-full bg-primary" style={{ width: `${(i.n / max) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
