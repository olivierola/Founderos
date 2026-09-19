import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { router } from "@/app/router";
import { AuthProvider } from "@/lib/auth-context";
import { ThemeProvider } from "@/lib/theme-context";
import { ToastProvider } from "@/components/ToastProvider";
import { applySkinNow } from "@/lib/useSkin";
import { captureAttribution } from "@/lib/attribution";
import "@/styles/globals.css";

// Avant le premier rendu, pas dans un effet : entre le rendu initial et
// l'application de la peau, l'écran afficherait l'autre système pendant une
// image — ce qui se voit comme un défaut de chargement.
applySkinNow();
// Where this visitor came from (widget « Powered by », campaigns) — read once,
// before the router rewrites the URL.
captureAttribution();

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, refetchOnWindowFocus: false } },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <ToastProvider>
          <AuthProvider>
            <RouterProvider router={router} />
          </AuthProvider>
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </React.StrictMode>,
);
