import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Slack, Plus, Trash2, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import type { InternalAgent } from "./shared";

interface ChannelRow {
  id: string;
  provider: string;
  team_name: string | null;
  external_team_id: string | null;
  trigger: "mention" | "all";
  enabled: boolean;
  created_at: string;
}

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;

// Connect an agent to external chat channels (Slack). "Add to Slack" links to the
// slack-gateway edge function, which builds the OAuth consent URL server-side
// (keeping the client id/secret off the client) and stores the bot token after
// consent. The UI only ever reads channel metadata — never the token.
export function AgentChannelsTab({ agent }: { agent: InternalAgent }) {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const slackStatus = params.get("slack"); // 'connected' | 'error' | null

  const { data: channels, isLoading } = useQuery({
    queryKey: ["agent_channels", agent.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("internal_agent_channels")
        .select("id, provider, team_name, external_team_id, trigger, enabled, created_at")
        .eq("agent_id", agent.id)
        .order("created_at", { ascending: false });
      return (data ?? []) as ChannelRow[];
    },
  });

  const installUrl = useMemo(() => {
    const u = new URL(`${SUPABASE_URL}/functions/v1/slack-gateway`);
    u.searchParams.set("install", "1");
    u.searchParams.set("agent_id", agent.id);
    u.searchParams.set("return_to", window.location.pathname);
    return u.toString();
  }, [agent.id]);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["agent_channels", agent.id] });
  const setTrigger = async (id: string, trigger: "mention" | "all") => {
    await supabase.from("internal_agent_channels").update({ trigger }).eq("id", id);
    invalidate();
  };
  const setEnabled = async (id: string, enabled: boolean) => {
    await supabase.from("internal_agent_channels").update({ enabled }).eq("id", id);
    invalidate();
  };
  const disconnect = async (id: string) => {
    if (!confirm("Disconnect this workspace? The agent stops responding there.")) return;
    await supabase.from("internal_agent_channels").delete().eq("id", id);
    invalidate();
  };
  const clearStatus = () => {
    const n = new URLSearchParams(params);
    n.delete("slack");
    setParams(n, { replace: true });
  };

  return (
    <div className="space-y-6 py-6">
      <div>
        <h3 className="text-lg font-semibold">Channels</h3>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Connect <span className="font-medium text-foreground">{agent.name}</span> to a Slack workspace so your team can
          @mention it in a channel and get answers right in the thread — with full context across replies.
        </p>
      </div>

      {slackStatus === "connected" && (
        <div className="flex items-center justify-between rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-600 dark:text-emerald-400">
          <span className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4" /> Slack connected. Invite the bot to a channel, then @mention the agent.</span>
          <button onClick={clearStatus} className="opacity-70 hover:opacity-100">Dismiss</button>
        </div>
      )}
      {slackStatus === "error" && (
        <div className="flex items-center justify-between rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-600 dark:text-rose-400">
          <span>Slack connection failed. Please try again.</span>
          <button onClick={clearStatus} className="opacity-70 hover:opacity-100">Dismiss</button>
        </div>
      )}

      {/* Connect card */}
      <div className="rounded-xl border border-border p-5">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-lg bg-[#4A154B] text-white"><Slack className="h-5 w-5" /></span>
          <div className="flex-1">
            <div className="font-medium">Slack</div>
            <div className="text-xs text-muted-foreground">Mention &amp; reply in channels and DMs.</div>
          </div>
          <a href={installUrl}>
            <Button><Plus className="mr-1.5 h-4 w-4" /> Add to Slack</Button>
          </a>
        </div>
      </div>

      {/* Connected workspaces */}
      {isLoading ? (
        <div className="h-20 animate-pulse rounded-lg bg-muted/40" />
      ) : !channels || channels.length === 0 ? (
        <EmptyState icon={Slack} title="No workspaces connected" description="Click “Add to Slack” to connect a workspace." />
      ) : (
        <div className="space-y-2">
          {channels.map((c) => (
            <div key={c.id} className={cn("flex items-center gap-3 rounded-lg border border-border p-3", !c.enabled && "opacity-60")}>
              <span className="grid h-9 w-9 place-items-center rounded-md bg-[#4A154B] text-white"><Slack className="h-4 w-4" /></span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{c.team_name ?? c.external_team_id ?? "Slack workspace"}</div>
                <div className="text-[11px] text-muted-foreground">Responds on: {c.trigger === "all" ? "every message" : "@mention"}</div>
              </div>
              <select
                value={c.trigger}
                onChange={(e) => setTrigger(c.id, e.target.value as "mention" | "all")}
                className="rounded-md border border-input bg-background px-2 py-1 text-xs"
              >
                <option value="mention">On @mention</option>
                <option value="all">Every message</option>
              </select>
              <Button size="sm" variant="ghost" onClick={() => setEnabled(c.id, !c.enabled)}>{c.enabled ? "Disable" : "Enable"}</Button>
              <Button size="sm" variant="ghost" onClick={() => disconnect(c.id)} title="Disconnect"><Trash2 className="h-4 w-4 text-destructive" /></Button>
            </div>
          ))}
        </div>
      )}

      {/* How it works */}
      <div className="rounded-xl border border-border bg-muted/20 p-5 text-sm">
        <div className="font-medium">How it works</div>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
          <li>Click <span className="font-medium text-foreground">Add to Slack</span> and authorize the app for your workspace.</li>
          <li>Add the bot to a channel: open the channel → its name → <span className="font-medium text-foreground">Integrations → Add apps</span> (or <span className="font-mono text-foreground">/invite @</span> then pick the bot from the list).</li>
          <li>Mention your Slack bot in the channel — it replies in-thread as <span className="font-medium text-foreground">{agent.name}</span>, remembering the conversation. <span className="italic">The Slack bot's name is set in your app's App Home, not the agent name.</span></li>
          <li>Assign a <span className="font-medium text-foreground">mission</span> right from Slack: <span className="font-mono text-foreground">@bot mission: build a dashboard to test the model</span>. It creates a tracked mission (visible in the <span className="font-medium text-foreground">Missions</span> tab), runs it in the background, and posts the report back in the thread.</li>
        </ol>
      </div>
    </div>
  );
}
