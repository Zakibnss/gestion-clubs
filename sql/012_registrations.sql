-- ============================================================
-- MIGRATION 012 — Renouvellement d'inscription par SAISON
--
-- Ajoute la notion de saison (ex. 2025/2026, 2026/2027) SANS
-- casser le système existant (members.start_date + paiements
-- mensuels + présences par mois).
--
-- Ce qui est ajouté (additif, non destructif) :
--   1. Table    public.registrations   — une inscription par saison
--                                        (unique member_id + season_key)
--   2. Vue      public.registration_status — saison active / historique
--   3. RPC      public.season_key_for_date(date)          -> 'YYYY/YYYY'
--   4. RPC      public.renew_member_registration(...)      -> transactionnel
--   5. Colonne  season_key ajoutée à la vue member_subscription_status
--                (create or replace — vérifier la continuité existante)
--
-- À exécuter dans le SQL Editor Supabase.
-- ============================================================

-- ============================================================
-- 1. TABLE registrations
-- ============================================================
create table if not exists public.registrations (
    id                uuid primary key default gen_random_uuid(),
    member_id         text        not null references public.members(id) on delete cascade,
    club_id           text,
    season_key        text        not null check (season_key ~ '^[0-9]{4}/[0-9]{4}$'),
    subscription_type text        not null default 'monthly'
                                  check (subscription_type in ('monthly','quarterly','biannual','annual')),
    start_date        date        not null default current_date,
    end_date          date,
    months_from       date        not null default current_date,
    is_active         boolean     not null default true,
    notes             text,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    -- Contrainte logique : jamais deux inscriptions pour la même
    -- saison (empêche le double renouvellement en base).
    unique (member_id, season_key)
);

create index if not exists idx_registrations_member
    on public.registrations (member_id);
create index if not exists idx_registrations_season
    on public.registrations (season_key);

-- Trigger updated_at (réutilise set_updated_at de la migration 011)
drop trigger if exists trg_registrations_updated on public.registrations;
create trigger trg_registrations_updated
    before update on public.registrations
    for each row execute function public.set_updated_at();

-- Contrainte : une seule inscription active par adhérent à la fois.
-- (ré-indexée partielle — les anciennes restent actives si is_active=false)
create unique index if not exists idx_registrations_one_active
    on public.registrations (member_id)
    where is_active;

-- ============================================================
-- 2. VUE registration_status — saison active + historique
-- ============================================================
create or replace view public.registration_status as
select
    r.id,
    r.member_id,
    r.season_key,
    r.subscription_type,
    r.start_date,
    coalesce(r.end_date,
        (r.start_date + interval '1 month' * (case r.subscription_type
            when 'monthly'   then 1
            when 'quarterly' then 3
            when 'biannual'  then 6
            when 'annual'    then 12
            else 1 end))::date) as end_date_effective,
    r.months_from,
    r.is_active,
    r.notes,
    r.created_at,
    r.updated_at,
    m.last_name,
    m.first_name
from public.registrations r
left join public.members m on m.id = r.member_id;

-- ============================================================
-- 3. RPC season_key_for_date — 'YYYY/YYYY' (rentrée septembre)
-- ============================================================
create or replace function public.season_key_for_date(p_date date default current_date)
returns text
language sql
immutable
as $$
    select (case
        -- Si mois >= septembre : saison commence cette année
        when extract(month from p_date) >= 9
            then (extract(year from p_date)::int) || '/' || (extract(year from p_date)::int + 1)
        -- Sinon (janvier → août) : saison 2025/2026 pour un mois de 2026
        else (extract(year from p_date)::int - 1) || '/' || (extract(year from p_date)::int)
    end);
$$;

grant execute on function public.season_key_for_date(date) to anon, authenticated;

-- ============================================================
-- 4. RPC renew_member_registration — renouvellement transactionnel
-- ============================================================
-- Paramètres :
--   p_member_id        : l'adhérent (même id, jamais dupliqué)
--   p_season_key       : '2026/2027' (nouvelle saison)
--   p_subscription_type: 'monthly'|'quarterly'|'biannual'|'annual'
--   p_start_date       : date de début (défaut = date courante)
--   p_notes            : optionnel
-- Comportement :
--   - Refuse si l'adhérent a déjà une inscription pour cette saison.
--   - Crée l'inscription, désactive l'ancienne inscription active.
--   - Met à jour members.start_date / members.subscription (continuité
--     de l'affichage existant — l'historique reste dans registrations).
--   - NE touche pas aux paiements / présences / NFC déjà existants.
--   - Retourne la nouvelle inscription.
-- ============================================================
create or replace function public.renew_member_registration(
    p_member_id         text,
    p_season_key        text,
    p_subscription_type text default 'monthly',
    p_start_date        date default current_date,
    p_notes             text default null
)
returns public.registrations
language plpgsql
security definer
set search_path = public
as $$
declare
    v_member  public.members%rowtype;
    v_dup     public.registrations;
    v_season  text := upper(trim(p_season_key));
    v_type    text := lower(trim(p_subscription_type));
    v_reg     public.registrations;
