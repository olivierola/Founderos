/**
 * Editor.js tools that ship without types.
 *
 * Only `@editorjs/checklist` lacks a declaration file today; the others resolve
 * on their own. Declared as `any` on purpose — Editor.js takes tool CLASSES, and
 * inventing a fake constructor signature here would be a worse lie than an
 * untyped import that the editor validates at runtime anyway.
 */
declare module "@editorjs/checklist" {
  // deno-lint-ignore no-explicit-any
  const Checklist: any;
  export default Checklist;
}
