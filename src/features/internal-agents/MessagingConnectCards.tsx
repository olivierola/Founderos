import { useState, type ReactNode } from "react";
import {
  CheckCircleIcon, CopyIcon, DiscordLogoIcon, PlusIcon, TelegramLogoIcon, WhatsappLogoIcon,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { callEdge } from "@/lib/edge";
import { cn } from "@/lib/utils";

/**
 * Brancher un agent sur Telegram, Discord ou WhatsApp.
 *
 * Les trois passent par `messaging-gateway`. L'interface ne fait qu'envoyer les
 * identifiants du bot à la passerelle, avec la session de l'utilisateur : c'est
 * ELLE qui les vérifie auprès du fournisseur, les range dans la table que seul
 * le serveur lit, et déclare le webhook quand le fournisseur le permet. Aucun
 * jeton ne repasse jamais par le navigateur après la connexion.
 *
 * Ce qui reste à faire de l'autre côté dépend du fournisseur, et chaque carte
 * le dit au moment où il faut le faire — pas dans une documentation à part :
 *   · Telegram — rien : le webhook est déclaré automatiquement ;
 *   · Discord  — coller l'URL d'interactions dans le portail développeur, puis
 *                inviter le bot sur le serveur ;
 *   · WhatsApp — coller l'URL du webhook et le jeton de vérification dans le
 *                tableau de bord Meta, et s'abonner aux messages.
 */

interface ConnectResult {
  ok: boolean;
  channel_id: string;
  bot_name?: string;
  interactions_url?: string;
  webhook_url?: string;
  verify_token?: string;
}

export const MESSAGING_BRANDS: Record<string, { label: string; color: string; icon: PhosphorIcon }> = {
  telegram: { label: "Telegram", color: "#229ED9", icon: TelegramLogoIcon },
  discord: { label: "Discord", color: "#5865F2", icon: DiscordLogoIcon },
  whatsapp: { label: "WhatsApp", color: "#25D366", icon: WhatsappLogoIcon },
};

export function MessagingBadge({ provider, size = "md" }: { provider: string; size?: "sm" | "md" }) {
  const brand = MESSAGING_BRANDS[provider];
  if (!brand) return null;
  const Icon = brand.icon;
  return (
    <span
      className={cn("grid place-items-center rounded-lg text-white", size === "sm" ? "h-9 w-9" : "h-10 w-10")}
      style={{ background: brand.color }}
    >
      <Icon weight="fill" className={size === "sm" ? "h-4 w-4" : "h-5 w-5"} />
    </span>
  );
}

export function MessagingConnectCards({ agentId, onConnected }: { agentId: string; onConnected: () => void }) {
  return (
    <>
      <ProviderCard
        provider="telegram"
        agentId={agentId}
        onConnected={onConnected}
        blurb="En privé ou en le mentionnant dans un groupe."
        fields={[{ key: "bot_token", label: "Jeton du bot (fourni par @BotFather)", secret: true }]}
        steps={[
          <>Dans Telegram, écrivez à <span className="font-mono text-foreground">@BotFather</span>, envoyez <span className="font-mono text-foreground">/newbot</span> et copiez le jeton.</>,
          <>Collez-le ici → <span className="font-medium text-foreground">Connecter</span>. Le webhook est déclaré automatiquement.</>,
          <>Écrivez au bot en privé, ou ajoutez-le à un groupe et mentionnez-le.</>,
        ]}
      />
      <ProviderCard
        provider="discord"
        agentId={agentId}
        onConnected={onConnected}
        blurb="Avec la commande /agent, sur votre serveur."
        fields={[
          { key: "application_id", label: "Application ID" },
          { key: "public_key", label: "Public Key" },
          { key: "bot_token", label: "Jeton du bot", secret: true },
        ]}
        steps={[
          <>Sur <span className="font-mono text-foreground">discord.com/developers</span>, créez une application et un bot ; copiez Application ID, Public Key et le jeton du bot.</>,
          <>Collez-les ici → <span className="font-medium text-foreground">Connecter</span>. La commande <span className="font-mono text-foreground">/agent</span> est créée.</>,
          <>Collez l'URL d'interactions qui s'affiche dans <span className="font-medium text-foreground">Interactions Endpoint URL</span>, puis invitez le bot sur votre serveur.</>,
        ]}
      />
      <ProviderCard
        provider="whatsapp"
        agentId={agentId}
        onConnected={onConnected}
        blurb="Via l'API WhatsApp Business (Meta)."
        fields={[
          { key: "phone_number_id", label: "Phone number ID" },
          { key: "access_token", label: "Jeton d'accès permanent", secret: true },
          { key: "app_secret", label: "App secret", secret: true },
        ]}
        steps={[
          <>Dans le tableau de bord Meta de votre app WhatsApp Business, copiez le <span className="font-medium text-foreground">Phone number ID</span>, un jeton permanent et l'<span className="font-medium text-foreground">App secret</span>.</>,
          <>Collez-les ici → <span className="font-medium text-foreground">Connecter</span>.</>,
          <>Dans Meta → Webhooks, collez l'URL et le jeton de vérification qui s'affichent, puis abonnez-vous à <span className="font-mono text-foreground">messages</span>.</>,
        ]}
      />
    </>
  );
}

function ProviderCard({
  provider, agentId, onConnected, blurb, fields, steps,
}: {
  provider: string;
  agentId: string;
  onConnected: () => void;
  blurb: string;
  fields: Array<{ key: string; label: string; secret?: boolean }>;
  steps: ReactNode[];
}) {
  const brand = MESSAGING_BRANDS[provider];
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ConnectResult | null>(null);

  const ready = fields.every((f) => (values[f.key] ?? "").trim());

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await callEdge<ConnectResult>("messaging-gateway?action=connect", {
        provider, agent_id: agentId, ...values,
      });
      setResult(r);
      // Les secrets quittent le formulaire dès qu'ils sont enregistrés : un
      // jeton qui reste affiché dans une page est un jeton qui finit dans une
      // capture d'écran.
      setValues({});
      onConnected();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border border-border p-5">
      <div className="flex items-center gap-3">
        <MessagingBadge provider={provider} />
        <div className="flex-1">
          <div className="font-medium">{brand.label}</div>
          <div className="text-xs text-muted-foreground">{blurb}</div>
        </div>
      </div>

      <ol className="mt-3 list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
        {steps.map((s, i) => <li key={i}>{s}</li>)}
      </ol>

      <div className={cn("mt-4 grid gap-2", fields.length > 1 ? "sm:grid-cols-2" : "")}>
        {fields.map((f) => (
          <div key={f.key}>
            <label className="mb-1 block text-[11px] font-medium text-muted-foreground">{f.label}</label>
            <Input
              type={f.secret ? "password" : "text"}
              autoComplete="off"
              value={values[f.key] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              className="h-9 font-mono text-[12px]"
            />
          </div>
        ))}
      </div>

      <div className="mt-3 flex items-center gap-3">
        <Button className="h-9" onClick={() => void connect()} disabled={!ready || busy}>
          <PlusIcon className="mr-1.5 h-4 w-4" /> {busy ? "Connexion…" : "Connecter"}
        </Button>
        {error && <span className="text-xs text-destructive">{error}</span>}
      </div>

      {result && (
        <div className="mt-4 space-y-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
          <p className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            <CheckCircleIcon weight="fill" className="h-4 w-4" />
            {brand.label} connecté{result.bot_name ? ` — ${result.bot_name}` : ""}.
          </p>
          {result.interactions_url && (
            <CopyRow label="Interactions Endpoint URL (portail Discord)" value={result.interactions_url} />
          )}
          {result.webhook_url && <CopyRow label="URL du webhook (Meta)" value={result.webhook_url} />}
          {result.verify_token && <CopyRow label="Jeton de vérification (Meta)" value={result.verify_token} />}
          {provider === "discord" && (
            <p className="text-[11px] text-muted-foreground">
              Invitez ensuite le bot sur votre serveur depuis le portail Discord (OAuth2 → URL Generator,
              scopes <span className="font-mono">bot</span> et <span className="font-mono">applications.commands</span>,
              permission « Send Messages »).
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <label className="mb-1 block text-[11px] font-medium text-muted-foreground">{label}</label>
      <div className="flex items-center gap-2">
        <Input readOnly value={value} className="h-8 font-mono text-[11px]" onFocus={(e) => e.currentTarget.select()} />
        <Button
          variant="outline" size="sm" className="h-8 shrink-0"
          onClick={async () => {
            try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* rien */ }
          }}
        >
          {copied ? <CheckCircleIcon className="h-3.5 w-3.5" /> : <CopyIcon className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );
}
