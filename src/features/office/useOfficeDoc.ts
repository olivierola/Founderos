import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/auth-context";
import { type OfficeDoc, type OfficeKind, extractPreview } from "./shared";

// Loads a single office doc and provides a debounced autosave for title/content.
export function useOfficeDoc(docId: string | undefined, expectedKind: OfficeKind) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const query = useQuery({
    queryKey: ["office_doc", docId],
    enabled: !!docId,
    queryFn: async () => {
      const { data } = await supabase.from("office_documents").select("*").eq("id", docId!).maybeSingle();
      return (data as OfficeDoc | null) ?? null;
    },
  });

  const doSave = useCallback(
    async (patch: { title?: string; content?: OfficeDoc["content"]; emoji?: string }) => {
      if (!docId) return;
      setSaving(true);
      try {
        const update: Record<string, unknown> = {
          ...patch,
          updated_by: user?.id ?? null,
          updated_at: new Date().toISOString(),
        };
        if (patch.content) {
          update.preview_text = extractPreview(expectedKind, patch.content);
        }
        await supabase.from("office_documents").update(update).eq("id", docId);
        setSavedAt(Date.now());
        // Refresh the library list lazily (preview/title/updated_at changed).
        queryClient.invalidateQueries({ queryKey: ["office_docs"] });
      } finally {
        setSaving(false);
      }
    },
    [docId, expectedKind, user?.id, queryClient],
  );

  // Debounced save — call on every edit; persists ~800ms after the last change.
  const scheduleSave = useCallback(
    (patch: { title?: string; content?: OfficeDoc["content"]; emoji?: string }) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => doSave(patch), 800);
    },
    [doSave],
  );

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return { ...query, saving, savedAt, scheduleSave, saveNow: doSave };
}
