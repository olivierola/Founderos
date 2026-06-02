import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Save, Check, ShieldAlert, Server, KeyRound, Copy, Plus, Trash2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/lib/supabase";
import { callEdge } from "@/lib/edge";
import { useCurrentContext } from "@/hooks/useCurrentContext";
import type { OpsSettings, OpsAutonomyMode } from "./types";

const AUTONOMY_INFO: Record<OpsAutonomyMode, { label: string; description: string }> = {
  advisor: { label: "Advisor", description: "AI generates files and explains, but never applies anything." },
  assisted: { label: "Assisted", description: "AI prepares jobs. You approve each high-risk step." },
  controlled: { label: "Controlled", description: "AI applies low-risk jobs automatically. High-risk still gated." },
  autopilot: { label: "Autopilot", description: "AI runs everything within allowlist + risk budget. Audit only." },
};

export function OpsSettingsPage() {
  const { projectId, workspaceId } = useCurrentContext();
  const queryClient = useQueryClient();

  const { data: settings, isLoading } = useQuery({
    queryKey: ["ops_settings", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("ops_settings")
        .select("*")
        .eq("project_id", projectId!)
        .maybeSingle();
      return data as OpsSettings | null;
    },
  });

  const [autonomy, setAutonomy] = useState<OpsAutonomyMode>("assisted");
  const [runnerUrl, setRunnerUrl] = useState("");
  const [denylist, setDenylist] = useState<string[]>([]);
  const [allowlist, setAllowlist] = useState<string[]>([]);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [rotatingToken, setRotatingToken] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);

  useEffect(() => {
    if (settings) {
      setAutonomy(settings.default_autonomy_mode);
      setRunnerUrl(settings.runner_url ?? "");
      setDenylist(settings.command_denylist);
      setAllowlist(settings.command_allowlist);
    }
  }, [settings?.project_id]);

  async function save() {
    if (!projectId || !workspaceId) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from("ops_settings")
        .upsert({
          project_id: projectId,
          workspace_id: workspaceId,
          default_autonomy_mode: autonomy,
          runner_url: runnerUrl.trim() || null,
          command_denylist: denylist,
          command_allowlist: allowlist,
          updated_at: new Date().toISOString(),
        });
      if (error) throw error;
      setSavedAt(Date.now());
      queryClient.invalidateQueries({ queryKey: ["ops_settings", projectId] });
    } finally {
      setSaving(false);
    }
  }

  async function rotateToken() {
    setRotatingToken(true);
    try {
      const result = await callEdge<{ token: string }>("ops-rotate-runner-token", { project_id: projectId });
      setNewToken(result.token);
      queryClient.invalidateQueries({ queryKey: ["ops_settings", projectId] });
    } catch (e: any) {
      alert("Could not rotate: " + (e?.message ?? "edge not deployed"));
    } finally {
      setRotatingToken(false);
    }
  }

  if (isLoading) return <div className="flex h-48 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Ops Settings"
        description="Runner connection, autonomy mode, and the command safety guards."
        actions={
          <div className="flex items-center gap-2">
            {savedAt && Date.now() - savedAt < 4000 && (
              <span className="text-xs text-muted-foreground"><Check className="mr-1 inline h-3 w-3" /> Saved</span>
            )}
            <Button onClick={save} disabled={saving} className="gap-1.5">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Save
            </Button>
          </div>
        }
      />

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Autonomy mode</CardTitle></CardHeader>
        <CardContent>
          <div className="grid gap-2 md:grid-cols-2">
            {(Object.keys(AUTONOMY_INFO) as OpsAutonomyMode[]).map((mode) => {
              const info = AUTONOMY_INFO[mode];
              const active = autonomy === mode;
              const isAdvanced = mode === "autopilot";
              return (
                <button
                  key={mode}
                  onClick={() => setAutonomy(mode)}
                  className={`rounded-md border p-3 text-left transition-colors ${
                    active ? "border-foreground bg-foreground/5" : "border-border hover:border-foreground/30"
                  }`}
                >
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    {info.label}
                    {isAdvanced && <Badge variant="outline" className="text-[10px] text-amber-500">V2</Badge>}
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">{info.description}</p>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm">Ops Runner</CardTitle>
            <Button size="sm" variant="outline" onClick={rotateToken} disabled={rotatingToken} className="gap-1.5">
              {rotatingToken ? <Loader2 className="h-3 w-3 animate-spin" /> : <KeyRound className="h-3 w-3" />}
              Rotate token
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label>Runner public URL</Label>
            <Input
              value={runnerUrl}
              onChange={(e) => setRunnerUrl(e.target.value)}
              placeholder="https://ops-runner.your-domain.com"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Leave empty if your runner polls Supabase directly. Set this to enable webhook notifications.
            </p>
          </div>

          {settings?.runner_token_hash ? (
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
              <div className="flex items-center gap-2 text-sm">
                <Server className="h-4 w-4 text-emerald-500" />
                Runner token is configured.
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">Stored as a hash. The full token was only displayed once.</p>
            </div>
          ) : (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
              <div className="flex items-center gap-2 text-sm">
                <ShieldAlert className="h-4 w-4 text-amber-500" />
                No runner token yet.
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">Click "Rotate token" to issue one — runners must present it.</p>
            </div>
          )}

          {newToken && (
            <div className="rounded-md border border-blue-500/40 bg-blue-500/10 p-3">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                <KeyRound className="h-4 w-4 text-blue-500" />
                New token — copy now, it will not be shown again
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded bg-background/60 px-2 py-1 font-mono text-[11px]">{newToken}</code>
                <Button size="sm" variant="ghost" onClick={() => { navigator.clipboard.writeText(newToken); }}>
                  <Copy className="h-3 w-3" />
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Command guards</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <PatternList
            title="Denylist"
            description="Commands matching any of these patterns are blocked before execution. Regex."
            items={denylist}
            onChange={setDenylist}
            tone="bad"
          />
          <PatternList
            title="Allowlist (optional)"
            description="When non-empty, ONLY commands matching one of these patterns are allowed. Use with caution."
            items={allowlist}
            onChange={setAllowlist}
            tone="good"
          />
        </CardContent>
      </Card>
    </div>
  );
}

function PatternList({
  title,
  description,
  items,
  onChange,
  tone,
}: {
  title: string;
  description: string;
  items: string[];
  onChange: (v: string[]) => void;
  tone: "good" | "bad";
}) {
  const [newItem, setNewItem] = useState("");
  function add() {
    const v = newItem.trim();
    if (!v || items.includes(v)) return;
    onChange([...items, v]);
    setNewItem("");
  }
  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <Label>{title}</Label>
        <Badge variant="outline" className={`text-[10px] ${tone === "bad" ? "text-destructive" : "text-emerald-500"}`}>
          {items.length}
        </Badge>
      </div>
      <p className="mb-2 text-[11px] text-muted-foreground">{description}</p>
      <div className="space-y-1">
        {items.map((p, i) => (
          <div key={i} className="flex items-center gap-2 rounded border border-border bg-muted/20 px-2 py-1">
            <code className="flex-1 truncate font-mono text-[11px]">{p}</code>
            <Button size="sm" variant="ghost" onClick={() => onChange(items.filter((_, j) => j !== i))}>
              <Trash2 className="h-3 w-3 text-destructive" />
            </Button>
          </div>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <Input value={newItem} onChange={(e) => setNewItem(e.target.value)} placeholder="regex pattern…" />
        <Button size="sm" variant="outline" onClick={add} className="gap-1"><Plus className="h-3 w-3" /> Add</Button>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <label className="text-xs font-medium text-muted-foreground">{children}</label>;
}
