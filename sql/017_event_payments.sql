-- ============================================================
-- 017 — Événements : lieu + prix + accès REST des paiements
--
-- Problème : la table public.events ne possède pas les colonnes
-- `lieu` et `price` utilisées par l'application. La création /
-- modification d'un événement échoue avec PGRST204
-- (« Could not find the 'price' column of 'events' »).
--
-- Elle n'a pas non plus `updated_at`, alors qu'un trigger BEFORE UPDATE
-- utilise public.set_updated_at() : toute modification renvoie
-- « record "new" has no field "updated_at" » (SQLSTATE 42703).
--
-- Cette migration est additive et non destructive :
--   1. ajoute events.lieu, events.price et events.updated_at
--   2. (re)crée le trigger updated_at si nécessaire
--   3. désactive RLS sur events / event_participants / event_payments
--      (même modèle que sql/010 : clé anon + login applicatif)
--   4. accorde les privilèges REST aux rôles anon / authenticated
--   5. ajoute les index utiles aux paiements et participations
--   6. recharge le cache de schéma PostgREST
--
-- À exécuter dans le SQL Editor Supabase. Réexécutable.
-- ============================================================

-- ---------- 1. Colonnes manquantes ----------
alter table if exists public.events
    add column if not exists lieu text;

alter table if exists public.events
    add column if not exists price numeric(10,2) not null default 0;

-- La table events est soumise à un trigger BEFORE UPDATE qui utilise
-- public.set_updated_at() : sans cette colonne, toute modification échoue
-- avec « record "new" has no field "updated_at" » (SQLSTATE 42703).
alter table if exists public.events
    add column if not exists updated_at timestamptz not null default now();

do $$
begin
    if not exists (
        select 1 from pg_trigger
        where tgname = 'trg_events_updated_at'
          and tgrelid = 'public.events'::regclass
    ) then
        create trigger trg_events_updated_at
            before update on public.events
            for each row execute function public.set_updated_at();
    end if;
end $$;

-- ---------- 2. Accès REST ----------
alter table if exists public.events              disable row level security;
alter table if exists public.event_participants  disable row level security;
alter table if exists public.event_payments      disable row level security;

grant usage on schema public to anon, authenticated;

grant all privileges on public.events,
                        public.event_participants,
                        public.event_payments
    to anon, authenticated;

-- Tables avec id serial / identity : les rôles API ont besoin des séquences.
do $$
begin
    if exists (select 1 from information_schema.sequences
               where sequence_schema = 'public') then
        execute 'grant usage, select on all sequences in schema public to anon, authenticated';
    end if;
end $$;

-- ---------- 3. Index utiles ----------
create index if not exists idx_event_participants_event
    on public.event_participants (event_id);

create index if not exists idx_event_participants_member
    on public.event_participants (member_id);

create index if not exists idx_event_payments_participant_created
    on public.event_payments (participant_id, created_at desc);

-- ---------- 4. Rechargement du cache PostgREST ----------
notify pgrst, 'reload schema';
