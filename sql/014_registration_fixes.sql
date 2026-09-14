-- ============================================================
-- 014 — Correctifs renouvellement d'inscription (complément 012)
--
-- Préréquist : migration 012 exécutée (table registrations,
--              RPC renew_member_registration, season_key).
--
-- 1. RLS : la migration 012 ne faisait que grant select sur
--    registrations, mais si la table a été créée avec RLS activé
--    (comme les autres tables V2), toute lecture REST directe
--    retombe sur `no policy` / 401. On suit le même modèle que
--    sql/010 (disable RLS + grants) pour registrations et la vue
--    registration_status (qui est lue par l'application clients).
--
-- 2. days_left de member_subscription_status : extract(day ...)
--    retourne le jour-du-mois du diff (0-30) au lieu du nombre
--    total de jours. On remplace par un simple cast int.
--
-- Réexécutable, non destructif.
-- ============================================================

-- ---------- 1. Accès REST registrations / registration_status ----------
alter table if exists public.registrations disable row level security;

grant all privileges on public.registrations to anon, authenticated;
grant select on public.registration_status to anon, authenticated;

-- ---------- 2. Correction days_left de member_subscription_status ----------
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
    greatest(0, (
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
    )::int)                                          as days_left,
    (select r.season_key
       from public.registrations r
      where r.member_id = m.id and r.is_active
      order by r.start_date desc
      limit 1)                                       as season_key
from public.members m;

grant select on public.member_subscription_status to anon, authenticated;

-- ---------- 3. Contrôles ----------
select count(*) as nb_registrations
from public.registrations;