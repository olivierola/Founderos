-- "Everything is an object" — wave 2: Finance (bank accounts, journal entries)
-- + Supply (purchase orders, shipments, sales orders, warehouses, returns).
-- (fin_bank_txns + internal_agent_deliverables are skipped: no project_id, so
-- the generic forward trigger which filters new.project_id can't apply.)

insert into public.crm_source_catalog (slug, source_table, title_col, label, label_plural, icon, color) values
  ('bank_accounts',   'fin_bank_accounts',   'name',      'Bank account',  'Bank accounts',  'Wallet',  'text-emerald-500'),
  ('journal_entries', 'fin_journal_entries', 'reference', 'Journal entry', 'Journal entries','FileText', 'text-amber-500'),
  ('purchase_orders', 'sc_purchase_orders',  'reference', 'Purchase order','Purchase orders','Receipt', 'text-orange-500'),
  ('shipments',       'sc_shipments',        'reference', 'Shipment',      'Shipments',      'Truck',    'text-orange-500'),
  ('sales_orders',    'sc_sales_orders',     'reference', 'Sales order',   'Sales orders',   'Receipt',  'text-blue-500'),
  ('warehouses',      'sc_warehouses',       'name',      'Warehouse',     'Warehouses',     'Package',  'text-amber-600'),
  ('returns',         'sc_returns',          'reference', 'Return',        'Returns',        'Package',  'text-rose-500')
on conflict (slug) do nothing;

insert into public.crm_source_props (object_slug, key, source_col, label, type, options, position, writable) values
  ('journal_entries', 'status', 'status', 'Status', 'select',
    '[{"value":"draft","label":"Draft","color":"#64748b"},{"value":"posted","label":"Posted","color":"#10b981"},{"value":"reversed","label":"Reversed","color":"#ef4444"}]', 1, true),
  ('journal_entries', 'source_kind', 'source_kind', 'Source', 'text', '[]', 2, false),
  ('purchase_orders', 'status', 'status', 'Status', 'select',
    '[{"value":"draft","label":"Draft","color":"#64748b"},{"value":"sent","label":"Sent","color":"#3b82f6"},{"value":"confirmed","label":"Confirmed","color":"#a855f7"},{"value":"received","label":"Received","color":"#10b981"},{"value":"cancelled","label":"Cancelled","color":"#ef4444"}]', 1, true),
  ('shipments', 'tracking', 'tracking_number', 'Tracking #', 'text', '[]', 1, true),
  ('shipments', 'status', 'status', 'Status', 'select',
    '[{"value":"pending","label":"Pending","color":"#64748b"},{"value":"in_transit","label":"In transit","color":"#3b82f6"},{"value":"delivered","label":"Delivered","color":"#10b981"},{"value":"delayed","label":"Delayed","color":"#f59e0b"},{"value":"cancelled","label":"Cancelled","color":"#ef4444"}]', 2, true),
  ('sales_orders', 'status', 'status', 'Status', 'text', '[]', 1, true),
  ('returns', 'status', 'status', 'Status', 'text', '[]', 1, true)
on conflict (object_slug, key) do nothing;

insert into public.crm_source_relations (object_slug, key, label, source_fk_col, target_slug, position) values
  ('purchase_orders', 'supplier', 'Supplier', 'supplier_id', 'suppliers',   5),
  ('shipments',       'po',       'Purchase order', 'po_id', 'purchase_orders', 5),
  ('returns',         'order',    'Sales order', 'order_id', 'sales_orders', 5),
  ('returns',         'item',     'Item',     'item_id',    'inventory',    6)
on conflict (object_slug, key) do nothing;

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
