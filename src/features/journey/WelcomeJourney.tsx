import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeftIcon, ArrowRightIcon, CheckIcon, CircleNotchIcon as Loader2, PencilSimpleIcon, SparkleIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Logo, Wordmark } from "@/components/Logo";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import { useWorkspaces } from "@/hooks/useWorkspace";
import { AGENT_TEMPLATES } from "@/features/internal-agents/agentTemplates";
import { QUESTIONS, choiceLabel, type Question, type QuestionKey } from "./questions";
import { useJourneyProfile, useSaveJourney, type JourneyPatch, type JourneyProfile } from "./api";
import { recommendedTemplates } from "./personalize";

/**
 * Le parcours d'arrivée d'une personne : qui elle est, ce qu'elle fait,
 * comment elle nous a connus, ce qu'elle attend.
 *
 * Une question par écran, des réponses proposées et toujours une réponse
 * libre possible. Chaque réponse est enregistrée en quittant l'écran : on peut
 * fermer l'onglet et reprendre où on en était. Tout se passe ; rien n'est
 * bloquant. La fin montre ce que les réponses changent.
 */

const OTHER = "__other";

type Values = Partial<Record<QuestionKey, string | string[]>>;

interface Draft {
  values: Values;
  others: Partial<Record<QuestionKey, string>>;
  job_title: string;
  discovery_detail: string;
}

/** Les réponses enregistrées, remises dans la forme du formulaire. */
function draftFrom(p: JourneyProfile | null | undefined): Draft {
  const d: Draft = { values: {}, others: {}, job_title: p?.job_title ?? "", discovery_detail: p?.discovery_detail ?? "" };
  if (!p) return d;
  for (const q of QUESTIONS) {
    const raw = (p as unknown as Record<string, unknown>)[q.key];
    if (raw == null) continue;
    if (q.kind === "multi" && Array.isArray(raw)) {
      const known = raw.filter((v) => q.choices?.some((c) => c.value === v));
      const custom = raw.filter((v) => !q.choices?.some((c) => c.value === v));
      d.values[q.key] = custom.length ? [...known, OTHER] : known;
      if (custom.length) d.others[q.key] = custom.join(", ");
    } else if (typeof raw === "string") {
      if (q.kind === "single" && !q.choices?.some((c) => c.value === raw)) {
        d.values[q.key] = OTHER; d.others[q.key] = raw;
      } else d.values[q.key] = raw;
    }
  }
  return d;
}

/** Ce qu'une question enregistre en base. */
function patchFor(q: Question, d: Draft): JourneyPatch {
  const v = d.values[q.key];
  const other = (d.others[q.key] ?? "").trim();
  const patch: Record<string, unknown> = {};
  if (q.kind === "multi") {
    const list = (Array.isArray(v) ? v : []).filter((x) => x !== OTHER);
    const custom = Array.isArray(v) && v.includes(OTHER) && other ? other.split(",").map((s) => s.trim()).filter(Boolean) : [];
    patch[q.key] = [...list, ...custom];
  } else if (q.kind === "single") {
    patch[q.key] = v === OTHER ? (other || null) : (v ?? null);
  } else {
    patch[q.key] = typeof v === "string" && v.trim() ? v.trim() : null;
  }
  if (q.detail) patch[q.detail.key] = d[q.detail.key].trim() || null;
  return patch as JourneyPatch;
}

function answered(q: Question, d: Draft): boolean {
  const v = d.values[q.key];
  if (q.kind === "multi") {
    const list = Array.isArray(v) ? v : [];
    return list.some((x) => x !== OTHER) || (list.includes(OTHER) && !!d.others[q.key]?.trim());
  }
  if (q.kind === "single") return !!v && (v !== OTHER || !!d.others[q.key]?.trim());
  return typeof v === "string" && v.trim().length > 0;
}

