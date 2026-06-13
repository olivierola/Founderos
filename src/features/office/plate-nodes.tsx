// Styled Plate node + leaf components for the office document editor.
// These give the editor a polished "document" look (à la Plate playground)
// instead of unstyled HTML. Each is a thin wrapper over PlateElement/PlateLeaf.

import { PlateElement, PlateLeaf, type PlateElementProps, type PlateLeafProps } from "platejs/react";
import { cn } from "@/lib/utils";

/* ---- block elements ---- */

export function H1Element(props: PlateElementProps) {
  return (
    <PlateElement as="h1" {...props}
      className={cn("mt-8 mb-3 text-3xl font-bold tracking-tight first:mt-0", props.className)}>
      {props.children}
    </PlateElement>
  );
}
export function H2Element(props: PlateElementProps) {
  return (
    <PlateElement as="h2" {...props}
      className={cn("mt-6 mb-2.5 text-2xl font-semibold tracking-tight", props.className)}>
      {props.children}
    </PlateElement>
  );
}
export function H3Element(props: PlateElementProps) {
  return (
    <PlateElement as="h3" {...props}
      className={cn("mt-5 mb-2 text-xl font-semibold", props.className)}>
      {props.children}
    </PlateElement>
  );
}

export function ParagraphElement(props: PlateElementProps) {
  // Plate v53 lists are paragraphs carrying `listStyleType` + `indent`. Render
  // them as list items so the marker shows and nesting indents.
  const el = props.element as any;
  const listType = el?.listStyleType as string | undefined;
  const indent = (el?.indent as number | undefined) ?? 0;
  if (listType) {
    return (
      <PlateElement
        {...props}
        as="div"
        className={cn("leading-7", props.className)}
        style={{
          ...props.style,
          display: "list-item",
          listStyleType: listType,
          marginLeft: `${indent * 1.5}rem`,
        }}
      >
        {props.children}
      </PlateElement>
    );
  }
  return (
    <PlateElement {...props} className={cn("my-1.5 leading-7", props.className)}>
      {props.children}
    </PlateElement>
  );
}

export function BlockquoteElement(props: PlateElementProps) {
  return (
    <PlateElement as="blockquote" {...props}
      className={cn("my-3 border-l-4 border-zinc-300 pl-4 italic text-zinc-600", props.className)}>
      {props.children}
    </PlateElement>
  );
}

export function LinkElement(props: PlateElementProps) {
  return (
    <PlateElement
      as="a"
      {...props}
      className={cn("font-medium text-blue-600 underline decoration-blue-600/40 underline-offset-2 hover:decoration-blue-600", props.className)}
      attributes={{ ...props.attributes, href: (props.element as any).url, target: "_blank", rel: "noreferrer" }}
    >
      {props.children}
    </PlateElement>
  );
}

/* ---- marks (leaves) ---- */

export function CodeLeaf(props: PlateLeafProps) {
  return (
    <PlateLeaf as="code" {...props}
      className={cn("rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-[0.85em] text-zinc-800", props.className)}>
      {props.children}
    </PlateLeaf>
  );
}
