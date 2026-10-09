// Outils internes : les outils que l'entreprise héberge elle-même (Argo CD,
// Vault, Grafana, Loki, Kubernetes, Helm, une API maison), rendus utilisables
// par les collaborateurs avec les accès, les garde-fous et la traçabilité que
// l'entreprise décide. Composio couvre le reste du marché ; ceci couvre chez soi.
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  PlusIcon as Plus, SparkleIcon as Sparkle, WrenchIcon as Wrench, HardDrivesIcon as Server, FileArrowUpIcon as FileUp,
  WarningIcon as AlertTriangle, CheckCircleIcon as CheckCircle2, XCircleIcon as XCircle, CircleIcon as Dot,
  ArrowRightIcon as ArrowRight, GlobeIcon as Globe, CircleNotchIcon as Loader2,
} from "@phosphor-icons/react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { useToast } from "@/components/ToastProvider";
import { usePromptText } from "@/components/ConfirmProvider";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import { useAssistant } from "@/lib/assistant-context";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import {
  AUTH_SCHEMES, CONNECTOR_TEMPLATES, type ConnectorTemplate, type CustomConnector,
  connectorSetupIssues, normalizeAuthConfig, normalizeOperations, normalizePolicy, qk, relayOnline, relativeTime, toSlug,
  useConnectors, useCredentials, useRelays,
} from "./api";
import { parseOpenApi } from "./openapi";
import { ConnectorEditor } from "./ConnectorEditor";
import { RelaysPanel } from "./RelaysPanel";
import { AccessLog } from "./AccessLog";
import { Drawer, Pill, RISK_META, Segmented, textareaCls } from "./ui";

type View = "connectors" | "relays" | "log";