export function WelcomeJourneyPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { user, session, loading: authLoading } = useAuth();
  const { data: profile, isLoading } = useJourneyProfile();
  const { data: workspaces } = useWorkspaces();
  const save = useSaveJourney();

  const [draft, setDraft] = useState<Draft>(() => draftFrom(null));
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dir, setDir] = useState(1);
  const hydrated = useRef(false);
  // Un choix unique fait avancer seul : un second clic pendant ce temps ne
  // doit pas sauter la question suivante.
  const advancing = useRef(false);
  useEffect(() => { advancing.current = false; }, [step]);

  // Reprendre là où la personne s'était arrêtée, avec ses réponses.
  useEffect(() => {
    if (hydrated.current || profile === undefined) return;
    hydrated.current = true;
    const d = draftFrom(profile);
    if (!d.values.first_name) {
      const meta = (user?.user_metadata?.name as string | undefined) || (user?.user_metadata?.full_name as string | undefined);
      if (meta) d.values.first_name = meta.split(" ")[0];
    }
    setDraft(d);
    if (profile?.completed_at) setStep(QUESTIONS.length);
    else if (profile) setStep(Math.min(profile.step ?? 0, QUESTIONS.length - 1));
  }, [profile, user]);

  const total = QUESTIONS.length;
  const done = step >= total;
  const q = QUESTIONS[Math.min(step, total - 1)];

  const nextUrl = useMemo(() => {
    const raw = params.get("next");
    if (raw && raw.startsWith("/") && !raw.startsWith("//") && !raw.startsWith("/welcome")) return raw;
    return (workspaces ?? []).length > 0 ? "/orgs" : "/onboarding";
  }, [params, workspaces]);

  if (!authLoading && !session) return <Navigate to="/login?next=/welcome" replace />;

  async function persist(patch: JourneyPatch) {
    setBusy(true); setError(null);
    try { await save(patch); return true; }
    catch (e) { setError(e instanceof Error ? e.message : "L'enregistrement a échoué."); return false; }
    finally { setBusy(false); }
  }

  async function next() {
    if (done) return;
    const answers = { ...(profile?.answers ?? {}), [q.key]: { value: draft.values[q.key] ?? null, other: draft.others[q.key] ?? null } };
    const ok = await persist({ ...patchFor(q, draft), answers, step: step + 1, ...(step + 1 >= total ? { completed_at: new Date().toISOString() } : {}) });
    if (!ok) return;
    setDir(1);
    setStep((s) => s + 1);
  }

  function back() {
    setDir(-1);
    setStep((s) => Math.max(0, s - 1));
  }

  async function skipAll() {
    const ok = await persist({ skipped_at: new Date().toISOString(), step });
    if (ok) navigate(nextUrl, { replace: true });
  }

  function setValue(key: QuestionKey, v: string | string[]) {
    setDraft((d) => ({ ...d, values: { ...d.values, [key]: v } }));
  }

  // Un choix unique sans champ secondaire fait avancer tout seul.
  function pickSingle(value: string) {
    if (advancing.current) return;
    setValue(q.key, value);
    if (value !== OTHER && !q.detail) {
      advancing.current = true;
      const nextDraft = { ...draft, values: { ...draft.values, [q.key]: value } };
      setTimeout(() => {
        void (async () => {
          const answers = { ...(profile?.answers ?? {}), [q.key]: { value, other: null } };
          const ok = await persist({ ...patchFor(q, nextDraft), answers, step: step + 1 });
          if (ok) { setDir(1); setStep((s) => s + 1); } else advancing.current = false;
        })();
      }, 220);
    }
  }

  const canNext = q.optional || answered(q, draft);

  if (isLoading || authLoading) {
    return <div className="flex min-h-screen items-center justify-center bg-background"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex h-16 shrink-0 items-center gap-4 px-6">
        <span className="flex items-center gap-2.5">
          <Logo size={20} color="currentColor" />
          <Wordmark size={18} />
        </span>
        <div className="mx-auto hidden w-full max-w-md items-center gap-1.5 sm:flex" aria-label={`Étape ${Math.min(step + 1, total)} sur ${total}`}>
          {QUESTIONS.map((x, i) => (
            <span key={x.key} className={cn("h-1 flex-1 rounded-full transition-colors", i < step || done ? "bg-primary" : i === step ? "bg-primary/45" : "bg-muted")} />
          ))}
        </div>
        {!done && (
          <button onClick={() => void skipAll()} disabled={busy} className="ml-auto text-[13px] text-muted-foreground transition-colors hover:text-foreground sm:ml-0">
            Passer pour l'instant
          </button>
        )}
      </header>

      <main className="flex flex-1 justify-center px-6 pb-16 pt-8 sm:pt-14">
        <div className="w-full max-w-[720px]">
          <AnimatePresence mode="wait" custom={dir}>
            {done ? (
              <motion.div key="done" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
                <Recap
                  profile={profile ?? null}
                  draft={draft}
                  onEdit={(i) => { setDir(-1); setStep(i); }}
                  onEnter={() => navigate(nextUrl, { replace: true })}
                />
              </motion.div>
            ) : (
              <motion.div
                key={q.key}
                custom={dir}
                initial={{ opacity: 0, x: 16 * dir }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -16 * dir }}
                transition={{ duration: 0.2, ease: "easeOut" }}
              >
                <div className="status-mono text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
                  Question {step + 1} sur {total}
                </div>
                <h1 className="mt-3 text-[30px] font-medium leading-tight tracking-tight">
                  {q.key !== "first_name" && draft.values.first_name && step === 1
                    ? `Bienvenue, ${String(draft.values.first_name)}. ${q.title}`
                    : q.title}
                </h1>
                <p className="mt-2 text-[15px] text-muted-foreground">{q.sub}</p>

                <div className="mt-8">
                  <QuestionBody
                    q={q}
                    draft={draft}
                    setDraft={setDraft}
                    onPickSingle={pickSingle}
                    onSubmit={() => canNext && void next()}
                  />
                </div>

                {error && <p className="mt-5 text-[13px] text-red-600 dark:text-red-400">{error}</p>}

                <div className="mt-10 flex items-center gap-2">
                  {step > 0 && (
                    <Button variant="ghost" className="rounded-full" onClick={back} disabled={busy}>
                      <ArrowLeftIcon className="h-4 w-4" /> Retour
                    </Button>
                  )}
                  <div className="flex-1" />
                  {q.optional && !answered(q, draft) && (
                    <Button variant="ghost" className="rounded-full" onClick={() => void next()} disabled={busy}>Passer</Button>
                  )}
                  <Button className="h-10 rounded-full px-5" onClick={() => void next()} disabled={busy || !canNext}>
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {step === total - 1 ? "Terminer" : "Continuer"}
                    {!busy && <ArrowRightIcon className="h-4 w-4" />}
                  </Button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}

function QuestionBody({ q, draft, setDraft, onPickSingle, onSubmit }: {
  q: Question; draft: Draft; setDraft: React.Dispatch<React.SetStateAction<Draft>>;
  onPickSingle: (v: string) => void; onSubmit: () => void;
}) {
  const value = draft.values[q.key];
  const other = draft.others[q.key] ?? "";
  const setOther = (t: string) => setDraft((d) => ({ ...d, others: { ...d.others, [q.key]: t } }));

  if (q.kind === "text" || q.kind === "long") {
    const common = {
      autoFocus: true,
      value: typeof value === "string" ? value : "",
      placeholder: q.placeholder,
      onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        setDraft((d) => ({ ...d, values: { ...d.values, [q.key]: e.target.value } })),
    };
    return q.kind === "text" ? (
      <input
        {...common}
        onKeyDown={(e) => e.key === "Enter" && onSubmit()}
        className="h-14 w-full rounded-2xl border border-border bg-card px-5 text-[18px] outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary/60"
      />
    ) : (
      <textarea
        {...common}
        rows={5}
        className="w-full resize-none rounded-2xl border border-border bg-card px-5 py-4 text-[15px] leading-relaxed outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary/60"
      />
    );
  }

  const multi = q.kind === "multi";
  const list = multi ? (Array.isArray(value) ? value : []) : [];
  const isOn = (v: string) => (multi ? list.includes(v) : value === v);
  const toggle = (v: string) => {
    if (!multi) { onPickSingle(v); return; }
    setDraft((d) => {
      const cur = Array.isArray(d.values[q.key]) ? (d.values[q.key] as string[]) : [];
      return { ...d, values: { ...d.values, [q.key]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] } };
    });
  };

  return (
    <div>
      <div className={cn("grid gap-2.5", q.cols === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2")}>
        {(q.choices ?? []).map((c) => (
          <ChoiceTile key={c.value} label={c.label} icon={c.icon} on={isOn(c.value)} multi={multi} onClick={() => toggle(c.value)} />
        ))}
        {q.other && (
          <ChoiceTile label="Autre" icon={PencilSimpleIcon} on={isOn(OTHER)} multi={multi} onClick={() => toggle(OTHER)} />
        )}
      </div>

      {q.other && isOn(OTHER) && (
        <div className="mt-3">
          <input
            autoFocus
            value={other}
            onChange={(e) => setOther(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && onSubmit()}
            placeholder={multi ? "Précisez, séparez par des virgules" : "Précisez"}
            className="h-12 w-full rounded-xl border border-primary/40 bg-card px-4 text-[15px] outline-none placeholder:text-muted-foreground/60 focus:border-primary"
          />
        </div>
      )}

      {q.detail && (
        <label className="mt-6 block">
          <span className="text-[13px] font-medium">{q.detail.label}</span>
          <input
            value={draft[q.detail.key]}
            onChange={(e) => setDraft((d) => ({ ...d, [q.detail!.key]: e.target.value }))}
            onKeyDown={(e) => e.key === "Enter" && onSubmit()}
            placeholder={q.detail.placeholder}
            className="mt-2 h-12 w-full rounded-xl border border-border bg-card px-4 text-[15px] outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary/60"
          />
        </label>
      )}
    </div>
  );
}

function ChoiceTile({ label, icon: Icon, on, multi, onClick }: {
  label: string; icon?: React.ComponentType<{ className?: string; weight?: "duotone" | "regular" }>;
  on: boolean; multi: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        "group flex min-h-[56px] items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors",
        on ? "border-primary bg-primary/[0.07]" : "border-border bg-card hover:border-primary/40 hover:bg-muted/40",
      )}
    >
      {Icon && (
        <span className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-colors",
          on ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground group-hover:text-foreground",
        )}>
          <Icon className="h-[18px] w-[18px]" weight={on ? "duotone" : "regular"} />
        </span>
      )}
      <span className="min-w-0 flex-1 text-[14px] leading-snug">{label}</span>
      <span className={cn(
        "flex h-5 w-5 shrink-0 items-center justify-center border transition-colors",
        multi ? "rounded-md" : "rounded-full",
        on ? "border-primary bg-primary text-primary-foreground" : "border-border",
      )}>
        {on && <CheckIcon weight="bold" className="h-3 w-3" />}
      </span>
    </button>
  );
}

