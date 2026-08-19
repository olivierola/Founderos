-- 0204 · Qui capture la démonstration — l'extension ou Playwright.
--
-- Les deux capteurs réclament au même endpoint. Sans arbitrage, le premier
-- arrivé gagnait : lancer une démonstration avec les deux installés ouvrait
-- tantôt un onglet, tantôt une fenêtre Playwright, au hasard du réseau. Un
-- utilisateur ne peut pas travailler avec ça.
--
-- L'enregistrement dit donc CE QU'IL ATTEND, et chaque capteur dit CE QU'IL EST
-- (rec_claim, champ `capture`). Le serveur n'apparie que les compatibles.
--
--   'extension'  — seule l'extension navigateur peut le prendre
--   'playwright' — seul le recorder Playwright peut le prendre
--   'any'        — le premier disponible (défaut : c'est le comportement utile
--                  quand l'app ne sait pas ce qui tourne sur le poste)

alter table public.skill_recordings
  add column if not exists capture_mode text not null default 'any';

-- Le capteur qui a effectivement pris la main, pour que l'UI et le diagnostic
-- disent la vérité plutôt que de la supposer.
alter table public.skill_recordings
  add column if not exists captured_by text;

-- Les enregistrements en attente sont filtrés à chaque réclamation.
create index if not exists idx_skill_recordings_claimable
  on public.skill_recordings(capture_mode, created_at desc) where status = 'pending';
