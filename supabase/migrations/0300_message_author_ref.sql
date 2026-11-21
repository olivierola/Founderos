-- 0300 — L'auteur externe d'un message venu d'un canal (Slack, Teams,
-- Telegram, WhatsApp…) : un tour, une seule personne.
--
-- Dans un fil partagé, le message de Bob arrivé pendant le tour d'Alice était
-- replié dans ce tour, et la passerelle faisait de Bob l'auteur du fil : il
-- pouvait valider depuis le canal les actions demandées pendant le tour
-- d'Alice. L'auteur de chaque message est désormais noté : seul l'auteur du
-- tour le pilote, les autres messages ouvrent leur propre tour ensuite
-- (supabase/functions/_shared/turn-principal.ts).
--
-- Nul pour les messages de l'application : rien ne change pour eux.

alter table public.internal_agent_messages
  add column if not exists author_ref text;
