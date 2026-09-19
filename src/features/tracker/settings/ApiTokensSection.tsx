import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, CopySimpleIcon, KeyIcon, TrashIcon, WarningIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";
import { formatDate } from "../pickers";
import { createApiToken, deleteApiToken, fetchApiTokens } from "../model";
import { TextField } from "../ui";

/**
 * Les jetons d'API personnels.
 *
 * Le secret n'est montré QU'UNE FOIS, à la création, et la base n'en garde
 * qu'un hachage SHA-256. C'est la seule façon d'obtenir la propriété qui compte
 * : une copie de la base — un dump, une sauvegarde qui traîne, un accès en
 * lecture accordé un peu vite — ne livre aucune clé utilisable.
 *
 * Le préfixe (huit caractères) est stocké en clair, lui, pour qu'on puisse
 * reconnaître un jeton dans un journal et savoir lequel révoquer sans avoir à
 * tous les révoquer.
 */
export function ApiTokensSection({ workspaceId }: { workspaceId: string }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [label, setLabel] = useState("");
  const [issued, setIssued] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const { data: tokens } = useQuery({
    queryKey: ["pj_api_tokens", user?.id],
    enabled: !!user,
    queryFn: () => fetchApiTokens(),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["pj_api_tokens"] });

  const create = async () => {
    if (!label.trim() || !user || busy) return;
    setBusy(true);
    try {
      const secret = await createApiToken({
        workspaceId, userId: user.id, label: label.trim(),
      });
      setIssued(secret);
      setLabel("");
      setCopied(false);
      refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-2">
      <h3 className="text-14 font-medium">Jetons d&apos;API</h3>
      <p className="text-11 text-muted-foreground">
        La base n&apos;en garde qu&apos;une empreinte : un jeton perdu ne se retrouve pas,
        il se remplace.
      </p>

      {issued && (
        <div className="space-y-2 rounded-lg border border-amber-500/50 bg-amber-500/5 p-3">
          <p className="flex items-center gap-1.5 text-12 font-medium text-amber-700 dark:text-amber-500">
            <WarningIcon className="h-4 w-4" />
            Copiez-le maintenant — il ne sera plus jamais affiché.
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1.5 font-mono text-12">
              {issued}
            </code>
            <Button
              size="sm" variant="outline" className="h-8 gap-1 text-12"
              onClick={async () => {
                await navigator.clipboard?.writeText(issued);
                setCopied(true);
              }}
            >
              {copied ? <CheckIcon className="h-3.5 w-3.5" /> : <CopySimpleIcon className="h-3.5 w-3.5" />}
              {copied ? "Copié" : "Copier"}
            </Button>
            <Button size="sm" variant="ghost" className="h-8 text-12" onClick={() => setIssued(null)}>
              J&apos;ai copié
            </Button>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-border/70">
        {(tokens ?? []).map((t) => (
          <div key={t.id} className="flex items-center gap-2 border-b border-border/40 px-3 py-2 last:border-0">
            <KeyIcon className="h-4 w-4 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-13">{t.label}</span>
              <span className="block font-mono text-10 text-muted-foreground">
                {t.token_prefix}…
              </span>
            </span>
            <span className="shrink-0 text-11 text-muted-foreground">
              {t.last_used_at ? `Utilisé le ${formatDate(t.last_used_at)}` : "Jamais utilisé"}
            </span>
            <button
              type="button"
              onClick={async () => { await deleteApiToken(t.id); refresh(); }}
              title="Révoquer"
              className="rounded p-1 text-muted-foreground hover:text-red-600"
            >
              <TrashIcon className="h-4 w-4" />
            </button>
          </div>
        ))}

        <div className="flex items-center gap-2 px-3 py-2">
          <TextField
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") create(); }}
            placeholder="À quoi sert ce jeton ? (ex. « import Zapier »)"
            className="h-8 flex-1 text-14"
          />
          <Button size="sm" onClick={create} disabled={!label.trim() || busy}>
            Générer
          </Button>
        </div>
      </div>
    </section>
  );
}
