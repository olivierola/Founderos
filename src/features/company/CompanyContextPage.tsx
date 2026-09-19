// Contexte d'entreprise — l'écran où l'on écrit ce que tous les agents savent.
//
// Le pari de cet écran est qu'il se remplit. Un formulaire d'entreprise est le
// genre de page qu'on ouvre une fois et qu'on abandonne à la troisième
// question, ce qui laisse la workforce exactement aussi aveugle qu'avant.
// Trois choix en découlent :
//
//   • Chaque champ dit à quoi il SERT pour les agents, pas seulement ce qu'il
//     attend. « Client type » se remplit quand on sait que c'est ce qui décide
//     du ton de tout ce que les agents écrivent.
//   • L'enregistrement est par champ, au blur. Pas de gros bouton « Enregistrer »
//     en bas qu'on n'atteint jamais : ce qu'on écrit est acquis.
//   • Un indicateur de complétude en haut, avec le prochain champ vide nommé.
//     Un profil à moitié écrit est un contexte à moitié utile, et l'écran le dit.
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BuildingsIcon as Building2,
  CheckIcon as Check,
  CircleNotchIcon as Loader2,
  ShieldWarningIcon as ShieldAlert,
  UsersIcon as Users,
} from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/utils";
import {
  PROFILE_FIELDS, STAGES, fetchCompanyProfile, profileCompletion, saveCompanyProfile,
  type CompanyProfile,
} from "./model";

/** Un champ qui s'enregistre tout seul. L'état « enregistré » s'affiche une
 *  seconde et s'efface : une coche permanente sur dix champs ne veut plus rien
 *  dire, une coche qui apparaît au moment où l'on quitte le champ, si. */
