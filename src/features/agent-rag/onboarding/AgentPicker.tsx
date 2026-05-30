import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, ChevronDown } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import { supabase } from "@/lib/supabase";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";

interface Agent {
  id: string;
  name: string;
  onboarding_enabled: boolean;
}

interface Props {
  projectId: string;
  selectedAgentId: string | null;
  onSelect: (id: string) => void;
  /** Render this when no agent is selected yet. */
  emptyHint?: string;
}

export function AgentPicker({ projectId, selectedAgentId, onSelect, emptyHint }: Props) {
  const [searchParams, setSearchParams] = useSearchParams();

  const { data: agents, isLoading } = useQuery({
    queryKey: ["onb_agents", projectId],
    enabled: !!projectId,
    queryFn: async () => {
      const { data } = await supabase
        .from("rag_agents")
        .select("id, name, onboarding_enabled")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false });
      return (data ?? []) as Agent[];
    },
  });

  // Sync ?a= URL param ↔ selected agent.
  const urlAgentId = searchParams.get("a");
  useEffect(() => {
    if (urlAgentId && urlAgentId !== selectedAgentId) onSelect(urlAgentId);
  }, [urlAgentId, selectedAgentId, onSelect]);
  useEffect(() => {
    if (agents && agents.length > 0 && !selectedAgentId) {
      onSelect(agents[0].id);
      const next = new URLSearchParams(searchParams);
      next.set("a", agents[0].id);
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents]);

  function pick(id: string) {
    onSelect(id);
    const next = new URLSearchParams(searchParams);
    next.set("a", id);
    setSearchParams(next, { replace: true });
  }

  if (isLoading) return null;
  if (!agents || agents.length === 0) {
    return (
      <EmptyState
        icon={Bot}
        title="No RAG agent yet"
        description={emptyHint ?? "Create an agent first in the Agents tab to set up onboarding."}
      />
    );
  }

  const current = agents.find((a) => a.id === selectedAgentId) ?? agents[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Bot className="h-4 w-4" />
          <span className="font-medium">{current.name}</span>
          {!current.onboarding_enabled && (
            <Badge variant="outline" className="text-[10px] text-amber-400">
              onboarding off
            </Badge>
          )}
          <ChevronDown className="h-3.5 w-3.5 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {agents.map((a) => (
          <DropdownMenuItem key={a.id} onSelect={() => pick(a.id)} className="flex items-center justify-between">
            <span className="truncate">{a.name}</span>
            {a.onboarding_enabled ? (
              <Badge variant="success" className="text-[10px]">on</Badge>
            ) : (
              <Badge variant="outline" className="text-[10px] text-muted-foreground">off</Badge>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
