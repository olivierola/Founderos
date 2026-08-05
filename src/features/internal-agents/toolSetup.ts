// Which agent tools are still waiting on a human decision.
//
// Templates deliberately ship tools with an EMPTY required config — an agent
// that "reads the CRM" has to be told which tables, one that "watches the
// repo" has to be told which repository. Shipping them pre-filled would mean
// guessing, and a wrong guess is worse than an empty field: the agent runs and
// silently works on the wrong data.
//
// The same rules drive the "Needs configuration" badge in the Tools tab and the
// reminder banner at the top of the chat, so the two can never disagree.

export interface ConfigurableTool {
  id?: string;
  kind: string;
  name: string;
  config: Record<string, any> | null | undefined;
  enabled?: boolean;
}

/** Human explanation of what's missing, or null when the tool is ready. */
export function toolSetupIssue(t: ConfigurableTool): string | null {
  const cfg = t.config ?? {};
  switch (t.kind) {
    case "db_read": {
      const tables = Array.isArray(cfg.tables) ? cfg.tables : [];
      if (tables.length === 0) return "Aucune table autorisée — l'agent ne peut rien lire. Définissez la liste blanche.";
      return null;
    }
    case "edge_function":
      return /^[a-z0-9-]+$/.test(String(cfg.slug ?? ""))
        ? null
        : "Aucune fonction choisie — l'outil est ignoré à l'exécution.";
    case "custom":
      return /^https?:\/\//.test(String(cfg.webhook_url ?? ""))
        ? null
        : "Aucune URL de webhook — l'outil est ignoré à l'exécution.";
    case "connector_action":
      return String(cfg.provider ?? "")
        ? null
        : "Aucune intégration choisie — connectez le service et sélectionnez-le.";
    case "composio_toolkit":
      return String(cfg.toolkit ?? "")
        ? null
        : "Aucun toolkit Composio choisi — connectez l'application concernée.";
    case "rag_search": {
      const collections = Array.isArray(cfg.collection_ids) ? cfg.collection_ids : [];
      if (collections.length === 0) return "Aucune base de connaissances rattachée — l'agent cherchera dans le vide.";
      return null;
    }
    case "vibe_code":
      return String(cfg.repository_id ?? "")
        ? null
        : "Aucun dépôt imposé — l'agent choisira seul s'il en existe plusieurs.";
    case "testing":
      return String(cfg.suite_id ?? "")
        ? null
        : "Aucune suite de tests imposée — l'agent choisira seul.";
    case "security_scan":
      return String(cfg.target ?? "")
        ? null
        : "Aucune cible enregistrée — déclarez le périmètre autorisé avant tout scan.";
    default:
      return null;
  }
}

/**
 * Issues that BLOCK the tool (the worker skips it entirely) versus issues that
 * only mean the agent will decide by itself. The chat banner treats the first
 * as a warning and the second as a hint, so an agent that merely lacks a pinned
 * repository doesn't look broken.
 */
export function isBlockingSetup(kind: string): boolean {
  return !["vibe_code", "testing"].includes(kind);
}

export function pendingSetup(tools: ConfigurableTool[] | undefined | null): Array<ConfigurableTool & { issue: string; blocking: boolean }> {
  return (tools ?? [])
    .filter((t) => t.enabled !== false)
    .map((t) => {
      const issue = toolSetupIssue(t);
      return issue ? { ...t, issue, blocking: isBlockingSetup(t.kind) } : null;
    })
    .filter((t): t is ConfigurableTool & { issue: string; blocking: boolean } => t !== null);
}
