/**
 * La page d'un collaborateur a deux vues : son tableau de bord (par défaut,
 * ce qu'ouvre une carte) et son chat (`?view=chat`, ou un lien vers une
 * conversation précise, `?c=`). Un onglet de la barre du haut rouvre celle
 * qu'on a quittée, pour la durée de la session.
 */
export type AgentView = "home" | "chat";

const key = (agentId: string) => `sd_agent_view:${agentId}`;

export function rememberAgentView(agentId: string, view: AgentView): void {
  try { sessionStorage.setItem(key(agentId), view); } catch { /* stockage bloqué */ }
}

export function lastAgentView(agentId: string): AgentView {
  try { return sessionStorage.getItem(key(agentId)) === "chat" ? "chat" : "home"; } catch { return "home"; }
}

/** Le lien d'un onglet d'agent : la vue où on l'a laissé. */
export function agentTabHref(base: string, agentId: string): string {
  return `${base}/agent/${agentId}${lastAgentView(agentId) === "chat" ? "?view=chat" : ""}`;
}

/** Les dashboards qu'un collaborateur remplit. */
export function agentDashboardsHref(base: string, agentId: string): string {
  return `${base}/agent/${agentId}?view=dashboards`;
}

/** Le chat d'un collaborateur, qui envoie aussitôt une question écrite ailleurs
 *  (un composant de dashboard, par exemple). */
export function agentAskHref(base: string, agentId: string, question: string): string {
  return `${base}/agent/${agentId}?view=chat&ask=${encodeURIComponent(question)}`;
}

/** Le chat d'un collaborateur. */
export function agentChatHref(base: string, agentId: string, conversationId?: string | null): string {
  return `${base}/agent/${agentId}?${conversationId ? `c=${conversationId}` : "view=chat"}`;
}
