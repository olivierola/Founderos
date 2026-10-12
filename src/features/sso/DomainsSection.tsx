// Administration → Authentification → Domaines (mode partagé, migration 0282).
//
// Sur une instance partagée par plusieurs organisations, un fournisseur SSO ne
// vaut que pour les domaines e-mail que l'organisation a prouvé posséder : un
// enregistrement DNS TXT _founderos-sso.<domaine>. Un domaine n'est vérifié que
// par une seule organisation, et la base refuse toute connexion SSO hors des
// domaines vérifiés de l'organisation du fournisseur.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon as Check, CopyIcon as Copy, TrashIcon as Trash, CircleNotchIcon as Loader2 } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ToastProvider";
import { useConfirm } from "@/components/ConfirmProvider";
import { cn } from "@/lib/utils";
import { Pill, SectionTitle, Toggle, inputCls } from "@/features/custom-connectors/ui";
import { addDomain, listDomains, qk, removeDomain, saveDomainSsoOnly, verifyDomain, type SsoDomain } from "./api";

export function useSsoDomains(workspaceId: string, enabled = true) {
  return useQuery({ queryKey: qk.domains(workspaceId), enabled, queryFn: () => listDomains(workspaceId) });
}

export function DomainsSection({ workspaceId, coveredDomains }: { workspaceId: string; coveredDomains: string[] }) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const domains = useSsoDomains(workspaceId);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["sso"] });

  async function add() {
    const d = draft.trim().toLowerCase();
    if (!d) return;
    setAdding(true);
    try {
      await addDomain(workspaceId, d);
      setDraft("");
      refresh();
    } catch (e) {
      toast.error("Domaine refusé", e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  }

  return (
    <section>
      <SectionTitle>Domaines de l'organisation</SectionTitle>
      <p className="mb-3 max-w-2xl text-xs text-muted-foreground">
        Le SSO ne vaut que pour les adresses des domaines que vous avez vérifiés. Publiez l'enregistrement TXT indiqué dans
        le DNS du domaine, puis vérifiez. Un domaine n'appartient qu'à une organisation ; toute connexion SSO d'une
        adresse d'un autre domaine est refusée.
      </p>
      {domains.isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : (
        <div className="space-y-2">
          {(domains.data ?? []).map((d) => (
            <DomainRow key={d.id} workspaceId={workspaceId} domain={d} covered={coveredDomains.includes(d.domain)} onChanged={refresh} />
          ))}
          {(domains.data ?? []).length === 0 && <p className="text-sm text-muted-foreground">Aucun domaine pour l'instant.</p>}
        </div>
      )}
      <div className="mt-3 flex max-w-md gap-2">
        <input className={cn(inputCls, "h-8 text-xs")} placeholder="entreprise.fr" value={draft}
          onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void add(); }} />
        <Button size="sm" variant="outline" onClick={add} disabled={adding || !draft.trim()}>
          {adding && <Loader2 className="mr-1 h-3 w-3 animate-spin" />} Ajouter
        </Button>
      </div>
    </section>
  );
}

function DomainRow({ workspaceId, domain: d, covered, onChanged }: {
  workspaceId: string; domain: SsoDomain; covered: boolean; onChanged: () => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const record = `_founderos-sso.${d.domain}`;

  async function verify() {
    setBusy(true);
    setDetail(null);
    try {
      const out = await verifyDomain(workspaceId, d.id);
      if (out.ok) { toast.success("Domaine vérifié", out.detail); onChanged(); } else setDetail(out.detail);
    } catch (e) {
      setDetail(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!(await confirm({ title: `Retirer ${d.domain} ?`, description: "Ses adresses ne pourront plus se connecter par le SSO de l'organisation.", confirmText: "Retirer" }))) return;
    try {
      await removeDomain(workspaceId, d.id);
      onChanged();
    } catch (e) {
      toast.error("Retrait refusé", e instanceof Error ? e.message : String(e));
    }
  }
  async function toggleSsoOnly(v: boolean) {
    try {
      await saveDomainSsoOnly(workspaceId, d.id, v);
      onChanged();
    } catch (e) {
      toast.error("Réglage refusé", e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="max-w-3xl rounded-xl border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm">{d.domain}</span>
        <Pill tone={d.verified_at ? "green" : "amber"}>{d.verified_at ? "Vérifié" : "À vérifier"}</Pill>
        {d.verified_at && !covered && <Pill tone="muted">aucun fournisseur</Pill>}
        <div className="ml-auto flex gap-1">
          {!d.verified_at && (
            <Button size="sm" variant="outline" onClick={verify} disabled={busy}>
              {busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />} Vérifier
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={remove}><Trash className="h-3.5 w-3.5" /></Button>
        </div>
      </div>
      {!d.verified_at && (
        <div className="mt-2 space-y-1.5 text-[11px]">
          <p className="text-muted-foreground">Dans le DNS de {d.domain}, créez un enregistrement :</p>
          <CopyField label="Type" value="TXT" />
          <CopyField label="Nom" value={record} />
          <CopyField label="Valeur" value={d.verification_token} />
          {detail && <p className="text-amber-700 dark:text-amber-300">{detail}</p>}
        </div>
      )}
      {d.verified_at && (
        <div className="mt-2">
          <Toggle
            checked={d.sso_only}
            onChange={toggleSsoOnly}
            disabled={!covered}
            label="SSO seulement pour ce domaine"
            hint="Sur la page de connexion, une adresse de ce domaine ne se voit plus proposer le mot de passe. Il faut un fournisseur actif pour ce domaine."
          />
        </div>
      )}
    </div>
  );
}

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono" title={value}>{value}</code>
      <button type="button" aria-label={`Copier ${label}`} className="rounded p-1 text-muted-foreground hover:text-foreground"
        onClick={async () => { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>
        {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}
