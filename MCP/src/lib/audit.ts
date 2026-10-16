// Événement d'audit : une ligne JSON par appel de tool sur la sortie standard,
// collectée par la chaîne de logs existante vers le tenant Loki `ai-audit`.
// Champs : ceux de la section « Observabilité et audit » de la doc d'architecture.

export interface AuditEvent {
  ts: string;
  event: "tool_call";
  trace_id: string;
  session_id: string | null;
  user: string;
  agent: string;
  cluster: string;
  target_cluster: string;
  mcp_server: string;
  tool: string;
  /** Le tool écrit-il (redémarrage, mise à l'échelle, synchronisation, silence) ? */
  write?: boolean;
  params: unknown;
  params_hash: string;
  policy_decision: string;
  approval_id: string | null;
  approver: string | null;
  /** Mode jeton d'API : quel jeton a servi (sa révocation coupe exactement cet accès). */
  token_id?: string | null;
  status: "ok" | "error" | "denied" | "approval_required" | "invalid" | "rate_limited" | "busy" | "timeout";
  /** Les approbateurs d'une règle à quorum. */
  approvers?: string[];
  duration_ms: number;
  result_bytes: number;
  error?: string;
}

export type AuditSink = (event: AuditEvent) => void;

export const stdoutAudit: AuditSink = (event) => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};
