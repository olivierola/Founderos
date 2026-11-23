// Le catalogue des actions des connecteurs maison, en SQL (migration 0293).
//
// La source de vérité est supabase/functions/_shared/connector-actions.ts
// (CONNECTOR_ACTIONS) ; le registre des ressources, écrit par des triggers
// SQL, ne peut pas la lire. Ce script en tire le bloc qui synchronise la table
// public.connector_action_catalog. Une action ajoutée ou retirée côté
// TypeScript fait échouer connector-catalog.test.ts : on régénère alors ce
// bloc dans une nouvelle migration.
//
//   npx tsx src/shared/connector-catalog-sql.ts > bloc.sql

import { CONNECTOR_ACTIONS } from "../edge/_shared/connector-actions.ts";

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function catalogRows(): Array<{ provider: string; action: string; description: string; is_write: boolean }> {
  const rows: Array<{ provider: string; action: string; description: string; is_write: boolean }> = [];
  for (const provider of Object.keys(CONNECTOR_ACTIONS).sort()) {
    for (const a of CONNECTOR_ACTIONS[provider]) {
      rows.push({ provider, action: a.name, description: a.description, is_write: a.write === true });
    }
  }
  return rows;
}

export function catalogSql(): string {
  const values = catalogRows()
    .map((r) => `  (${q(r.provider)}, ${q(r.action)}, ${q(r.description)}, ${r.is_write})`)
    .join(",\n");
  return [
    "insert into public.connector_action_catalog (provider, action, description, is_write) values",
    values,
    "on conflict (provider, action) do update set description = excluded.description, is_write = excluded.is_write;",
    "",
    "delete from public.connector_action_catalog c",
    " where not exists (select 1 from (values",
    catalogRows().map((r) => `   (${q(r.provider)}, ${q(r.action)})`).join(",\n"),
    "   ) v(provider, action) where v.provider = c.provider and v.action = c.action);",
  ].join("\n");
}

/** À la suite du bloc, dans une migration postérieure à 0293 : les connexions
 *  maison reprennent le catalogue à jour. */
export const RESYNC_SQL = `do $$
declare v_id uuid;
begin
  for v_id in select id from public.connectors where source = 'in_house' loop
    perform public.resource_registry_sync_app_connector(v_id);
  end loop;
end;
$$;`;

if (process.argv[1] && /connector-catalog-sql\.ts$/.test(process.argv[1])) {
  console.log(`${catalogSql()}\n\n${RESYNC_SQL}`);
}
