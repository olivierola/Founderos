// L'interrupteur du CRM.
//
// Le module CRM est masqué (décision du 12/10/2026) : son code reste, mais
// rien ne doit plus le solliciter — ni l'interface (routes retirées), ni le
// serveur. Chaque point qui lit ou écrit le CRM passe par ce test : la
// fonction crm-action, l'outil `crm` des agents, l'exécution d'une approbation
// crm_write, les recherches de LeadSense dans les fiches, les lectures de
// tables crm_* par query_table.
//
// Pour le rallumer : CRM_ENABLED=1 côté serveur, et remettre le module dans la
// navigation (src/lib/navigation.ts, DISABLED_MODULES).

export function crmEnabled(): boolean {
  return (Deno.env.get("CRM_ENABLED") ?? "").trim() === "1";
}

/** Le CRM est masqué : les tables crm_* ne se lisent pas, même par query_table. */
export function isCrmTable(table: string): boolean {
  return /^crm_/i.test(table);
}

export const CRM_DISABLED_MESSAGE = "Le CRM est désactivé sur cette installation (CRM_ENABLED).";
