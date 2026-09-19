-- 0251_conversation_requester.sql
-- Qui, dans un canal externe, a parlé à l'agent en dernier.
--
-- Sert à UNE chose : décider qui peut valider, depuis Slack ou Teams, une action
-- que l'agent demande l'autorisation de faire. La règle est que seul l'auteur de
-- la demande tranche — pas n'importe quel membre du canal.
--
-- Slack inscrivait déjà un identifiant stable dans le texte du message
-- (`[<@U123> in Slack]`) ; Teams n'y mettait que le NOM AFFICHÉ, qui n'est ni
-- unique ni infalsifiable, et ne peut donc pas servir de preuve d'identité. On
-- garde ici l'identifiant du fournisseur (Slack user id, Teams aadObjectId),
-- mis à jour à chaque message entrant.
alter table public.internal_agent_conversations
  add column if not exists external_user_ref text;

comment on column public.internal_agent_conversations.external_user_ref is
  'Identifiant, chez le fournisseur (Slack user id, Teams aadObjectId), de la dernière personne qui a écrit à l''agent dans ce canal. Seule elle peut valider depuis le canal les actions demandées par l''agent.';
