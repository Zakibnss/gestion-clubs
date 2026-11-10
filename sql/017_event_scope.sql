-- ============================================================
-- 017 — Portée des événements : local (club) ou général (tous les clubs)
--
-- . 'local'   : événement propre au club qui l'a créé (comportement
--               historique).
-- . 'general' : événement inter-clubs, visible dans TOUS les clubs et
--               ouvert aux adhérents de tous les clubs/groupes.
--
-- Réexécutable, non destructif.
-- ============================================================

alter table if exists public.events
    add column if not exists scope text not null default 'local';

-- Contrainte de valeurs (idempotente)
do $$
begin
    if not exists (
        select 1
          from pg_constraint
         where conname = 'events_scope_check'
           and conrelid = 'public.events'::regclass
    ) then
        alter table public.events
            add constraint events_scope_check
            check (scope in ('local', 'general'));
    end if;
end $$;

-- Index pour les listes « événements du club + généraux »
create index if not exists idx_events_scope
    on public.events (scope);

-- Accès REST (même modèle que les autres tables V2)
alter table if exists public.events disable row level security;
grant all privileges on public.events to anon, authenticated;

-- ---------- Contrôle ----------
select scope, count(*) as nb
from public.events
group by scope;
