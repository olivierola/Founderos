/**
 * Ambient declarations for the Editor.js tools that ship without usable typings.
 *
 * Some of these packages have no `.d.ts` at all; others (`@editorjs/embed`) do
 * ship one but hide it behind an `exports` map TypeScript cannot resolve. Either
 * way the value we need is the tool constructor, which Editor.js only ever
 * receives as an opaque class — so there is nothing more precise to state here.
 */
declare module "@editorjs/checklist" {
  const Checklist: unknown;
  export default Checklist;
}
declare module "@editorjs/embed" {
  const Embed: unknown;
  export default Embed;
}
declare module "@editorjs/raw" {
  const RawTool: unknown;
  export default RawTool;
}
declare module "@editorjs/marker" {
  const Marker: unknown;
  export default Marker;
}
declare module "@editorjs/underline" {
  const Underline: unknown;
  export default Underline;
}
declare module "@editorjs/inline-code" {
  const InlineCode: unknown;
  export default InlineCode;
}
declare module "@editorjs/warning" {
  const Warning: unknown;
  export default Warning;
}
declare module "@editorjs/attaches" {
  const AttachesTool: unknown;
  export default AttachesTool;
}
declare module "editorjs-text-alignment-blocktune" {
  const AlignmentTune: unknown;
  export default AlignmentTune;
}
