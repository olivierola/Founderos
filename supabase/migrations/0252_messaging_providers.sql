-- 0252_messaging_providers.sql
-- WhatsApp, et un coffre pour les secrets propres à chaque messagerie.
--
-- 0100 prévoyait déjà Discord et Telegram dans la contrainte des fournisseurs,
-- sans que rien ne les branche. On y ajoute WhatsApp, et la passerelle
-- `messaging-gateway` sert les trois.
--
-- Chaque messagerie authentifie ses appels à sa façon, et il faut garder le
-- secret qui permet de les vérifier :
--   · Telegram — le jeton secret du webhook (en-tête X-Telegram-Bot-Api-Secret-Token) ;
--   · Discord  — la clé publique Ed25519 de l'application, et son identifiant ;
--   · WhatsApp — le secret d'app (signature X-Hub-Signature-256) et le jeton de
--     vérification du webhook.
--
-- Ils vont dans `internal_agent_channel_tokens`, la table SANS politique RLS que
-- seul le rôle service lit : un secret de signature qui fuit vers le navigateur
-- permettrait de forger des messages au nom de n'importe quel utilisateur.

alter table public.internal_agent_channels
  drop constraint if exists internal_agent_channels_provider_check;

alter table public.internal_agent_channels
  add constraint internal_agent_channels_provider_check
  check (provider in ('slack', 'teams', 'discord', 'telegram', 'whatsapp'));

alter table public.internal_agent_channel_tokens
  add column if not exists secrets jsonb not null default '{}'::jsonb;

comment on column public.internal_agent_channel_tokens.secrets is
  'Secrets de vérification propres au fournisseur (secret de webhook Telegram, clé publique Discord, secret d''app WhatsApp…). Lu par le seul rôle service.';
