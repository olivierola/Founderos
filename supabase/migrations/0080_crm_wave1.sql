-- "Everything is an object" — wave 1: Finance (Invoices, Bills), Support
-- (Tickets), and Integrations (connected connectors). Reuses the existing
-- catalog + mapped-props + relations + bidirectional-sync machinery (0074/0075).

-- ── Classes ───────────────────────────────────────────────────────────────────
insert into public.crm_source_catalog (slug, source_table, title_col, label, label_plural, icon, color) values
  ('invoices',     'fin_invoices',    'client_name', 'Invoice',     'Invoices',     'Receipt',     'text-amber-500'),
  ('bills',        'fin_bills',       'vendor',      'Bill',        'Bills',        'FileSignature','text-amber-600'),
  ('tickets',      'support_tickets', 'subject',     'Ticket',      'Tickets',      'LifeBuoy',    'text-sky-500'),
  ('integrations', 'connectors',      'provider',    'Integration', 'Integrations', 'Plug',        'text-fuchsia-500')
on conflict (slug) do nothing;

-- ── Mapped (editable) scalar props ───────────────────────────────────────────
insert into public.crm_source_props (object_slug, key, source_col, label, type, options, position, writable) values
  -- Invoices
  ('invoices', 'number', 'number', 'Number', 'text', '[]', 1, true),
  ('invoices', 'amount', 'amount_cents', 'Amount (cents)', 'number', '[]', 2, true),
  ('invoices', 'status', 'status', 'Status', 'select',
    '[{"value":"draft","label":"Draft","color":"#64748b"},{"value":"sent","label":"Sent","color":"#3b82f6"},{"value":"paid","label":"Paid","color":"#10b981"},{"value":"overdue","label":"Overdue","color":"#ef4444"},{"value":"void","label":"Void","color":"#64748b"}]', 3, true),
  ('invoices', 'due_date', 'due_date', 'Due date', 'date', '[]', 4, true),
  -- Bills
  ('bills', 'number', 'number', 'Number', 'text', '[]', 1, true),
  ('bills', 'amount', 'amount_cents', 'Amount (cents)', 'number', '[]', 2, true),
  ('bills', 'status', 'status', 'Status', 'text', '[]', 3, true),
  ('bills', 'due_date', 'due_date', 'Due date', 'date', '[]', 4, true),
  -- Tickets
  ('tickets', 'requester', 'requester_email', 'Requester', 'email', '[]', 1, true),
  ('tickets', 'priority', 'priority', 'Priority', 'select',
    '[{"value":"low","label":"Low","color":"#64748b"},{"value":"normal","label":"Normal","color":"#3b82f6"},{"value":"high","label":"High","color":"#f59e0b"},{"value":"urgent","label":"Urgent","color":"#ef4444"}]', 2, true),
  ('tickets', 'status', 'status', 'Status', 'select',
    '[{"value":"open","label":"Open","color":"#3b82f6"},{"value":"pending","label":"Pending","color":"#f59e0b"},{"value":"on_hold","label":"On hold","color":"#a855f7"},{"value":"solved","label":"Solved","color":"#10b981"},{"value":"closed","label":"Closed","color":"#64748b"}]', 3, true),
  -- Integrations (provider is the title; status + permissions are useful, read context)
  ('integrations', 'status', 'status', 'Status', 'text', '[]', 1, false),
  ('integrations', 'permissions', 'permissions', 'Access', 'select',
    '[{"value":"read_only","label":"Read only","color":"#64748b"},{"value":"write_enabled","label":"Write enabled","color":"#10b981"}]', 2, true)
on conflict (object_slug, key) do nothing;

-- ── Relations from real FKs ───────────────────────────────────────────────────
insert into public.crm_source_relations (object_slug, key, label, source_fk_col, target_slug, position) values
  ('invoices', 'project', 'Project', 'pm_project_id', 'projects',  5),
  ('bills',    'po',      'Purchase order', 'po_id',  'purchase_orders', 5)
on conflict (object_slug, key) do nothing;

-- ── Attach forward-sync triggers for the new source tables ────────────────────
do $$
declare c record;
begin
  for c in select distinct source_table, title_col, slug from public.crm_source_catalog loop
    execute format('drop trigger if exists trg_crm_sync_%1$s on public.%2$I', c.slug, c.source_table);
    execute format(
      'create trigger trg_crm_sync_%1$s after insert or update or delete on public.%2$I
       for each row execute function public.crm_sync_from_source(%3$L)',
      c.slug, c.source_table, c.title_col);
  end loop;
end $$;
