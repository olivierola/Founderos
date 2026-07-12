import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// Mini document-card visual with a coloured format banner + a per-type preview
// placeholder. Adapted to the repo's Tailwind v3 (h-0.75 → h-[3px], z-1/z-2 →
// z-[1]/z-[2], h-18 → h-[72px]).
export type FormatFileProps =
  | "doc" | "pdf" | "md" | "mdx" | "csv" | "xls" | "xlsx" | "txt"
  | "ppt" | "pptx" | "zip" | "rar" | "tar" | "gz" | "code" | "html"
  | "js" | "jsx" | "tsx" | "css" | "json" | "img" | "png" | "jpg"
  | "jpeg" | "video";

const colorBannerMap: Record<FormatFileProps, string> = {
  doc: "bg-blue-500 text-white",
  pdf: "bg-red-500 text-white",
  md: "bg-neutral-600 text-white",
  mdx: "bg-neutral-600 text-white",
  txt: "bg-gray-500 text-white",
  csv: "bg-teal-700 text-white",
  xls: "bg-emerald-600 text-white",
  xlsx: "bg-emerald-600 text-white",
  ppt: "bg-orange-500 text-white",
  pptx: "bg-orange-500 text-white",
  zip: "bg-purple-500 text-white",
  rar: "bg-purple-600 text-white",
  tar: "bg-yellow-600 text-white",
  gz: "bg-yellow-700 text-white",
  html: "bg-orange-600 text-white",
  js: "bg-yellow-600 text-white",
  jsx: "bg-blue-600 text-white",
  css: "bg-blue-600 text-white",
  json: "bg-yellow-500 text-white",
  tsx: "bg-blue-600 text-white",
  code: "bg-orange-600 text-white",
  img: "bg-pink-500 text-white",
  png: "bg-neutral-600 text-white",
  jpg: "bg-green-700 text-white",
  jpeg: "bg-green-700 text-white",
  video: "bg-green-700 text-white",
};

/** Map a rag_source (type + filename) to a FileCard format. */
const EXT_FORMAT: Record<string, FormatFileProps> = {
  pdf: "pdf", doc: "doc", docx: "doc", rtf: "doc", odt: "doc",
  md: "md", markdown: "md", mdx: "mdx",
  txt: "txt", log: "txt",
  csv: "csv", tsv: "csv",
  xls: "xls", xlsx: "xlsx", ods: "xls",
  ppt: "ppt", pptx: "pptx", key: "ppt",
  zip: "zip", rar: "rar", tar: "tar", gz: "gz", "7z": "zip",
  html: "html", htm: "html", js: "js", mjs: "js", jsx: "jsx", ts: "code", tsx: "tsx",
  css: "css", scss: "css", json: "json", yaml: "code", yml: "code", xml: "code", py: "code", go: "code", rs: "code", sh: "code",
  png: "png", jpg: "jpg", jpeg: "jpeg", gif: "img", webp: "img", svg: "img", bmp: "img", heic: "img",
  mp4: "video", mov: "video", webm: "video", avi: "video", mkv: "video",
};
export function formatOfSource(source: { type: string; title: string; source_ref?: string | null }): FormatFileProps {
  if (source.type === "url") return "html";
  if (source.type === "saas_structure") return "json";
  const name = (source.source_ref || source.title || "").toLowerCase();
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  return EXT_FORMAT[ext] ?? (source.type === "text" ? "txt" : "doc");
}

const DefaultPlaceholder = () => (
  <div className="space-y-1.5">
    <div className="flex gap-2"><div className="h-[3px] w-1/2 rounded-full bg-foreground/20" /></div>
    <div className="flex gap-1"><div className="h-[3px] w-1/3 rounded-full bg-foreground/10" /><div className="h-[3px] w-1/3 rounded-full bg-foreground/10" /></div>
    <div className="flex gap-1"><div className="h-[3px] w-1/2 rounded-full bg-foreground/10" /><div className="h-[3px] w-1/3 rounded-full bg-foreground/10" /></div>
    <div className="flex gap-1"><div className="h-[3px] w-1/3 rounded-full bg-foreground/10" /><div className="h-[3px] w-1/3 rounded-full bg-foreground/10" /></div>
    <div className="flex gap-1"><div className="h-[3px] w-1/3 rounded-full bg-foreground/10" /><div className="h-[3px] w-1/2 rounded-full bg-foreground/10" /></div>
    <div className="flex gap-1"><div className="h-[3px] w-1/3 rounded-full bg-foreground/10" /></div>
  </div>
);

