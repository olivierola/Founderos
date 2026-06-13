import { useEffect } from "react";
import { Plate, usePlateEditor } from "platejs/react";
import { CopilotPlugin } from "@platejs/ai/react";
import { aiChatPlugin } from "@/components/ai-kit";
import { EditorKit } from "@/components/editor-kit";
import { Editor, EditorContainer } from "@/components/ui/editor";
import { TooltipProvider } from "@/components/ui/tooltip";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { toRichValue } from "./shared";

const STREAM_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/office-ai-stream`;
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

// Full Plate editor (playground-grade fixed toolbar with the "more" dropdown,
// drag handle, tables, media, AI menu, slash commands…) wired for our Office
// module. The inline AI (⌘+J menu + copilot autocomplete) is grounded in the
// project's RAG knowledge base via the office-ai-stream edge function.
export function OfficePlateEditor({
  value,
  onChange,
  placeholder,
  className,
  editorClassName,
  workspaceId,
  projectId,
  useKnowledge = true,
}: {
  value: unknown;
  onChange?: (value: any[]) => void;
  placeholder?: string;
  className?: string;
  editorClassName?: string;
  workspaceId?: string | null;
  projectId?: string | null;
  useKnowledge?: boolean;
}) {
  const editor = usePlateEditor({
    plugins: EditorKit,
    value: toRichValue(value),
  });

  // Point the AI chat + copilot plugins at our RAG-grounded streaming edge,
  // injecting auth + project context. Re-runs when the project changes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (cancelled || !token || !workspaceId || !projectId) return;

      const headers = { Authorization: `Bearer ${token}`, apikey: ANON };
      const body = { workspace_id: workspaceId, project_id: projectId, use_knowledge: useKnowledge };

      // AI menu (⌘+J / "AI commands"): streamed UI-message protocol.
      editor.setOption(aiChatPlugin as any, "chatOptions", {
        api: STREAM_URL,
        headers,
        body: { ...body, mode: "chat" },
      });

      // Inline copilot autocomplete: plain-text stream. callCompletionApi defaults
      // to the AI-SDK "data" protocol, so we must opt into "text" to read our
      // plain-text response.
      const copilotOpts = (editor.getOptions(CopilotPlugin) as any).completeOptions ?? {};
      editor.setOption(CopilotPlugin as any, "completeOptions", {
        ...copilotOpts,
        api: STREAM_URL,
        headers,
        streamProtocol: "text",
        body: { ...copilotOpts.body, ...body, mode: "copilot" },
      });
    })();
    return () => { cancelled = true; };
  }, [editor, workspaceId, projectId, useKnowledge]);

  return (
    <TooltipProvider delayDuration={300}>
      <Plate editor={editor} onChange={({ value }) => onChange?.(value)}>
        <EditorContainer variant="default" className={cn("h-full", className)}>
          <Editor
            variant="default"
            placeholder={placeholder ?? "Type / for commands…"}
            // Full-width: drop the variant's large centering side padding.
            className={cn("px-6 pt-4 pb-24 sm:px-8", editorClassName)}
          />
        </EditorContainer>
      </Plate>
    </TooltipProvider>
  );
}