begin
    -- L'adhérent doit exister
    select * into v_member from public.members where id = p_member_id;
    if not found then
        raise exception 'Adhérent introuvable' using errcode = 'P0001';
    end if;

    -- Format de saison valide
    if v_season !~ '^[0-9]{4}/[0-9]{4}$' then
        raise exception 'Saison invalide : %', v_season using errcode = 'P0001';
    end if;
    if v_type not in ('monthly','quarterly','biannual','annual') then
        raise exception 'Type d''abonnement invalide : %', p_subscription_type using errcode = 'P0001';
    end if;

    -- Double renouvellement interdit
    select * into v_dup from public.registrations
     where member_id = p_member_id and season_key = v_season;
    if found then
        raise exception 'Cet adhérent est déjà inscrit pour la saison %', v_season
            using errcode = 'P0001';
    end if;

    -- Désactive l'ancienne inscription active (conserve l'historique)
    update public.registrations
       set is_active = false,
           end_date  = coalesce(end_date, p_start_date - 1)
     where member_id = p_member_id and is_active;

    -- Crée la nouvelle inscription
    insert into public.registrations
        (member_id, club_id, season_key, subscription_type, start_date, months_from, is_active, notes)
    values
        (p_member_id, v_member.club_id, v_season, v_type, p_start_date, p_start_date, true, p_notes)
    returning * into v_reg;

    -- Maintient la continuité de l'affichage legacy (members.start_date /
    -- members.subscription) — l'historique complet reste dans registrations.
    update public.members
       set start_date  = p_start_date,
           subscription = v_type
     where id = p_member_id;

    return v_reg;
end;
$$;

grant execute on function public.renew_member_registration(text, text, text, date, text)
    to anon, authenticated;

comment on function public.renew_member_registration(text, text, text, date, text) is
    'V2 - Renouvelle l''inscription d''un adhérent pour une nouvelle saison (même member_id).';

-- ============================================================
-- 5. Étendre member_subscription_status avec season_key
-- ============================================================
-- ⚠ Renseignez le corps EXACT de la vue existante (celle créée via
--    l'éditeur SQL Supabase) si elle contient une logique de continuité
--    (effective_subscription_end) différente. La version ci-dessous
--    conserve les colonnes utilisées partout :
--      member_id, end_effective, is_active, days_left, season_key
-- ============================================================
create or replace view public.member_subscription_status as
select
    m.id                                              as member_id,
    m.club_id,
    m.last_name,
    m.first_name,
    -- date de fin effective : via l'inscription active, sinon legacy
    coalesce(
        (select r.end_date
           from public.registrations r
          where r.member_id = m.id and r.is_active
          order by r.start_date desc
          limit 1),
        m.start_date + interval '1 month' * (case m.subscription
            when 'monthly'   then 1
            when 'quarterly' then 3
            when 'biannual'  then 6
            when 'annual'    then 12
            else 1 end)
    )::date                                          as end_effective,
    (m.start_date + interval '1 month' * (case m.subscription
        when 'monthly'   then 1
        when 'quarterly' then 3
        when 'biannual'  then 6
        when 'annual'    then 12
        else 1 end))::date                           as end_legacy,
    (m.start_date + interval '1 month' * (case m.subscription
        when 'monthly'   then 1
        when 'quarterly' then 3
        when 'biannual'  then 6
        when 'annual'    then 12
        else 1 end))::date >= current_date           as is_active,
    greatest(0, extract(day from (
        coalesce(
            (select r.end_date
               from public.registrations r
              where r.member_id = m.id and r.is_active
              order by r.start_date desc
              limit 1),
            m.start_date + interval '1 month' * (case m.subscription
                when 'monthly'   then 1
                when 'quarterly' then 3
                when 'biannual'  then 6
                when 'annual'    then 12
                else 1 end)
        ) - current_date
    ))::int)                                         as days_left,
    (select r.season_key
       from public.registrations r
      where r.member_id = m.id and r.is_active
      order by r.start_date desc
      limit 1)                                       as season_key
from public.members m;

grant select on public.registrations,
    public.registration_status,
    public.member_subscription_status
    to anon, authenticated;