export const FileCard = ({ formatFile, className }: { formatFile: FormatFileProps; className?: string }) => {
  const colorBannerClass = colorBannerMap[formatFile];
  let filePlaceholder: ReactNode = <DefaultPlaceholder />;

  if (formatFile === "md" || formatFile === "mdx") {
    filePlaceholder = (
      <div className="space-y-1.5">
        <div className="flex items-center gap-1"><div className="text-[10px] font-bold text-foreground/30">#</div><div className="h-[3px] w-6 rounded-full bg-foreground/20" /></div>
        <div className="space-y-1"><div className="h-[3px] w-1/3 rounded-full bg-foreground/10" /><div className="h-[3px] w-7 rounded-full bg-foreground/10" /></div>
        <div className="space-y-1"><div className="h-[3px] w-8 rounded-full bg-foreground/10" /><div className="h-[3px] w-4 rounded-full bg-foreground/10" /><div className="h-[3px] w-1/3 rounded-full bg-foreground/10" /></div>
      </div>
    );
  } else if (formatFile === "xls" || formatFile === "xlsx") {
    filePlaceholder = (
      <div className="space-y-0.5">
        <div className="grid grid-cols-3 gap-0.5"><div className="h-2 bg-foreground/20" /><div className="h-2 bg-foreground/20" /><div className="h-2 bg-foreground/20" /></div>
        <div className="grid grid-cols-3 gap-0.5"><div className="h-2 bg-foreground/5" /><div className="h-2 bg-foreground/5" /><div className="h-2 bg-foreground/5" /><div className="h-2 bg-foreground/5" /><div className="h-2 bg-foreground/5" /><div className="h-2 bg-foreground/5" /></div>
        <div className="grid grid-cols-3 gap-0.5"><div className="h-2 bg-foreground/5" /><div className="h-2 bg-foreground/5" /></div>
        <div className="grid grid-cols-3 gap-0.5"><div className="h-2 bg-foreground/5" /></div>
      </div>
    );
  } else if (formatFile === "csv") {
    filePlaceholder = (
      <>
        <div className="mb-2"><div className="grid grid-cols-3 gap-0.5"><div className="h-1.5 rounded-full bg-foreground/20" /><div className="h-1.5 rounded-full bg-foreground/20" /><div className="h-1.5 rounded-full bg-foreground/20" /></div></div>
        <div className="space-y-1.5">
          <div className="grid grid-cols-3 gap-0.5"><div className="h-1 rounded-full bg-foreground/5" /><div className="h-1 rounded-full bg-foreground/5" /><div className="h-1 rounded-full bg-foreground/5" /></div>
          <div className="grid grid-cols-3 gap-0.5"><div className="h-1 rounded-full bg-foreground/5" /><div className="h-1 rounded-full bg-foreground/5" /><div className="h-1 rounded-full bg-foreground/5" /></div>
          <div className="grid grid-cols-3 gap-0.5"><div className="h-1 rounded-full bg-foreground/5" /><div className="h-1 rounded-full bg-foreground/5" /></div>
          <div className="grid grid-cols-3 gap-0.5"><div className="h-1 rounded-full bg-foreground/5" /></div>
        </div>
      </>
    );
  } else if (formatFile === "zip" || formatFile === "rar" || formatFile === "tar" || formatFile === "gz") {
    filePlaceholder = (
      <div className="relative flex h-full flex-col items-center justify-center">
        <div className="space-y-0">
          {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((r) => (
            <div key={r} className="flex overflow-hidden rounded-full">
              <div className={cn("size-1.5", r % 2 === 0 ? "bg-foreground/20" : "bg-foreground/5")} />
              <div className={cn("size-1.5", r % 2 === 0 ? "bg-foreground/5" : "bg-foreground/20")} />
            </div>
          ))}
        </div>
      </div>
    );
  } else if (formatFile === "ppt" || formatFile === "pptx") {
    filePlaceholder = (
      <>
        <div className="mb-1.5 space-y-1 rounded border bg-foreground/5 p-1">
          <div className="flex justify-center gap-1"><div className="size-3 rounded-sm bg-orange-400/40" /></div>
          <div className="mx-auto h-[3px] w-8 rounded-full bg-foreground/15" />
        </div>
        <div className="mb-1 flex justify-center gap-1"><div className="h-[3px] w-8 rounded-full bg-foreground/15" /><div className="h-[3px] w-4 rounded-full bg-foreground/15" /></div>
        <div className="space-y-1"><div className="h-[3px] w-4 rounded-full bg-foreground/15" /><div className="h-[3px] w-5 rounded-full bg-foreground/15" /></div>
      </>
    );
  } else if (formatFile === "img" || formatFile === "png" || formatFile === "jpg" || formatFile === "jpeg") {
    filePlaceholder = (
      <div className="mb-1.5 space-y-1 rounded border bg-foreground/5 p-1">
        <div className="flex justify-center gap-1"><div className="size-3 rounded-sm bg-yellow-400/40" /></div>
        <div className="mx-auto mt-1 h-[3px] w-4 rounded-full bg-foreground/15" />
        <div className="mx-auto h-[3px] w-8 rounded-full bg-foreground/15" />
      </div>
    );
  } else if (formatFile === "video") {
    filePlaceholder = (
      <div className="mb-1.5 space-y-1 rounded border bg-foreground/5 p-1">
        <div className="flex justify-center gap-1"><div className="size-0 border-y-[5px] border-l-8 border-y-transparent border-l-green-400/60" /></div>
        <div className="mx-auto mt-1 h-[3px] w-4 rounded-full bg-foreground/15" />
        <div className="mx-auto h-[3px] w-8 rounded-full bg-foreground/15" />
      </div>
    );
  } else if (formatFile === "html" || formatFile === "js" || formatFile === "jsx" || formatFile === "tsx" || formatFile === "code") {
    filePlaceholder = (
      <div className="space-y-1">
        <div className="flex items-center gap-0.5"><div className="font-mono text-[5px] text-foreground/30">&lt;</div><div className="h-[3px] w-3 rounded-full bg-emerald-400/60" /><div className="font-mono text-[5px] text-foreground/30">&gt;</div></div>
        <div className="flex items-center gap-0.5 pl-1"><div className="font-mono text-[5px] text-foreground/30">&lt;</div><div className="h-[3px] w-2.5 rounded-full bg-sky-400/60" /><div className="font-mono text-[5px] text-foreground/30">&gt;</div></div>
        <div className="flex items-center gap-0.5 pl-1"><div className="font-mono text-[5px] text-foreground/30">&lt;/</div><div className="h-[3px] w-2.5 rounded-full bg-sky-400/60" /><div className="font-mono text-[5px] text-foreground/30">&gt;</div></div>
        <div className="flex items-center gap-0.5"><div className="font-mono text-[5px] text-foreground/30">&lt;</div><div className="h-[3px] w-1 rounded-full bg-emerald-400/60" /><div className="font-mono text-[5px] text-foreground/30">/&gt;</div></div>
      </div>
    );
  } else if (formatFile === "css") {
    filePlaceholder = (
      <div className="space-y-1">
        <div className="flex items-center gap-1"><div className="font-mono text-[6px] text-foreground/40">{"{"}</div></div>
        <div className="flex items-center gap-1 pl-1.5"><div className="h-[3px] w-3 rounded-full bg-sky-400/60" /><div className="h-[3px] w-4 rounded-full bg-sky-400/60" /></div>
        <div className="flex items-center gap-1 pl-1.5"><div className="h-[3px] w-4 rounded-full bg-sky-400/60" /><div className="h-[3px] w-2 rounded-full bg-sky-400/60" /></div>
        <div className="flex items-center gap-1 pl-1.5"><div className="h-[3px] w-3 rounded-full bg-sky-400/60" /><div className="h-[3px] w-4 rounded-full bg-sky-400/60" /></div>
        <div className="flex items-center gap-1"><div className="font-mono text-[6px] text-foreground/40">{"}"}</div></div>
      </div>
    );
  } else if (formatFile === "json") {
    filePlaceholder = (
      <div className="space-y-1">
        <div className="flex items-center gap-1"><div className="font-mono text-[6px] text-foreground/40">{"{"}</div></div>
        <div className="flex items-center gap-1 pl-1.5"><div className="h-[3px] w-3 rounded-full bg-foreground/20" /><div className="h-[3px] w-4 rounded-full bg-foreground/20" /></div>
        <div className="flex items-center gap-1 pl-1.5"><div className="h-[3px] w-4 rounded-full bg-foreground/10" /><div className="h-[3px] w-2 rounded-full bg-foreground/10" /></div>
        <div className="flex items-center gap-1 pl-1.5"><div className="h-[3px] w-3 rounded-full bg-foreground/10" /><div className="h-[3px] w-4 rounded-full bg-foreground/10" /></div>
        <div className="flex items-center gap-1 pl-1.5"><div className="h-[3px] w-3 rounded-full bg-foreground/10" /></div>
        <div className="flex items-center gap-1"><div className="font-mono text-[6px] text-foreground/40">{"}"}</div></div>
      </div>
    );
  }

  return (
    <div aria-hidden className={cn("relative size-fit", className)}>
      <div className={cn("absolute -right-2 bottom-1.5 z-[2] rounded px-1.5 py-0.5 text-[8px] font-medium uppercase", colorBannerClass)}>
        {formatFile}
      </div>
      <div className="relative z-[1] h-[72px] w-14 space-y-3 overflow-hidden rounded-md bg-white p-2 ring-1 ring-border dark:bg-secondary">
        {filePlaceholder}
      </div>
    </div>
  );
};

export default FileCard;
