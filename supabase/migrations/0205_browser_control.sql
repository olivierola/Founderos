-- 0205 · Pilotage du navigateur de l'utilisateur par un agent.
--
-- Suite naturelle de l'enregistrement : après avoir APPRIS une procédure en
-- regardant faire, l'agent doit pouvoir l'EXÉCUTER. Et l'exécuter là où les
-- sessions existent — le navigateur de l'utilisateur — plutôt que dans un
-- Chromium de sandbox où il faudrait se reconnecter partout.
--
-- ┌─ LE MODÈLE DE CONSENTEMENT ────────────────────────────────────────────┐
-- │ Un agent qui pilote un navigateur connecté peut faire tout ce que son   │
-- │ propriétaire peut faire. Demander une approbation PAR ACTION serait     │
-- │ inutilisable (une procédure = vingt clics) et pousserait à tout         │
-- │ approuver sans lire — le pire des deux mondes.                          │
-- │                                                                        │
-- │ Le consentement porte donc sur l'ARMEMENT : l'utilisateur autorise      │
-- │ explicitement, depuis l'extension, pour une DURÉE bornée et un          │
-- │ PÉRIMÈTRE de domaines. Hors de cette fenêtre, aucune commande n'est     │
-- │ servie — pas « refusée par politesse » : jamais remise à l'appareil.    │
-- └────────────────────────────────────────────────────────────────────────┘

-- Fenêtre d'autorisation, portée par l'appareil lui-même.
alter table public.recorder_devices
  add column if not exists control_until   timestamptz,
  -- Vide = tous les domaines. Sinon, liste d'origines autorisées.
  add column if not exists control_origins text[] not null default '{}';

-- Une commande = un ordre unitaire adressé à un appareil, et sa réponse.
-- La table sert aussi de journal : ce que l'agent a fait dans le navigateur de
-- quelqu'un doit rester lisible après coup.
create table if not exists public.browser_commands (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  device_id    uuid references public.recorder_devices(id) on delete cascade,
  agent_id     uuid references public.internal_agents(id) on delete set null,
  run_id       uuid,
  action       text not null,
  params       jsonb not null default '{}',
  status       text not null default 'pending',  -- pending|running|done|failed|expired
  result       jsonb,
  error        text,
  -- Une commande non servie doit MOURIR. Sans expiration, un ordre émis pendant
  -- que l'appareil dormait s'exécuterait à son réveil, hors de tout contexte —
  -- l'utilisateur verrait son navigateur bouger sans raison.
  expires_at   timestamptz not null default (now() + interval '2 minutes'),
  created_at   timestamptz not null default now(),
  claimed_at   timestamptz,
  finished_at  timestamptz
);

create index if not exists idx_browser_commands_queue
  on public.browser_commands(device_id, created_at) where status = 'pending';
create index if not exists idx_browser_commands_ws
  on public.browser_commands(workspace_id, created_at desc);

alter table public.browser_commands enable row level security;

-- Les membres LISENT le journal des commandes de leur workspace. L'écriture
-- passe par le runtime d'agent et l'extension, tous deux en service role : une
-- page web ne doit pas pouvoir fabriquer un ordre pour le navigateur de
-- quelqu'un, même en étant membre.
drop policy if exists "members read browser_commands" on public.browser_commands;
create policy "members read browser_commands" on public.browser_commands for select
  using (exists (
    select 1 from public.workspace_members wm
    where wm.workspace_id = browser_commands.workspace_id and wm.user_id = auth.uid()
  ));
