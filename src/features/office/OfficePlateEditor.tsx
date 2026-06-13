import { Plate, usePlateEditor } from "platejs/react";
import { EditorKit } from "@/components/editor-kit";
import { Editor, EditorContainer } from "@/components/ui/editor";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { toRichValue } from "./shared";

// Full Plate editor (playground-grade fixed toolbar with the "more" dropdown,
// drag handle, tables, media, AI menu, slash commands…) wired for our Office
// module. Controlled via value + onChange so the parent persists the content.
// Accepts either a Plate value or a legacy string.
export function OfficePlateEditor({
  value,
  onChange,
  placeholder,
  className,
  editorClassName,
}: {
  value: unknown;
  onChange?: (value: any[]) => void;
  placeholder?: string;
  className?: string;
  editorClassName?: string;
}) {
  const editor = usePlateEditor({
    plugins: EditorKit,
    value: toRichValue(value),
  });

  return (
    <TooltipProvider delayDuration={300}>
      <Plate editor={editor} onChange={({ value }) => onChange?.(value)}>
        <EditorContainer variant="default" className={cn("h-full", className)}>
          <Editor variant="default" placeholder={placeholder ?? "Type / for commands…"} className={editorClassName} />
        </EditorContainer>
      </Plate>
    </TooltipProvider>
  );
}
