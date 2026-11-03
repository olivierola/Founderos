-- 0288_agent_self_learning.sql
-- L'auto-apprentissage : quand l'utilisateur reprend un agent sur ce qu'il
-- vient de faire (« tu as oublié de joindre le devis », « non, c'est le CRM
-- qu'il fallait mettre à jour, pas le tableur »), la correction ne doit pas
-- mourir avec la conversation. Le système la détecte, en tire une leçon
-- durable et corrige le fichier qui aurait dû l'empêcher :
--
--   • instructions — un défaut d'exécution : étape oubliée, mauvais outil,
--     mauvaise procédure. La leçon s'ajoute sous « ## Leçons apprises » ou
--     remplace la consigne fautive.
--   • soul         — un défaut de caractère : trop servile, trop bavard,
--     rassure au lieu de vérifier. Rare, et seuil de confiance plus haut.
--   • preferences  — une habitude de forme de l'utilisateur (langue, format,
--     canal) — même fichier que remember_preference.
--
-- Chaque correction est JOURNALISÉE ici avec le texte d'avant et d'après :
-- une ligne apparue toute seule dans des instructions écrites par un humain
-- doit pouvoir s'expliquer (quelle remarque, quel raisonnement) et s'annuler
-- en un clic. Le mode par agent décide si la correction s'applique d'elle-même
-- ou attend une validation.

alter table public.internal_agents
  add column if not exists self_learning text not null default 'auto'
    check (self_learning in ('off', 'suggest', 'auto'));

comment on column public.internal_agents.self_learning is
  'Auto-apprentissage sur les remarques de l''utilisateur : off (rien), suggest (propose la correction, un humain l''applique), auto (applique les corrections sûres, propose les autres).';

create table if not exists public.internal_agent_learnings (
  id                uuid primary key default gen_random_uuid(),
  agent_id          uuid not null references public.internal_agents(id) on delete cascade,
  workspace_id      uuid not null references public.workspaces(id) on delete cascade,
  project_id        uuid,
  -- D'où vient la remarque.
  source            text not null check (source in ('chat', 'room')),
  source_message_id text not null,
  conversation_id   uuid,
  room_id           uuid,
  run_id            uuid,
  user_id           uuid references auth.users(id) on delete set null,
  feedback          text not null,
  agent_output      text,
  -- Ce que le juge en a compris.
  kind              text,
  target_file       text not null check (target_file in ('instructions', 'soul', 'preferences')),
  lesson            text not null,
  rationale         text,
  confidence        numeric(3,2),
  -- La correction : le fichier entier avant/après (annulation exacte), plus le
  -- fragment remplacé (annulation quand le fichier a bougé depuis).
  before_text       text,
  after_text        text,
  patch             jsonb not null default '{}'::jsonb,
  status            text not null check (status in ('applied', 'proposed', 'rejected', 'reverted', 'skipped')),
  detail            text,
  created_at        timestamptz not null default now(),
  decided_at        timestamptz,
  decided_by        uuid references auth.users(id) on delete set null,
  -- Une remarque n'apprend qu'une fois, même si la requête est rejouée.
  unique (agent_id, source_message_id)
);

create index if not exists idx_agent_learnings_agent on public.internal_agent_learnings(agent_id, created_at desc);

alter table public.internal_agent_learnings enable row level security;

drop policy if exists "Read internal_agent_learnings via agent access" on public.internal_agent_learnings;
create policy "Read internal_agent_learnings via agent access" on public.internal_agent_learnings for select
  using (public.has_internal_agent_access(agent_id, auth.uid()));

-- Pas d'écriture directe : le moteur écrit en service role, et l'humain passe
-- par agent_learning_decide() ci-dessous, qui touche au fichier ET au journal
-- dans la même transaction.

