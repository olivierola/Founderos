import { useQuery } from "@tanstack/react-query";
import { Loader2, ExternalLink } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "@/lib/supabase";
import { Button } from "@/components/ui/button";
import type { CrmObject, CrmRecord } from "./objectModel";
import { fetchAgentDeliverables, fetchMissionDeliverables, type Deliverable } from "./objectActions";

// Embeds the real module content for a record, reusing existing data without
// touching the source modules. Returns null when there's nothing to embed.
export function hasContent(slug: string): boolean {
  return ["discussions", "missions", "autonomous_agents", "documents"].includes(slug);
}

export function RecordContent({ object, record }: { object: CrmObject; record: CrmRecord }) {
  const navigate = useNavigate();
  const { workspaceSlug = "", projectSlug = "" } = useParams();
  const sid = record.source_id;

  if (!sid) return <Empty text="No linked source content." />;

  if (object.slug === "discussions") return <DiscussionThread channelId={sid} />;
  if (object.slug === "missions") return <DeliverableList load={() => fetchMissionDeliverables(sid)} empty="No deliverables for this mission yet." />;
  if (object.slug === "autonomous_agents") return (
    <div className="space-y-4 p-4">
      <DeliverableList load={() => fetchAgentDeliverables(sid)} empty="This agent has no deliverables yet." />
      <Button variant="outline" size="sm" onClick={() => navigate(`/app/${workspaceSlug}/${projectSlug}/agent/internal/${sid}/chat`)}>
        <ExternalLink className="mr-1 h-3.5 w-3.5" /> Open agent chat
      </Button>
    </div>
  );
  if (object.slug === "documents") return (
    <div className="p-4">
      <Button variant="outline" size="sm" onClick={() => navigate(`/app/${workspaceSlug}/${projectSlug}/office/document/${sid}`)}>
        <ExternalLink className="mr-1 h-3.5 w-3.5" /> Open document editor
      </Button>
    </div>
  );
  return <Empty text="No embedded content for this object." />;
}

// Read-only message thread for a discussion channel (reuses project_messages).
function DiscussionThread({ channelId }: { channelId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["crm_channel_messages", channelId],
    queryFn: async () => {
      const { data } = await supabase
        .from("project_messages")
        .select("id, author_kind, body, created_at")
        .eq("channel_id", channelId)
        .order("created_at", { ascending: true })
        .limit(200);
      return (data ?? []) as { id: string; author_kind: string; body: string; created_at: string }[];
    },
  });
  if (isLoading) return <Centered />;
  if (!data || data.length === 0) return <Empty text="No messages in this channel yet." />;
  return (
    <div className="space-y-2 p-4">
      {data.map((m) => (
        <div key={m.id} className="rounded-lg border border-border bg-card p-2.5">
          <div className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{m.author_kind}</div>
          <div className="whitespace-pre-wrap text-sm">{m.body}</div>
        </div>
      ))}
    </div>
  );
}

function DeliverableList({ load, empty }: { load: () => Promise<Deliverable[]>; empty: string }) {
  const { data, isLoading } = useQuery({ queryKey: ["crm_content_deliverables", empty, Math.random().toString(36).slice(2)], queryFn: load });
  if (isLoading) return <Centered />;
  if (!data || data.length === 0) return <Empty text={empty} />;
  return (
    <div className="space-y-2 p-4">
      {data.map((d) => (
        <div key={d.id} className="rounded-lg border border-border bg-card p-3">
          <div className="mb-1 flex items-center gap-2">
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">{d.kind}</span>
            <span className="text-sm font-medium">{d.name}</span>
          </div>
          {d.file_url && <a href={d.file_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline"><ExternalLink className="h-3 w-3" /> Open file</a>}
          {d.content && <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 text-xs">{d.content}</pre>}
        </div>
      ))}
    </div>
  );
}

function Centered() { return <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>; }
function Empty({ text }: { text: string }) { return <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">{text}</div>; }