export function CustomConnectorsPage({ serviceDashboardId }: { serviceDashboardId: string | null }) {
  const { workspaceId, projectId, role } = useCurrentContext();
  const canEdit = role === "owner" || role === "admin";
  const toast = useToast();
  const assistant = useAssistant();
  const promptText = usePromptText();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<View>("connectors");
  const [creating, setCreating] = useState(false);

  const { data: connectors, isLoading } = useConnectors(projectId);
  const { data: relays } = useRelays(projectId);
  const ids = useMemo(() => (connectors ?? []).map((c) => c.id), [connectors]);
  const { data: credentials } = useCredentials(projectId, ids);

  // Ceux du service, et ceux ouverts à tout le projet.
  const visible = (connectors ?? []).filter((c) => !c.service_dashboard_id || !serviceDashboardId || c.service_dashboard_id === serviceDashboardId);
  const openId = params.get("connector");
  const open = visible.find((c) => c.id === openId) ?? null;
  const setOpen = (id: string | null) => setParams((p) => {
    const n = new URLSearchParams(p);
    if (id) n.set("connector", id); else n.delete("connector");
    return n;
  }, { replace: true });

  useEffect(() => {
    if (openId) setView("connectors");
  }, [openId]);

  async function create(input: Partial<CustomConnector> & { name: string; created_via: string }) {
    if (!workspaceId || !projectId) return;
    const taken = new Set((connectors ?? []).map((c) => c.slug));
    let slug = toSlug(input.name);
    for (let i = 2; taken.has(slug); i++) slug = `${toSlug(input.name).slice(0, 44)}-${i}`;
    const activeRelays = (relays ?? []).filter((r) => r.status === "active");
    const transport = input.transport ?? "relay";
    const { data, error } = await supabase.from("custom_connectors").insert({
      workspace_id: workspaceId, project_id: projectId, service_dashboard_id: serviceDashboardId,
      slug, status: "draft",
      relay_id: transport === "relay" && activeRelays.length === 1 ? activeRelays[0].id : null,
      ...input,
      transport,
    }).select("id").single();
    if (error || !data) { toast.error("Création impossible", error?.message); return; }
    await queryClient.invalidateQueries({ queryKey: qk.connectors(projectId) });
    setCreating(false);
    setOpen(data.id);
  }

  function fromTemplate(t: ConnectorTemplate) {
    return create({
      name: t.name, template_key: t.key, description: t.description, base_url: "",
      transport: t.default_transport, auth_scheme: t.auth_scheme, auth_config: normalizeAuthConfig(t.auth_config) as Record<string, unknown>,
      operations: normalizeOperations(t.operations), policy: normalizePolicy(t.policy ?? {}), setup_notes: t.setup_notes,
      created_via: t.key === "generic" ? "manual" : "template",
    });
  }

  async function askAssistant() {
    const what = await promptText({
      title: "Demander un connecteur à l'assistant",
      description: "Décrivez l'outil : son nom, à quoi il sert, ce que les collaborateurs doivent pouvoir y faire. L'assistant rédige un brouillon à compléter ; il ne vous demandera aucun secret.",
      label: "L'outil",
      placeholder: "Notre Harbor interne : lister les images d'un projet et leurs vulnérabilités, en lecture seule.",
      confirmText: "Rédiger le brouillon",
    });
    if (!what?.trim()) return;
    setCreating(false);
    assistant.ask({
      prompt: `Rédige un brouillon d'outil interne avec manage_connectors (action draft) : ${what.trim()}\n` +
        "Pars d'un modèle s'il en existe un, sinon écris les opérations d'après la documentation officielle de l'API, lecture d'abord. " +
        "Ne me demande aucun secret : termine par ce qu'il me reste à compléter dans la fiche.",
      autoSend: true,
      newChat: true,
    });
  }

  const issuesOf = (c: CustomConnector) =>
    connectorSetupIssues(c, (credentials ?? []).filter((x) => x.connector_id === c.id && x.status === "active").length);

  return (
    <div className={cn(serviceDashboardId && "px-14 py-8 xl:px-20")}>
      <PageHeader
        title="Outils internes"
        description="Argo CD, Vault, Grafana, une API maison : vos outils, sur vos URL, avec vos accès. Chaque appel d'un collaborateur est borné, approuvé quand il le faut, et journalisé."
        actions={view === "connectors" && canEdit ? (
          <>
            <Button size="sm" variant="outline" onClick={askAssistant}><Sparkle className="mr-1 h-3.5 w-3.5" /> Demander à l'assistant</Button>
            <Button size="sm" onClick={() => setCreating(true)}><Plus className="mr-1 h-3.5 w-3.5" /> Nouveau connecteur</Button>
          </>
        ) : undefined}
      />

      <Segmented value={view} onChange={setView} options={[
        { value: "connectors", label: `Connecteurs${visible.length ? ` (${visible.length})` : ""}` },
        { value: "relays", label: `Relais${(relays ?? []).length ? ` (${(relays ?? []).filter((r) => r.status === "active").length})` : ""}` },
        { value: "log", label: "Journal d'accès" },
      ]} />

      <div className="mt-6">
        {view === "connectors" && (
          isLoading ? <EmptyState icon={Loader2} title="Chargement…" />
          : visible.length === 0 ? (
            <div className="space-y-6">
              <EmptyState icon={Wrench} title="Aucun outil interne"
                description="Partez d'un modèle, importez une spec OpenAPI ou laissez l'assistant rédiger le brouillon. Vous complétez ensuite l'URL et le secret." />
              {canEdit && <TemplateGallery onPick={fromTemplate} />}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {visible.map((c) => {
                const issues = issuesOf(c);
                const ops = normalizeOperations(c.operations);
                const relay = (relays ?? []).find((r) => r.id === c.relay_id);
                let host = "";
                try { host = c.base_url ? new URL(c.base_url).host : ""; } catch { host = c.base_url; }
                return (
                  <button key={c.id} type="button" onClick={() => setOpen(c.id)}
                    className="group flex flex-col rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/40">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{c.name}</div>
                        <div className="truncate font-mono text-[11px] text-muted-foreground">{host || "URL à renseigner"}</div>
                      </div>
                      <Pill tone={c.status === "active" ? "green" : c.status === "draft" ? "amber" : "muted"}>
                        {c.status === "active" ? "Actif" : c.status === "draft" ? "Brouillon" : "Désactivé"}
                      </Pill>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {c.transport === "relay" ? (
                        <Pill tone={relay && relayOnline(relay) ? "green" : "amber"} title="Passe par le relais déployé chez vous">
                          <Dot weight="fill" className="h-2 w-2" /> {relay ? `Relais ${relay.name}` : "Relais à choisir"}
                        </Pill>
                      ) : <Pill tone="blue"><Globe className="h-2.5 w-2.5" /> Direct</Pill>}
                      <Pill>{AUTH_SCHEMES.find((s) => s.key === c.auth_scheme)?.label ?? c.auth_scheme}</Pill>
                      {c.service_dashboard_id ? null : <Pill tone="violet">Tout le projet</Pill>}
                      {c.created_via === "assistant" && <Pill tone="violet"><Sparkle className="h-2.5 w-2.5" /> Assistant</Pill>}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                      {(["read", "write", "destructive"] as const).map((r) => {
                        const n = ops.filter((o) => o.risk === r).length;
                        const word = { read: ["lecture", "lectures"], write: ["écriture", "écritures"], destructive: ["irréversible", "irréversibles"] }[r][n > 1 ? 1 : 0];
                        return n ? <span key={r}>{n} {word}</span> : null;
                      })}
                      {!ops.length && <span>Aucune opération</span>}
                    </div>
                    <div className="mt-auto pt-3 text-[11px]">
                      {issues.length ? (
                        <span className="inline-flex items-center gap-1 text-amber-600"><AlertTriangle className="h-3.5 w-3.5" /> {issues.length} point{issues.length > 1 ? "s" : ""} à compléter</span>
                      ) : c.last_test_at ? (
                        <span className={cn("inline-flex items-center gap-1", c.last_test_ok ? "text-emerald-600" : "text-amber-600")}>
                          {c.last_test_ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
                          Test {c.last_test_ok ? "réussi" : "en échec"} {relativeTime(c.last_test_at)}
                        </span>
                      ) : <span className="text-muted-foreground">Jamais testé</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          )
        )}
        {view === "relays" && <RelaysPanel relays={relays ?? []} workspaceId={workspaceId} projectId={projectId} canEdit={canEdit} />}
        {view === "log" && <AccessLog workspaceId={workspaceId} connectors={connectors ?? []} />}
      </div>

      {creating && (
        <Drawer title="Nouveau connecteur" subtitle="Un brouillon est inerte : aucun collaborateur ne le voit avant son activation." onClose={() => setCreating(false)}>
          <div className="space-y-6 px-5 py-5">
            <div className="grid gap-2 sm:grid-cols-2">
              <QuickAction icon={Sparkle} title="Demander à l'assistant" text="Décrivez l'outil, il rédige les opérations." onClick={askAssistant} />
              <OpenApiCreate onCreate={create} />
            </div>
            <TemplateGallery onPick={fromTemplate} />
          </div>
        </Drawer>
      )}

      {open && (
        <ConnectorEditor
          key={open.id}
          connector={open}
          credentials={(credentials ?? []).filter((x) => x.connector_id === open.id)}
          relays={relays ?? []}
          serviceDashboardId={serviceDashboardId}
          canEdit={canEdit}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

function QuickAction({ icon: Icon, title, text, onClick }: { icon: typeof Plus; title: string; text: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="flex items-start gap-3 rounded-xl border border-border p-3 text-left transition-colors hover:border-primary/40 hover:bg-secondary/30">
      <Icon className="mt-0.5 h-4 w-4 text-primary" />
      <span>
        <span className="block text-xs font-medium">{title}</span>
        <span className="block text-[11px] text-muted-foreground">{text}</span>
      </span>
    </button>
  );
}

function TemplateGallery({ onPick }: { onPick: (t: ConnectorTemplate) => void }) {
  const groups = useMemo(() => {
    const m = new Map<string, ConnectorTemplate[]>();
    for (const t of CONNECTOR_TEMPLATES) m.set(t.category, [...(m.get(t.category) ?? []), t]);
    return [...m.entries()];
  }, []);
  return (
    <div className="space-y-5">
      {groups.map(([cat, items]) => (
        <section key={cat}>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{cat}</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {items.map((t) => (
              <button key={t.key} type="button" onClick={() => onPick(t)}
                className="group flex items-start justify-between gap-3 rounded-xl border border-border p-3 text-left transition-colors hover:border-primary/40 hover:bg-secondary/30">
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-xs font-medium">
                    {t.name}
                    {t.default_transport === "relay" && <Server className="h-3 w-3 text-muted-foreground" aria-label="Relais conseillé" />}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{t.description}</span>
                  <span className="mt-1 block text-[10px] text-muted-foreground">
                    {t.operations.length ? `${t.operations.length} opérations · ` : ""}{AUTH_SCHEMES.find((s) => s.key === t.auth_scheme)?.label}
                  </span>
                </span>
                <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function OpenApiCreate({ onCreate }: { onCreate: (c: Partial<CustomConnector> & { name: string; created_via: string }) => Promise<void> }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function go(src: string) {
    setBusy(true);
    try {
      const r = parseOpenApi(src);
      // Lectures d'abord : les écritures s'ajoutent ensuite, opération par opération.
      const reads = r.operations.filter((o) => o.risk === "read").slice(0, 40);
      await onCreate({
        name: r.title, base_url: r.baseUrl, transport: "relay",
        auth_scheme: r.auth?.scheme ?? "bearer", auth_config: (r.auth?.config ?? { header: "Authorization", prefix: "Bearer " }) as Record<string, unknown>,
        operations: reads, policy: normalizePolicy({}), created_via: "openapi",
        setup_notes: `Importé d'OpenAPI : ${reads.length} lecture(s) retenue(s) sur ${r.operations.length} routes. Ajoutez les écritures utiles depuis « Importer un OpenAPI » dans l'onglet Opérations, puis relisez leur niveau de risque.`,
      });
    } catch (e) {
      toast.error("Spec illisible", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return <QuickAction icon={FileUp} title="Importer un OpenAPI" text="Une spec JSON ou YAML devient des opérations." onClick={() => setOpen(true)} />;
  return (
    <div className="space-y-2 rounded-xl border border-border p-3 sm:col-span-2">
      <span className="text-xs font-medium">Spec OpenAPI ou Swagger</span>
      <textarea className={textareaCls} rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="Collez la spec, ou choisissez un fichier." />
      <div className="flex items-center justify-between gap-2">
        <input type="file" accept=".json,.yaml,.yml" className="text-xs" onChange={async (e) => { const f = e.target.files?.[0]; if (f) setText(await f.text()); }} />
        <div className="flex gap-2">
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Annuler</Button>
          <Button size="sm" onClick={() => go(text)} disabled={!text.trim() || busy}>{busy && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />} Créer le brouillon</Button>
        </div>
      </div>
    </div>
  );
}
