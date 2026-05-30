import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CheckCircle2, AlertCircle, Info, X, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export type ToastKind = "success" | "error" | "info" | "loading";

export interface Toast {
  id: string;
  kind: ToastKind;
  title: string;
  description?: string;
  /** Duration in ms before auto-dismiss. 0 = sticky (default for loading). */
  duration?: number;
}

interface ToastContextValue {
  show: (input: Omit<Toast, "id"> & { id?: string }) => string;
  dismiss: (id: string) => void;
  success: (title: string, description?: string) => string;
  error: (title: string, description?: string) => string;
  info: (title: string, description?: string) => string;
  loading: (title: string, description?: string) => string;
  /** Resolve a `loading` toast into a `success` or `error` keeping the same slot. */
  resolve: (
    id: string,
    next: { kind: Exclude<ToastKind, "loading">; title: string; description?: string; duration?: number },
  ) => void;
  /** Run an async op while showing a loading toast that turns into success or error. */
  run: <T>(
    op: () => Promise<T>,
    messages: {
      loading: string;
      success: string | ((result: T) => string);
      error?: string | ((err: unknown) => string);
      description?: string;
    },
  ) => Promise<T>;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Record<string, number>>({});

  const dismiss = useCallback((id: string) => {
    setToasts((t) => t.filter((x) => x.id !== id));
    if (timers.current[id]) {
      window.clearTimeout(timers.current[id]);
      delete timers.current[id];
    }
  }, []);

  const scheduleDismiss = useCallback(
    (id: string, duration: number) => {
      if (duration <= 0) return;
      if (timers.current[id]) window.clearTimeout(timers.current[id]);
      timers.current[id] = window.setTimeout(() => dismiss(id), duration);
    },
    [dismiss],
  );

  const show = useCallback<ToastContextValue["show"]>(
    (input) => {
      const id = input.id ?? Math.random().toString(36).slice(2);
      const duration = input.duration ?? (input.kind === "loading" ? 0 : input.kind === "error" ? 6000 : 3500);
      setToasts((t) => {
        const idx = t.findIndex((x) => x.id === id);
        const next: Toast = { id, kind: input.kind, title: input.title, description: input.description, duration };
        if (idx >= 0) return t.map((x, i) => (i === idx ? next : x));
        return [...t, next];
      });
      scheduleDismiss(id, duration);
      return id;
    },
    [scheduleDismiss],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      show,
      dismiss,
      success: (title, description) => show({ kind: "success", title, description }),
      error: (title, description) => show({ kind: "error", title, description }),
      info: (title, description) => show({ kind: "info", title, description }),
      loading: (title, description) => show({ kind: "loading", title, description }),
      resolve: (id, next) => show({ id, ...next }),
      run: async (op, messages) => {
        const id = show({ kind: "loading", title: messages.loading, description: messages.description });
        try {
          const result = await op();
          const successTitle =
            typeof messages.success === "function" ? messages.success(result) : messages.success;
          show({ id, kind: "success", title: successTitle });
          return result;
        } catch (e) {
          const errorTitle =
            typeof messages.error === "function"
              ? messages.error(e)
              : (messages.error ?? "Operation failed");
          const detail = e instanceof Error ? e.message : String(e);
          show({ id, kind: "error", title: errorTitle, description: detail });
          throw e;
        }
      },
    }),
    [show, dismiss],
  );

  useEffect(() => {
    return () => {
      Object.values(timers.current).forEach((t) => window.clearTimeout(t));
    };
  }, []);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(90vw,360px)] flex-col gap-2">
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} onClose={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({ toast, onClose }: { toast: Toast; onClose: () => void }) {
  const Icon =
    toast.kind === "success"
      ? CheckCircle2
      : toast.kind === "error"
        ? AlertCircle
        : toast.kind === "loading"
          ? Loader2
          : Info;

  const tone =
    toast.kind === "success"
      ? "border-[hsl(var(--accent-2)/0.4)] bg-[hsl(var(--accent-2)/0.1)] text-foreground"
      : toast.kind === "error"
        ? "border-destructive/40 bg-destructive/10 text-foreground"
        : "border-border bg-card text-foreground";

  const iconTone =
    toast.kind === "success"
      ? "text-[hsl(var(--accent-2))]"
      : toast.kind === "error"
        ? "text-destructive"
        : toast.kind === "loading"
          ? "text-muted-foreground"
          : "text-[hsl(var(--primary-soft))]";

  return (
    <div
      className={cn(
        "pointer-events-auto flex items-start gap-3 rounded-md border p-3 text-sm shadow-lg backdrop-blur",
        "animate-in slide-in-from-right-4 fade-in-0 duration-200",
        tone,
      )}
      role="status"
      aria-live="polite"
    >
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", iconTone, toast.kind === "loading" && "animate-spin")} />
      <div className="min-w-0 flex-1">
        <div className="font-medium leading-tight">{toast.title}</div>
        {toast.description && (
          <div className="mt-0.5 text-xs text-muted-foreground">{toast.description}</div>
        )}
      </div>
      <button
        onClick={onClose}
        className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-secondary hover:text-foreground"
        aria-label="Dismiss"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