function AutoField({
  label, help, value, placeholder, long, onSave,
}: {
  label: string; help?: string; value: string; placeholder: string; long?: boolean;
  onSave: (v: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value);
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  // La valeur peut changer sous nos pieds (autre onglet, agent qui écrit) —
  // on ne l'écrase que si l'utilisateur n'est pas en train de taper.
  useEffect(() => { setDraft(value); }, [value]);

  const commit = async () => {
    if (draft === value) return;
    setState("saving");
    try {
      await onSave(draft);
      setState("saved");
      setTimeout(() => setState("idle"), 1400);
    } catch {
      setState("idle");
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <label className="text-sm font-medium">{label}</label>
        {state === "saving" && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        {state === "saved" && <Check className="h-3.5 w-3.5 text-emerald-500" />}
      </div>
      {long ? (
        <Textarea
          value={draft} placeholder={placeholder} rows={2} className="resize-y"
          onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        />
      ) : (
        <Input
          value={draft} placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)} onBlur={commit}
        />
      )}
      {help && <p className="text-[11px] leading-relaxed text-muted-foreground">{help}</p>}
    </div>
  );
}

export function CompanyContextPage() {
  const { projectId, workspaceId, project } = useCurrentContext();
  const { user } = useAuth();
  const qc = useQueryClient();

  const { data: profile, isLoading } = useQuery({
    queryKey: ["company_profile", projectId],
    enabled: !!projectId,
    queryFn: () => fetchCompanyProfile(projectId!),
  });

  const save = async (patch: Partial<CompanyProfile>) => {
    if (!projectId || !workspaceId) return;
    await saveCompanyProfile(projectId, workspaceId, user?.id ?? null, patch);
    await qc.invalidateQueries({ queryKey: ["company_profile", projectId] });
  };

  const completion = useMemo(() => profileCompletion(profile ?? null), [profile]);
  const nextEmpty = useMemo(
    () => PROFILE_FIELDS.find((f) => !String((profile ?? {})[f.key] ?? "").trim()),
    [profile],
  );

  const identity = PROFILE_FIELDS.filter((f) => ["legal_name", "activity", "mission", "market", "icp"].includes(f.key as string));
  const promise = PROFILE_FIELDS.filter((f) => ["value_prop", "differentiators", "tone"].includes(f.key as string));
  const bounds = PROFILE_FIELDS.filter((f) => ["constraints", "non_negotiables"].includes(f.key as string));

  if (isLoading) {
    return (
      <div className="space-y-4 px-6 py-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const p = profile ?? null;
  const val = (k: keyof CompanyProfile) => String(p?.[k] ?? "");

  return (
    <div className="px-6 py-6">
      <PageHeader
        title="Contexte d'entreprise"
        description="Ce que tous vos agents savent avant de commencer. Écrit ici une fois, lu à chaque tâche."
        actions={
          <Badge variant={completion.pct === 100 ? "default" : "secondary"} className="tabular-nums">
            {completion.filled}/{completion.total} renseignés
          </Badge>
        }
      />

      {/* La barre de complétude nomme le prochain champ vide : « 40 % » n'a
          jamais fait remplir un formulaire, « il manque votre client type » si. */}
      <Card className="mb-5 p-4">
        <div className="flex items-center gap-3">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div
              className={cn("h-full rounded-full transition-all", completion.pct === 100 ? "bg-emerald-500" : "bg-primary")}
              style={{ width: `${Math.max(completion.pct, 3)}%` }}
            />
          </div>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{completion.pct} %</span>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {nextEmpty
            ? <>Prochain manque : <span className="font-medium text-foreground">{nextEmpty.label}</span>. Chaque champ vide est une question que vos agents reposeront.</>
            : <>Profil complet. Vos agents partent avec le même cadre que vous — {project?.name ? `« ${project.name} »` : "cette entreprise"} n'a plus besoin d'être réexpliquée à chaque tâche.</>}
        </p>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="space-y-4 p-5">
          <div className="flex items-center gap-2">
            <Building2 className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold">Qui vous êtes</h2>
          </div>
          {identity.map((f) => (
            <AutoField
              key={f.key as string} label={f.label} help={f.help} placeholder={f.placeholder}
              long={f.long} value={val(f.key)} onSave={(v) => save({ [f.key]: v || null } as Partial<CompanyProfile>)}
            />
          ))}
        </Card>

        <div className="space-y-5">
          <Card className="space-y-4 p-5">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-sky-500" />
              <h2 className="text-sm font-semibold">Ce que vous promettez</h2>
            </div>
            {promise.map((f) => (
              <AutoField
                key={f.key as string} label={f.label} help={f.help} placeholder={f.placeholder}
                long={f.long} value={val(f.key)} onSave={(v) => save({ [f.key]: v || null } as Partial<CompanyProfile>)}
              />
            ))}
          </Card>

          <Card className="space-y-4 p-5">
            <div className="flex items-center gap-2">
              <ShieldAlert className="h-4 w-4 text-amber-500" />
              <h2 className="text-sm font-semibold">Ce qui borne l'action</h2>
            </div>
            {bounds.map((f) => (
              <AutoField
                key={f.key as string} label={f.label} help={f.help} placeholder={f.placeholder}
                long={f.long} value={val(f.key)} onSave={(v) => save({ [f.key]: v || null } as Partial<CompanyProfile>)}
              />
            ))}
          </Card>

          <Card className="space-y-4 p-5">
            <h2 className="text-sm font-semibold">Situation</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Stade</label>
                <div className="flex flex-wrap gap-1.5">
                  {STAGES.map((s) => (
                    <button
                      key={s}
                      onClick={() => save({ stage: p?.stage === s ? null : s })}
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-xs capitalize transition-colors",
                        p?.stage === s ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-muted",
                      )}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
              <AutoField
                label="Taille de l'équipe" placeholder="12" value={p?.team_size != null ? String(p.team_size) : ""}
                onSave={(v) => save({ team_size: v.trim() ? Number(v) : null })}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <AutoField
                label="Zones" placeholder="France, Belgique" value={(p?.geographies ?? []).join(", ")}
                onSave={(v) => save({ geographies: v.split(",").map((x) => x.trim()).filter(Boolean) })}
              />
              <AutoField
                label="Langues de travail" placeholder="fr, en" value={(p?.languages ?? []).join(", ")}
                onSave={(v) => save({ languages: v.split(",").map((x) => x.trim()).filter(Boolean) })}
              />
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