-- ---------------------------------------------------------------------------
-- Appliquer / annuler / rejeter une leçon.
--
-- Mêmes droits que l'éditeur de fichiers : le créateur de l'agent ou un membre
-- « editor ». Compare-and-swap sur le fichier : si quelqu'un l'a modifié depuis,
-- on retombe sur le fragment (patch.find / patch.replace) quand il est encore
-- là une seule fois, sinon on refuse plutôt que d'écraser.
-- ---------------------------------------------------------------------------
create or replace function public.agent_learning_decide(p_learning uuid, p_action text)
returns public.internal_agent_learnings
language plpgsql
security definer
set search_path = public
as $$
declare
  l       public.internal_agent_learnings;
  a       public.internal_agents;
  cur     text;
  nxt     text;
  frag_from text;
  frag_to   text;
  hits    int;
begin
  if p_action not in ('apply', 'revert', 'reject') then
    raise exception 'action inconnue : %', p_action;
  end if;

  select * into l from public.internal_agent_learnings where id = p_learning for update;
  if not found then raise exception 'leçon introuvable'; end if;

  select * into a from public.internal_agents where id = l.agent_id for update;
  if not (
    a.created_by = auth.uid()
    or exists (select 1 from public.internal_agent_members m
                where m.agent_id = a.id and m.user_id = auth.uid() and m.role = 'editor')
  ) then
    raise exception 'seul le créateur de l''agent ou un éditeur peut décider d''une leçon';
  end if;

  if p_action = 'reject' then
    if l.status <> 'proposed' then raise exception 'seule une proposition peut être rejetée'; end if;
    update public.internal_agent_learnings
       set status = 'rejected', decided_at = now(), decided_by = auth.uid()
     where id = l.id returning * into l;
    return l;
  end if;

  cur := case l.target_file
           when 'instructions' then a.instructions
           when 'soul' then a.soul
           else a.preferences
         end;

  if p_action = 'apply' then
    if l.status <> 'proposed' then raise exception 'seule une proposition peut être appliquée'; end if;
    frag_from := coalesce(l.patch->>'find', '');
    frag_to   := coalesce(l.patch->>'replace', '');
  else
    if l.status <> 'applied' then raise exception 'seule une leçon appliquée peut être annulée'; end if;
    -- Annuler = le même remplacement, dans l'autre sens.
    frag_from := coalesce(l.patch->>'replace', '');
    frag_to   := coalesce(l.patch->>'find', '');
  end if;

  if cur is not distinct from (case when p_action = 'apply' then l.before_text else l.after_text end) then
    nxt := case when p_action = 'apply' then l.after_text else l.before_text end;
  elsif p_action = 'apply' and frag_from = '' then
    -- Un ajout s'applique sur n'importe quelle version du fichier.
    nxt := coalesce(cur, '') || frag_to;
  elsif frag_from <> '' and coalesce(cur, '') <> '' then
    hits := (length(cur) - length(replace(cur, frag_from, ''))) / length(frag_from);
    if hits <> 1 then
      raise exception 'le fichier a changé depuis cette leçon — modifiez-le à la main dans Fichiers';
    end if;
    nxt := replace(cur, frag_from, frag_to);
  else
    raise exception 'le fichier a changé depuis cette leçon — modifiez-le à la main dans Fichiers';
  end if;

  if l.target_file = 'instructions' then
    update public.internal_agents set instructions = nxt, instruction_blocks = '[]'::jsonb, updated_at = now() where id = a.id;
  elsif l.target_file = 'soul' then
    update public.internal_agents set soul = nxt, updated_at = now() where id = a.id;
  else
    update public.internal_agents
       set preferences = nxt, preferences_updated_at = now(), preferences_updated_by = 'user', updated_at = now()
     where id = a.id;
  end if;

  update public.internal_agent_learnings
     set status = case when p_action = 'apply' then 'applied' else 'reverted' end,
         decided_at = now(), decided_by = auth.uid()
   where id = l.id returning * into l;
  return l;
end;
$$;

revoke all on function public.agent_learning_decide(uuid, text) from public;
grant execute on function public.agent_learning_decide(uuid, text) to authenticated;
