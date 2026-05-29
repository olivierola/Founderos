-- Recurrence for manual cost entries: one-off vs recurring (monthly/yearly).
alter table public.cost_records
  add column if not exists recurrence text not null default 'one_off'
    check (recurrence in ('one_off', 'recurring'));

alter table public.cost_records
  add column if not exists recurrence_interval text
    check (recurrence_interval in ('month', 'year'));
