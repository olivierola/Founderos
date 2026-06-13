import * as React from "react";
import { Plate, usePlateEditor } from "platejs/react";
import { EditorKit } from "@/components/editor-kit";
import { Editor, EditorContainer } from "@/components/ui/editor";

// Full Plate editor (playground-grade toolbar, drag handle, tables, media, AI
// menu, slash commands…) wired for our Office module. Controlled via value +
// onChange so the parent persists the document.
export function OfficePlateEditor({
  value,
  onChange,
  placeholder,
}: {
  value: any[];
  onChange?: (value: any[]) => void;
  placeholder?: string;
}) {
  const editor = usePlateEditor({
    plugins: EditorKit,
    value: value && value.length ? value : [{ type: "p", children: [{ text: "" }] }],
  });

  return (
    <Plate
      editor={editor}
      onChange={({ value }) => onChange?.(value)}
    >
      <EditorContainer variant="default">
        <Editor variant="default" placeholder={placeholder ?? "Type / for commands…"} />
      </EditorContainer>
    </Plate>
  );
}
