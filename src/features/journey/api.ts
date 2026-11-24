import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";

/** Les réponses d'une personne au parcours d'arrivée (0319). */
export interface JourneyProfile {
  user_id: string;
  first_name: string | null;
  persona: string | null;
  job_title: string | null;
  industry: string | null;
  company_size: string | null;
  discovery_source: string | null;
  discovery_detail: string | null;
  goals: string[];
  use_cases: string[];
  ai_experience: string | null;
  expectations: string | null;
  answers: Record<string, unknown>;
  step: number;
  completed_at: string | null;
  skipped_at: string | null;
}

export type JourneyPatch = Partial<Omit<JourneyProfile, "user_id">>;

/** La table n'existe pas encore (migration 0319 non appliquée). */
function missingTable(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  return err.code === "42P01" || err.code === "PGRST205" || /does not exist|schema cache/i.test(err.message ?? "");
}

export const journeyKey = (uid: string | undefined) => ["user_journey_profile", uid] as const;

/**
 * Le profil de la personne connectée. `undefined` pendant le chargement,
 * `null` si elle n'a jamais commencé le parcours. Si la migration manque, on
 * fait comme si le parcours était fait : il ne doit jamais bloquer l'accès.
 */
export function useJourneyProfile() {
  const { user } = useAuth();
  return useQuery({
    queryKey: journeyKey(user?.id),
    enabled: !!user?.id,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<JourneyProfile | null> => {
      const { data, error } = await supabase
        .from("user_onboarding_profiles").select("*").eq("user_id", user!.id).maybeSingle();
      if (missingTable(error)) {
        return { user_id: user!.id, completed_at: "n/a", skipped_at: null } as unknown as JourneyProfile;
      }
      if (error) throw error;
      return (data as JourneyProfile | null) ?? null;
    },
  });
}

/** Le parcours reste à faire : ni terminé, ni passé. */
export function journeyPending(p: JourneyProfile | null | undefined): boolean {
  if (p === undefined) return false;
  return !p || (!p.completed_at && !p.skipped_at);
}

export function useSaveJourney() {
  const { user } = useAuth();
  const qc = useQueryClient();
  return async (patch: JourneyPatch) => {
    if (!user?.id) return;
    const row = { user_id: user.id, ...patch, updated_at: new Date().toISOString() };
    const { error } = await supabase.from("user_onboarding_profiles").upsert(row, { onConflict: "user_id" });
    if (error && !missingTable(error)) throw new Error(error.message);
    // Le prénom sert aussi ailleurs (profiles.full_name, lu par les listes de membres).
    if (patch.first_name) {
      await supabase.from("profiles").upsert({ id: user.id, full_name: patch.first_name }, { onConflict: "id" }).then(() => {}, () => {});
    }
    qc.setQueryData(journeyKey(user.id), (old: JourneyProfile | null | undefined) => ({ ...(old ?? {}), ...row }) as JourneyProfile);
  };
}

/** Vrai pour un membre de l'équipe qui opère la plateforme. */
export function useIsPlatformStaff() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["is_platform_staff", user?.id],
    enabled: !!user?.id,
    staleTime: 10 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("is_platform_staff");
      if (error) return false;
      return data === true;
    },
  });
}

/** Le prénom à afficher : celui du parcours, sinon celui du compte, sinon l'adresse. */
export function useFirstName(): string {
  const { user } = useAuth();
  const { data } = useJourneyProfile();
  const fromJourney = data?.first_name?.trim();
  if (fromJourney) return fromJourney;
  const meta = (user?.user_metadata?.name as string | undefined) || (user?.user_metadata?.full_name as string | undefined);
  return (meta || user?.email?.split("@")[0] || "").split(" ")[0];
}
