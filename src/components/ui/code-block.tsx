"use client";

import { cn } from "@/lib/utils";
import React, { useEffect, useState } from "react";
import { codeToHtml } from "shiki";

// Reusable code-block primitives (Shiki-highlighted). Theme follows the app's
// light/dark mode. Used by the agent chat, rooms, and code artifacts.

export type CodeBlockProps = {
  children?: React.ReactNode;
  className?: string;
} & React.HTMLProps<HTMLDivElement>;

export function CodeBlock({ children, className, ...props }: CodeBlockProps) {
  return (
    <div
      className={cn(
        "not-prose flex w-full flex-col overflow-clip border",
        "border-border bg-card text-card-foreground rounded-xl",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

function useIsDark(): boolean {
  const [dark, setDark] = useState(
    () => typeof document !== "undefined" && document.documentElement.classList.contains("dark"),
  );
  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() => setDark(el.classList.contains("dark")));
    obs.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

export type CodeBlockCodeProps = {
  code: string;
  language?: string;
  /** Force a Shiki theme; defaults to github-light / github-dark by app theme. */
  theme?: string;
  className?: string;
} & React.HTMLProps<HTMLDivElement>;

export function CodeBlockCode({
  code,
  language = "tsx",
  theme,
  className,
  ...props
}: CodeBlockCodeProps) {
  const isDark = useIsDark();
  const resolvedTheme = theme ?? (isDark ? "github-dark" : "github-light");
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function highlight() {
      if (!code) { setHighlightedHtml("<pre><code></code></pre>"); return; }
      try {
        const html = await codeToHtml(code, { lang: language || "text", theme: resolvedTheme });
        if (!cancelled) setHighlightedHtml(html);
      } catch {
        // Unknown grammar → fall back to plaintext highlighting.
        try {
          const html = await codeToHtml(code, { lang: "text", theme: resolvedTheme });
          if (!cancelled) setHighlightedHtml(html);
        } catch { if (!cancelled) setHighlightedHtml(null); }
      }
    }
    highlight();
    return () => { cancelled = true; };
  }, [code, language, resolvedTheme]);

  // Shiki paints its own background; drop it so the container's bg shows through.
  const classNames = cn(
    "w-full overflow-x-auto text-[13px] [&>pre]:!bg-transparent [&>pre]:px-4 [&>pre]:py-3.5 [&>pre]:leading-relaxed",
    className,
  );

  return highlightedHtml ? (
    <div className={classNames} dangerouslySetInnerHTML={{ __html: highlightedHtml }} {...props} />
  ) : (
    <div className={classNames} {...props}>
      <pre className="px-4 py-3.5"><code>{code}</code></pre>
    </div>
  );
}

export type CodeBlockGroupProps = React.HTMLAttributes<HTMLDivElement>;

export function CodeBlockGroup({ children, className, ...props }: CodeBlockGroupProps) {
  return (
    <div className={cn("flex items-center justify-between", className)} {...props}>
      {children}
    </div>
  );
}
