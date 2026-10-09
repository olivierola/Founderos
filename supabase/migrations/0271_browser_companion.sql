-- 0271_browser_companion.sql
-- Le compagnon navigateur : les collaborateurs dans le panneau latéral.
--
-- L'extension savait déjà trois choses : enregistrer une démonstration (0202),
-- agir dans les onglets (0205, canal `control`) et former quelqu'un (0218, canal
-- `coach`). Elle devient l'endroit où l'on PARLE à ses collaborateurs pendant
-- qu'on travaille ailleurs : un panneau latéral pleine hauteur, la page en cours
-- jointe d'un raccourci, et des collaborateurs qui peuvent, en retour, pointer
-- un passage de cette page ou répondre dans une bulle quand le panneau est fermé.
--
-- ┌─ LE CONSENTEMENT, ENCORE PAR ARMEMENT ─────────────────────────────────┐
-- │ Lire la page de quelqu'un n'est pas anodin. Le panneau OUVERT vaut      │
-- │ consentement : l'extension renouvelle un bail court (companion_until)  │
-- │ tant qu'il est affiché, et le laisse expirer dès qu'il se ferme. Hors   │
-- │ de ce bail, le serveur ne remet aucune lecture de page.                │
-- │                                                                        │
-- │ Reste ce qui ne lit rien : une bulle, un surlignage, les effacer.       │
-- │ C'est ce que la préférence `companion_bubbles` autorise panneau fermé : │
-- │ qu'un collaborateur puisse répondre, pas qu'il puisse regarder.        │
-- └────────────────────────────────────────────────────────────────────────┘

alter table public.recorder_devices
  add column if not exists companion_until   timestamptz,
  add column if not exists companion_bubbles boolean not null default true;

comment on column public.recorder_devices.companion_until is
  'Bail du panneau latéral : renouvelé par l''extension tant que le panneau est ouvert (~2 min). Seul ce bail autorise un collaborateur à LIRE la page en cours (browser_commands channel=companion, action=look).';
comment on column public.recorder_devices.companion_bubbles is
  'Panneau fermé, un collaborateur peut encore répondre dans une bulle ou surligner un passage (actions non lisantes). false = rien ne s''affiche hors du panneau.';

-- Un troisième canal, à côté de `control` (agir) et `coach` (former).
alter table public.browser_commands
  drop constraint if exists browser_commands_channel_check;
alter table public.browser_commands
  add constraint browser_commands_channel_check
  check (channel in ('control', 'coach', 'companion'));

comment on column public.browser_commands.channel is
  'control = l''agent agit dans la page (0205). coach = repère de formation et attente d''un geste (0218). companion = panneau latéral (0269) : lire la page, surligner, bulle ; jamais de clic ni de saisie.';

-- D'où vient une conversation. null = l'application ; 'companion' = le panneau
-- latéral du navigateur. C'est ce qui permet de rendre une réponse dans une
-- bulle quand le panneau s'est refermé entre la question et la réponse, et de
-- donner au collaborateur les outils de la page.
alter table public.internal_agent_conversations
  add column if not exists origin text;

create index if not exists idx_iac_companion
  on public.internal_agent_conversations(user_id, updated_at desc)
  where origin = 'companion';
