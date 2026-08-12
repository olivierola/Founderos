import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import {
  fetchEntitlements, fetchPlans, fetchCreditPacks,
  type Entitlements, type BillingPlan, type CreditPack,
} from "@/lib/billing";

/**
 * Droits et consommation du workspace courant.
 *
 * Rafraîchi toutes les 60 s : les crédits bougent pendant qu'un agent travaille,
 * et un compteur figé qui annonce « il vous reste 12 000 crédits » alors que le
 * run vient d'être bloqué est pire que pas de compteur du tout.
 */
export function useEntitlements() {
  const { workspaceId } = useCurrentContext();
  const query = useQuery<Entitlements>({
    queryKey: ["entitlements", workspaceId],
    enabled: !!workspaceId,
    queryFn: () => fetchEntitlements(workspaceId!),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  return { ...query, entitlements: query.data ?? null, workspaceId };
}

export function usePlans() {
  return useQuery<BillingPlan[]>({
    queryKey: ["billing-plans"],
    queryFn: fetchPlans,
    staleTime: 10 * 60_000, // le catalogue ne bouge pas pendant une session
  });
}

export function useCreditPacks() {
  return useQuery<CreditPack[]>({
    queryKey: ["credit-packs"],
    queryFn: fetchCreditPacks,
    staleTime: 10 * 60_000,
  });
}

/** À appeler après un achat ou une création de ressource limitée. */
export function useInvalidateEntitlements() {
  const qc = useQueryClient();
  return (workspaceId?: string | null) =>
    qc.invalidateQueries({ queryKey: ["entitlements", workspaceId ?? undefined] });
}

/**
 * Une fonctionnalité est-elle ouverte par l'offre ? Renvoie `true` tant que les
 * droits ne sont pas chargés : masquer une fonctionnalité déjà payée le temps
 * d'un aller-retour réseau est plus grave que de l'afficher une seconde de trop
 * — le serveur reste l'autorité en cas d'abus.
 */
export function useFeature(key: string): boolean {
  const { entitlements } = useEntitlements();
  if (!entitlements) return true;
  return entitlements.plan.features?.[key] !== false;
}