/** La fin : ce qui a été retenu, et ce que ça change dans l'outil. */
function Recap({ profile, draft, onEdit, onEnter }: {
  profile: JourneyProfile | null; draft: Draft; onEdit: (step: number) => void; onEnter: () => void;
}) {
  const name = String(draft.values.first_name ?? "").trim();
  const templates = recommendedTemplates(profile, 3)
    .map((k) => AGENT_TEMPLATES.find((t) => t.key === k))
    .filter((t): t is (typeof AGENT_TEMPLATES)[number] => !!t);

  const rows: Array<{ step: number; label: string; value: string }> = [];
  QUESTIONS.forEach((q, i) => {
    if (q.key === "first_name" || q.key === "expectations") return;
    const raw = (profile as unknown as Record<string, unknown> | null)?.[q.key];
    const value = Array.isArray(raw)
      ? raw.map((v) => choiceLabel(q.key, String(v))).join(", ")
      : choiceLabel(q.key, raw as string | null);
    rows.push({ step: i, label: q.title.replace(/ \?$/, ""), value: value || "Non renseigné" });
  });

  return (
    <div>
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
        <SparkleIcon weight="duotone" className="h-5 w-5" />
      </span>
      <h1 className="mt-5 text-[30px] font-medium leading-tight tracking-tight">
        {name ? `C'est noté, ${name}.` : "C'est noté."}
      </h1>
      <p className="mt-2 text-[15px] text-muted-foreground">Votre espace est réglé d'après vos réponses. Tout se modifie plus tard.</p>

      {templates.length > 0 && (
        <section className="mt-8 rounded-2xl border border-border bg-card p-5">
          <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">Les agents qu'on vous proposera d'abord</div>
          <ul className="mt-3 grid gap-2 sm:grid-cols-3">
            {templates.map((t) => (
              <li key={t.key} className="rounded-xl bg-muted/50 p-3.5">
                <div className="text-[14px] font-medium">{t.name}</div>
                <div className="mt-1 line-clamp-2 text-[12px] leading-snug text-muted-foreground">{t.tagline}</div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-4 rounded-2xl border border-border bg-card">
        <ul className="divide-y divide-border/70">
          {rows.map((r) => (
            <li key={r.step} className="flex items-center gap-4 px-5 py-3">
              <span className="w-48 shrink-0 text-[13px] text-muted-foreground">{r.label}</span>
              <span className="min-w-0 flex-1 truncate text-[14px]">{r.value}</span>
              <button
                onClick={() => onEdit(r.step)}
                className="shrink-0 rounded-full px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                Modifier
              </button>
            </li>
          ))}
        </ul>
      </section>

      <div className="mt-8 flex justify-end">
        <Button className="h-11 rounded-full px-6" onClick={onEnter}>
          Entrer dans l'application <ArrowRightIcon className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
