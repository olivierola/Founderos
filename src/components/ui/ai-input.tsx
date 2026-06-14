"use client";

import { CornerRightUp, Loader2 } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { Textarea } from "@/components/ui/textarea";
import { useAutoResizeTextarea } from "@/components/hooks/use-auto-resize-textarea";

interface AIInputProps {
  id?: string;
  placeholder?: string;
  minHeight?: number;
  maxHeight?: number;
  onSubmit?: (value: string) => void;
  className?: string;
  /** Controlled value (optional). When omitted the component manages its own. */
  value?: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  loading?: boolean;
}

export function AIInput({
  id = "ai-input",
  placeholder = "Type your message...",
  minHeight = 52,
  maxHeight = 200,
  onSubmit,
  className,
  value,
  onChange,
  disabled,
  loading,
}: AIInputProps) {
  const { textareaRef, adjustHeight } = useAutoResizeTextarea({ minHeight, maxHeight });
  const [internal, setInternal] = useState("");
  const controlled = value !== undefined;
  const inputValue = controlled ? value! : internal;

  const setValue = (v: string) => {
    if (controlled) onChange?.(v);
    else setInternal(v);
  };

  const submit = () => {
    if (!inputValue.trim() || disabled || loading) return;
    onSubmit?.(inputValue);
    if (!controlled) setInternal("");
    adjustHeight(true);
  };

  return (
    <div className={cn("w-full", className)}>
      <div className="relative w-full">
        <Textarea
          id={id}
          placeholder={placeholder}
          disabled={disabled}
          className={cn(
            "w-full rounded-3xl bg-black/5 pl-5 pr-14 dark:bg-white/5",
            "placeholder:text-black/50 dark:placeholder:text-white/50",
            "border-none ring-black/20 dark:ring-white/20",
            "text-foreground text-wrap",
            "resize-none overflow-y-auto scrollbar-hide",
            "focus-visible:ring-0 focus-visible:ring-offset-0",
            "transition-[height] duration-100 ease-out",
            "py-[16px] leading-[1.2]",
            "[&::-webkit-resizer]:hidden",
          )}
          style={{ minHeight, maxHeight }}
          ref={textareaRef}
          value={inputValue}
          onChange={(e) => {
            setValue(e.target.value);
            adjustHeight();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />

        <button
          onClick={submit}
          type="button"
          disabled={disabled || loading}
          className={cn(
            "absolute right-3 top-1/2 -translate-y-1/2",
            "rounded-xl bg-black/5 px-1 py-1 dark:bg-white/5",
            "transition-all duration-200",
            inputValue && !loading
              ? "scale-100 opacity-100"
              : loading
                ? "scale-100 opacity-100"
                : "pointer-events-none scale-95 opacity-0",
          )}
        >
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin text-black/70 dark:text-white/70" />
          ) : (
            <CornerRightUp className="h-4 w-4 text-black/70 dark:text-white/70" />
          )}
        </button>
      </div>
    </div>
  );
}
