// Les opérations d'un connecteur : ce qu'un collaborateur peut demander, et
// rien d'autre. Chaque opération porte son niveau de risque, qui décide de
// l'approbation ; « Irréversible » attend toujours un humain.
import { useState } from "react";
import {
  PlusIcon as Plus, TrashIcon as Trash2, CaretDownIcon as ChevronDown, CaretRightIcon as ChevronRight,
  PlayIcon as Play, CircleNotchIcon as Loader2, FileArrowUpIcon as FileUp, TerminalIcon as Terminal,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ToastProvider";
import { useConfirm } from "@/components/ConfirmProvider";
import { cn } from "@/lib/utils";
import {
  type ConnectorOperation, type OpParam, type TestOutcome, type Transport,
  connectorAction, normalizeOperation, referencedParams,
} from "./api";
import { parseOpenApi, type OpenApiImport } from "./openapi";
import { Field, Pill, RISK_META, SectionTitle, Segmented, inputCls, selectCls, textareaCls } from "./ui";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"] as const;

function kvToText(m: Record<string, string> | undefined): string {
  return Object.entries(m ?? {}).map(([k, v]) => `${k}=${v}`).join("\n");
}
function textToKv(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of s.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

export function OperationsSection({ connectorId, operations, onChange, transport, testOperation, onTestOperation, readOnly, savedVersion }: {
  connectorId: string | null;
  operations: ConnectorOperation[];
  onChange: (ops: ConnectorOperation[]) => void;
  transport: Transport;
  testOperation?: string;
  onTestOperation: (name: string) => void;
  readOnly: boolean;
  /** Les essais partent de la version ENREGISTRÉE : on prévient si elle diffère. */
  savedVersion: boolean;
}) {
  const confirm = useConfirm();
  const [open, setOpen] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);

  const update = (i: number, op: ConnectorOperation) => onChange(operations.map((o, j) => (j === i ? op : o)));
  const add = (kind: "http" | "exec") => {
    const base = kind === "exec"
      ? { name: `commande_${operations.length + 1}`, description: "", kind: "exec", binary: "helm", args: ["list", "--all-namespaces", "--output", "json"], risk: "read" }
      : { name: `operation_${operations.length + 1}`, description: "", method: "GET", path: "/", risk: "read" };
    const op = normalizeOperation(base);
    if (!op) return;
    onChange([...operations, op]);
    setOpen(operations.length);
  };

  return (
    <div>
      <SectionTitle
        aside={!readOnly && (
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setImporting(true)}><FileUp className="mr-1 h-3.5 w-3.5" /> Importer un OpenAPI</Button>
            {transport === "relay" && (
              <Button size="sm" variant="ghost" onClick={() => add("exec")}><Terminal className="mr-1 h-3.5 w-3.5" /> Commande</Button>
            )}
            <Button size="sm" variant="outline" onClick={() => add("http")}><Plus className="mr-1 h-3.5 w-3.5" /> Opération</Button>
          </div>
        )}
      >
        Opérations ({operations.length})
      </SectionTitle>

      {operations.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground">
          Aucune opération. Un collaborateur ne peut rien faire avec ce connecteur tant qu'il n'en a pas au moins une.
        </p>
      ) : (
        <div className="space-y-1.5">
          {operations.map((op, i) => (
            <div key={`${op.name}-${i}`} className="rounded-lg border border-border">
              <button
                type="button"
                onClick={() => setOpen(open === i ? null : i)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left"
              >
                {open === i ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                <span className="font-mono text-xs font-medium">{op.name}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                  {op.kind === "exec" ? `${op.binary} ${(op.args ?? []).join(" ")}` : `${op.method} ${op.path}`}
                </span>
                {testOperation === op.name && <Pill tone="blue">Test</Pill>}
                {op.output === "keys_only" && <Pill tone="violet" title="Les valeurs de la réponse sont masquées, seules les clés sont lues.">Clés seules</Pill>}
                <Pill tone={RISK_META[op.risk].tone} title={RISK_META[op.risk].hint}>{RISK_META[op.risk].label}</Pill>
              </button>
              {open === i && (
                <OperationEditor
                  op={op}
                  readOnly={readOnly}
                  transport={transport}
                  connectorId={connectorId}
                  savedVersion={savedVersion}
                  isTest={testOperation === op.name}
                  onTest={() => onTestOperation(op.name)}
                  onChange={(next) => update(i, next)}
                  onRemove={async () => {
                    if (!(await confirm({ title: `Retirer l'opération ${op.name} ?`, description: "Les collaborateurs qui l'utilisaient ne pourront plus l'appeler une fois le connecteur enregistré.", confirmText: "Retirer" }))) return;
                    onChange(operations.filter((_, j) => j !== i));
                    setOpen(null);
                  }}
                />
              )}
            </div>
          ))}
        </div>
      )}

      {importing && (
        <OpenApiDialog
          onClose={() => setImporting(false)}
          onImport={(picked) => {
            const names = new Set(operations.map((o) => o.name));
            onChange([...operations, ...picked.filter((o) => !names.has(o.name))]);
            setImporting(false);
          }}
        />
      )}
    </div>
  );
}

function OperationEditor({ op, onChange, onRemove, readOnly, transport, connectorId, savedVersion, isTest, onTest }: {
  op: ConnectorOperation;
  onChange: (op: ConnectorOperation) => void;
  onRemove: () => void;
  readOnly: boolean;
  transport: Transport;
  connectorId: string | null;
  savedVersion: boolean;
  isTest: boolean;
  onTest: () => void;
}) {
  const [bodyText, setBodyText] = useState(op.body === undefined ? "" : typeof op.body === "string" ? op.body : JSON.stringify(op.body, null, 2));
  const [bodyError, setBodyError] = useState<string | null>(null);
  // Brut pendant la saisie : normaliser à chaque frappe mangerait les espaces
  // et les « _ » de fin. La normalisation se fait à l'enregistrement.
  const set = (patch: Partial<ConnectorOperation>) => onChange({ ...op, ...patch });
  const setParam = (i: number, patch: Partial<OpParam>) =>
    set({ params: (op.params ?? []).map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  const unused = (op.params ?? []).filter((p) => !referencedParams(op).includes(p.name) && p.name !== "body").map((p) => p.name);

  return (
    <div className="space-y-3 border-t border-border px-3 py-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Nom" hint="Ce que le collaborateur appelle. Minuscules et _.">
          <input className={cn(inputCls, "font-mono")} disabled={readOnly} value={op.name}
            onChange={(e) => set({ name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 48) })} />
        </Field>
        <Field label="Niveau de risque" hint={RISK_META[op.risk].hint}>
          <select className={selectCls} disabled={readOnly} value={op.risk} onChange={(e) => set({ risk: e.target.value as ConnectorOperation["risk"] })}>
            <option value="read">Lecture</option>
            <option value="write">Écriture</option>
            <option value="destructive">Irréversible</option>
          </select>
        </Field>
      </div>
      <Field label="Ce qu'elle fait" hint="Le collaborateur choisit l'opération d'après cette phrase : soyez précis.">
        <input className={inputCls} disabled={readOnly} value={op.description} onChange={(e) => set({ description: e.target.value })} />
      </Field>

      {op.kind === "exec" ? (
        <div className="grid gap-3 sm:grid-cols-[140px_1fr]">
          <Field label="Binaire" hint="Autorisé côté relais (RELAY_ALLOWED_BINARIES).">
            <input className={cn(inputCls, "font-mono")} disabled={readOnly} value={op.binary ?? ""} onChange={(e) => set({ binary: e.target.value })} />
          </Field>
          <Field label="Arguments" hint="Un par ligne, {param} pour une valeur. Pas de shell : rien n'est interprété.">
            <textarea className={textareaCls} rows={4} disabled={readOnly} value={(op.args ?? []).join("\n")}
              onChange={(e) => set({ args: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })} />
          </Field>
          {transport !== "relay" && <p className="text-[11px] text-amber-600 sm:col-span-2">Une commande ne s'exécute que sur un relais.</p>}
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-[110px_1fr]">
            <Field label="Méthode">
              <select className={selectCls} disabled={readOnly} value={op.method}
                onChange={(e) => set({ method: e.target.value as ConnectorOperation["method"] })}>
                {METHODS.map((m) => <option key={m}>{m}</option>)}
              </select>
            </Field>
            <Field label="Chemin" hint="Relatif à l'URL de base. {param} est encodé, « .. » refusé.">
              <input className={cn(inputCls, "font-mono")} disabled={readOnly} value={op.path ?? "/"} onChange={(e) => set({ path: e.target.value })} />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Paramètres d'URL" hint="nom=valeur, un par ligne. Omis si le {param} est vide.">
              <textarea className={textareaCls} rows={3} disabled={readOnly} defaultValue={kvToText(op.query)}
                onBlur={(e) => set({ query: textToKv(e.target.value) })} />
            </Field>
            <Field label="En-têtes fixes" hint="Non secrets. Les secrets vont dans les identifiants.">
              <textarea className={textareaCls} rows={3} disabled={readOnly} defaultValue={kvToText(op.headers)}
                onBlur={(e) => set({ headers: textToKv(e.target.value) })} />
            </Field>
          </div>
          {op.method !== "GET" && op.method !== "HEAD" && (
            <Field label="Corps JSON" hint={bodyError ?? "\"{param}\" seul reçoit la valeur typée ; une clé dont le paramètre manque est omise."}>
              <textarea className={cn(textareaCls, bodyError && "border-red-500")} rows={5} disabled={readOnly} value={bodyText}
                onChange={(e) => setBodyText(e.target.value)}
                onBlur={() => {
                  if (!bodyText.trim()) { setBodyError(null); set({ body: undefined }); return; }
                  try { set({ body: JSON.parse(bodyText) }); setBodyError(null); }
                  catch { setBodyError("JSON invalide."); }
                }} />
            </Field>
          )}
        </>
      )}

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-xs font-medium">Paramètres</span>
          {!readOnly && (
            <button type="button" className="text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => set({ params: [...(op.params ?? []), { name: `param_${(op.params ?? []).length + 1}`, type: "string" }] })}>
              + Ajouter
            </button>
          )}
        </div>
        {(op.params ?? []).length === 0 ? (
          <p className="text-[11px] text-muted-foreground">Aucun. Un {"{param}"} cité dans le chemin, la requête ou le corps est ajouté automatiquement.</p>
        ) : (
          <div className="space-y-1.5">
            {(op.params ?? []).map((p, i) => (
              <div key={i} className="grid grid-cols-[1fr_90px_auto_auto] items-center gap-1.5 sm:grid-cols-[130px_90px_1fr_auto_auto]">
                <input className={cn(inputCls, "h-8 font-mono text-xs")} disabled={readOnly} value={p.name}
                  onChange={(e) => setParam(i, { name: e.target.value.replace(/[^A-Za-z0-9_]/g, "_") })} />
                <select className={cn(selectCls, "h-8 text-xs")} disabled={readOnly} value={p.type} onChange={(e) => setParam(i, { type: e.target.value as OpParam["type"] })}>
                  <option value="string">texte</option><option value="number">nombre</option>
                  <option value="boolean">booléen</option><option value="object">objet</option>
                </select>
                <input className={cn(inputCls, "hidden h-8 text-xs sm:flex")} disabled={readOnly} placeholder="Description" value={p.description ?? ""}
                  onChange={(e) => setParam(i, { description: e.target.value })} />
                <label className="flex items-center gap-1 text-[11px] text-muted-foreground" title="Obligatoire">
                  <input type="checkbox" disabled={readOnly} checked={!!p.required} onChange={(e) => setParam(i, { required: e.target.checked })} /> requis
                </label>
                {!readOnly && (
                  <button type="button" className="p-1 text-muted-foreground hover:text-destructive" aria-label="Retirer"
                    onClick={() => set({ params: (op.params ?? []).filter((_, j) => j !== i) })}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
            {unused.length > 0 && <p className="text-[11px] text-amber-600">Non utilisé(s) dans la requête : {unused.join(", ")}.</p>}
          </div>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Réponse lue par le collaborateur">
          <select className={selectCls} disabled={readOnly} value={op.output ?? ""} onChange={(e) => set({ output: (e.target.value || undefined) as ConnectorOperation["output"] })}>
            <option value="">Selon la politique du connecteur</option>
            <option value="redact">Secrets masqués</option>
            <option value="keys_only">Clés seulement, valeurs masquées</option>
            <option value="full">Intégrale</option>
          </select>
        </Field>
        <Field label="Délai maximal (ms)">
          <input type="number" className={inputCls} disabled={readOnly} value={op.timeout_ms ?? ""} placeholder="30000"
            onChange={(e) => set({ timeout_ms: e.target.value ? Number(e.target.value) : undefined })} />
        </Field>
      </div>

      <TryOperation op={op} connectorId={connectorId} savedVersion={savedVersion} />

      {!readOnly && (
        <div className="flex items-center justify-between border-t border-border pt-3">
          <button type="button" onClick={onTest} disabled={isTest}
            className="text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-60">
            {isTest ? "Opération utilisée pour « Tester la connexion »" : "Utiliser pour « Tester la connexion »"}
          </button>
          <Button size="sm" variant="ghost" onClick={onRemove}><Trash2 className="mr-1 h-3.5 w-3.5 text-destructive" /> Retirer</Button>
        </div>
      )}
    </div>
  );
}

function TryOperation({ op, connectorId, savedVersion }: { op: ConnectorOperation; connectorId: string | null; savedVersion: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [params, setParams] = useState(() =>
    JSON.stringify(Object.fromEntries((op.params ?? []).filter((p) => p.required).map((p) => [p.name, p.default ?? ""])), null, 0));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestOutcome | null>(null);

  async function run() {
    if (!connectorId) return;
    let parsed: Record<string, unknown> = {};
    try { parsed = params.trim() ? JSON.parse(params) : {}; } catch { toast.error("Paramètres : JSON invalide"); return; }
    let confirmWrite = false;
    if (op.risk !== "read") {
      confirmWrite = await confirm({
        title: `Exécuter ${op.name} pour de vrai ?`,
        description: `C'est une opération « ${RISK_META[op.risk].label} » : l'essai agit réellement sur l'outil. Il sera inscrit au journal d'accès à votre nom.`,
        confirmText: "Exécuter",
      });
      if (!confirmWrite) return;
    }
    setBusy(true);
    try {
      const out = await connectorAction<TestOutcome>({ mode: "custom.test", connector_id: connectorId, operation: op.name, params: parsed, confirm: confirmWrite });
      setResult(out);
    } catch (e) {
      setResult({ ok: false, decision: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg bg-muted/40 p-2.5">
      <div className="flex items-center gap-2">
        <input className={cn(inputCls, "h-8 flex-1 bg-background font-mono text-xs")} value={params} onChange={(e) => setParams(e.target.value)}
          placeholder='{"name": "payments"}' aria-label="Paramètres de l'essai" />
        <Button size="sm" variant="outline" onClick={run} disabled={busy || !connectorId}>
          {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Play className="mr-1 h-3.5 w-3.5" />} Essayer
        </Button>
      </div>
      {!connectorId && <p className="mt-1.5 text-[11px] text-muted-foreground">Enregistrez le connecteur pour pouvoir l'essayer.</p>}
      {connectorId && !savedVersion && <p className="mt-1.5 text-[11px] text-amber-600">L'essai utilise la version enregistrée, pas vos modifications en cours.</p>}
      {result && (
        <pre className={cn("mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border p-2 font-mono text-[11px]",
          result.ok ? "border-emerald-500/30 bg-background" : "border-amber-500/30 bg-background")}>
          {result.text}
        </pre>
      )}
    </div>
  );
}

function OpenApiDialog({ onClose, onImport }: { onClose: () => void; onImport: (ops: ConnectorOperation[]) => void }) {
  const [text, setText] = useState("");
  const [parsed, setParsed] = useState<OpenApiImport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<"read" | "all">("read");

  function analyse(src: string) {
    try {
      const r = parseOpenApi(src);
      setParsed(r);
      setError(null);
      setPicked(new Set(r.operations.filter((o) => o.risk === "read").slice(0, 40).map((o) => o.name)));
    } catch (e) {
      setParsed(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const shown = (parsed?.operations ?? []).filter((o) => filter === "all" || o.risk === "read");

  return (
    <>
      <div className="fixed inset-0 z-[60] bg-black/40" onClick={onClose} />
      <div className="fixed left-1/2 top-1/2 z-[60] flex max-h-[85vh] w-[min(720px,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border border-border bg-card shadow-2xl">
        <div className="border-b border-border px-5 py-3.5">
          <h3 className="text-sm font-semibold">Importer une spec OpenAPI</h3>
          <p className="text-[11px] text-muted-foreground">JSON ou YAML, OpenAPI 3 ou Swagger 2. Rien ne part : l'analyse se fait dans votre navigateur.</p>
        </div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {!parsed ? (
            <>
              <textarea className={textareaCls} rows={12} value={text} onChange={(e) => setText(e.target.value)} placeholder="Collez la spec ici, ou choisissez un fichier." />
              <div className="flex items-center justify-between">
                <input type="file" accept=".json,.yaml,.yml" className="text-xs"
                  onChange={async (e) => { const f = e.target.files?.[0]; if (f) { const t = await f.text(); setText(t); analyse(t); } }} />
                <Button size="sm" onClick={() => analyse(text)} disabled={!text.trim()}>Analyser</Button>
              </div>
              {error && <p className="text-xs text-red-600">{error}</p>}
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs"><span className="font-medium">{parsed.title}</span> · {parsed.operations.length} routes{parsed.baseUrl ? ` · ${parsed.baseUrl}` : ""}</p>
                <Segmented size="sm" value={filter} onChange={setFilter} options={[{ value: "read", label: "Lectures" }, { value: "all", label: "Toutes" }]} />
              </div>
              <p className="text-[11px] text-muted-foreground">Ne retenez que ce dont vos collaborateurs ont besoin. Le niveau de risque est déduit de la méthode : relisez-le après l'import.</p>
              <div className="space-y-1">
                {shown.map((o) => (
                  <label key={o.name} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-secondary/40">
                    <input type="checkbox" checked={picked.has(o.name)}
                      onChange={(e) => setPicked((s) => { const n = new Set(s); if (e.target.checked) n.add(o.name); else n.delete(o.name); return n; })} />
                    <span className="w-14 font-mono text-[10px] text-muted-foreground">{o.method}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{o.path}</span>
                    <span className="hidden max-w-[40%] truncate text-[11px] text-muted-foreground sm:block">{o.description}</span>
                    <Pill tone={RISK_META[o.risk].tone}>{RISK_META[o.risk].label}</Pill>
                  </label>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          <Button size="sm" variant="ghost" onClick={onClose}>Annuler</Button>
          {parsed && (
            <Button size="sm" disabled={picked.size === 0}
              onClick={() => onImport(parsed.operations.filter((o) => picked.has(o.name)))}>
              Importer {picked.size} opération{picked.size > 1 ? "s" : ""}
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
