-- 0287_room_reactions.sql
-- Deux choses qui rapprochent une room d'une messagerie ordinaire.
--
-- 1. Les RÉACTIONS sur un message (👍 👎 ❤️ et quelques emojis). Une ligne par
--    (message, personne, emoji) : réagir une seconde fois avec le même emoji le
--    retire — c'est un interrupteur, pas un compteur qu'on incrémente. Une
--    réaction posée sur le message d'un agent le prévient (service-room-post,
--    op "react") ; il juge lui-même s'il y a quelque chose à répondre.
--
-- 2. Le PROFIL des personnes d'une room (nom, avatar). `profiles` ne laisse
--    lire que sa propre ligne : sans cette fonction, chaque message humain
--    s'affichait sous le nom de celui qui lisait le fil, et l'en-tête ne
--    pouvait montrer personne d'autre que lui.

create table if not exists public.service_room_message_reactions (
  message_id   uuid not null references public.service_room_messages(id) on delete cascade,
  room_id      uuid not null references public.service_rooms(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  emoji        text not null check (char_length(emoji) between 1 and 16),
  created_at   timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);
create index if not exists idx_room_reactions_room on public.service_room_message_reactions(room_id);

alter table public.service_room_message_reactions enable row level security;

create policy "members read room reactions" on public.service_room_message_reactions for select
  using (exists (
    select 1 from public.workspace_members wm
     where wm.workspace_id = service_room_message_reactions.workspace_id and wm.user_id = auth.uid()
  ));

-- On ne réagit qu'en son propre nom, et dans un espace dont on est membre.
create policy "members add own reactions" on public.service_room_message_reactions for insert
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.workspace_members wm
       where wm.workspace_id = service_room_message_reactions.workspace_id and wm.user_id = auth.uid()
    )
  );

create policy "members remove own reactions" on public.service_room_message_reactions for delete
  using (user_id = auth.uid());

-- Les personnes d'une room : son créateur, quiconque y a écrit ou réagi.
-- SECURITY DEFINER pour lire auth.users et les profils des autres, mais
-- seulement pour un membre de l'espace de la room — sinon, rien.
create or replace function public.room_member_profiles(p_room uuid)
returns table (id uuid, name text, avatar_url text)
language sql
stable
security definer
set search_path = public, auth
as $$
  with r as (
    select sr.id, sr.created_by
      from public.service_rooms sr
     where sr.id = p_room
       and exists (
         select 1 from public.workspace_members wm
          where wm.workspace_id = sr.workspace_id and wm.user_id = auth.uid()
       )
  ), people as (
    select r.created_by as uid from r where r.created_by is not null
    union
    select m.user_id from public.service_room_messages m join r on r.id = m.room_id where m.user_id is not null
    union
    select x.user_id from public.service_room_message_reactions x join r on r.id = x.room_id
  )
  select u.id,
         coalesce(
           nullif(p.full_name, ''),
           nullif(u.raw_user_meta_data->>'full_name', ''),
           nullif(u.raw_user_meta_data->>'name', ''),
           split_part(u.email, '@', 1)
         ) as name,
         coalesce(nullif(p.avatar_url, ''), nullif(u.raw_user_meta_data->>'avatar_url', '')) as avatar_url
    from people
    join auth.users u on u.id = people.uid
    left join public.profiles p on p.id = u.id;
$$;

grant execute on function public.room_member_profiles(uuid) to authenticated;
