-- ============================================================
-- 018 — DIAGNOSTIC : prochaines séances d'un adhérent
-- ============================================================
-- Fichier 100 % LECTURE SEULE (aucune écriture, aucun DDL).
-- À exécuter dans le SQL Editor Supabase pour vérifier le modèle
-- de données réel avant/après le déploiement de la fiche adhérent.
--
-- Schéma réel constaté (source de vérité) :
--   . members.current_group_id          -> groups.id
--     repli : group_members (end_date IS NULL)
--   . groups.schedule                   -> jsonb { "mardi": "18:30", ... }
--   . groups.start_date / end_date      -> bornes de la saison
--   . groups.extra_sessions             -> jsonb [{date,time}] (migration 016)
--   . groups.pause_start_date / pause_end_date        (migration 016)
--   . sessions.group_id, session_date, start_time,
--     end_time, status                  -> status='cancelled' = annulée
--
-- ⚠️ Les colonnes extra_sessions / pause_* peuvent ne pas exister
--    sur la base. Les requêtes concernées utilisent to_jsonb(g)
--    pour rester valides même si la colonne est absente.
--
-- Personnaliser le membre ci-dessous :
--   remplacer 'FL1' par l'identifiant recherché.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Colonnes réellement présentes (groups / sessions)
-- ------------------------------------------------------------
select table_name, column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name in ('groups', 'sessions', 'group_members', 'members')
order by table_name, ordinal_position;

-- Colonnes « optionnelles » de la migration 016 : true = présentes.
select
    exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'groups'
          and column_name = 'extra_sessions'
    ) as has_extra_sessions,
    exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'groups'
          and column_name = 'pause_start_date'
    ) as has_pause_start_date,
    exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'groups'
          and column_name = 'pause_end_date'
    ) as has_pause_end_date,
    exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'sessions'
          and column_name = 'is_cancelled'
    ) as has_sessions_is_cancelled,
    exists (
        select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'sessions'
          and column_name = 'room'
    ) as has_sessions_room;


-- ------------------------------------------------------------
-- 2. RPC de planification (attendue : absente -> génération client)
-- ------------------------------------------------------------
select
    p.proname as function_name,
    pg_get_function_identity_arguments(p.oid) as arguments
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('group_planned_sessions', 'get_public_member');


-- ------------------------------------------------------------
-- 3. Résolution membre -> groupe(x)
-- ------------------------------------------------------------
with params as (
    select 'FL1'::text as member_id
)
select
    m.id                                   as member_id,
    m.first_name,
    m.last_name,
    m.current_group_id,
    coalesce(
        m.current_group_id,
        (
            select gm.group_id
            from public.group_members gm
            where gm.member_id = m.id
              and gm.end_date is null
            order by gm.start_date desc nulls last
            limit 1
        )
    )                                      as resolved_group_id,
    (
        select count(*)
        from public.group_members gm
        where gm.member_id = m.id
          and gm.end_date is null
    )                                      as active_group_memberships
from public.members m
join params p on p.member_id = m.id;


-- ------------------------------------------------------------
-- 4. Planning brut du/des groupe(s) de l'adhérent
-- ------------------------------------------------------------
with params as (
    select 'FL1'::text as member_id
),
member_group as (
    select coalesce(
        m.current_group_id,
        (
            select gm.group_id
            from public.group_members gm
            where gm.member_id = m.id
              and gm.end_date is null
            order by gm.start_date desc nulls last
            limit 1
        )
    ) as group_id
    from public.members m
    join params p on p.member_id = m.id
)
select
    g.id,
    g.name,
    g.is_active,
    g.start_date,
    g.end_date,
    g.schedule,
    -- Lecture sûre des colonnes optionnelles (null si absentes)
    to_jsonb(g) -> 'extra_sessions'   as extra_sessions,
    to_jsonb(g) ->> 'pause_start_date' as pause_start_date,
    to_jsonb(g) ->> 'pause_end_date'   as pause_end_date
from public.groups g
join member_group mg on mg.group_id = g.id;


-- ------------------------------------------------------------
-- 5. Séances annulées (sessions.status = 'cancelled')
--    -> ce sont elles qui retirent une occurrence du planning.
-- ------------------------------------------------------------
with params as (
    select 'FL1'::text as member_id
),
member_group as (
    select coalesce(
        m.current_group_id,
        (
            select gm.group_id
            from public.group_members gm
            where gm.member_id = m.id
              and gm.end_date is null
            order by gm.start_date desc nulls last
            limit 1
        )
    ) as group_id
    from public.members m
    join params p on p.member_id = m.id
)
select
    s.session_date,
    s.start_time,
    s.end_time,
    s.status,
    s.group_id
from public.sessions s
join member_group mg on mg.group_id = s.group_id
where s.session_date >= (now() at time zone 'Africa/Algiers')::date
  and s.status = 'cancelled'
order by s.session_date, s.start_time;


-- ------------------------------------------------------------
-- 6. APERÇU des prochaines occurrences (mêmes règles que le client)
--    - planning hebdomadaire (groups.schedule)
--    - + séances supplémentaires (groups.extra_sessions) si présentes
--    - − pauses du groupe (si présentes)
--    - − annulations (sessions.status='cancelled')
--    - bornes start_date / end_date
--    - heure locale Africa/Algiers, séances déjà passées exclues
--    Limité aux 20 premières.
-- ------------------------------------------------------------
with params as (
    select
        'FL1'::text                                        as member_id,
        (now() at time zone 'Africa/Algiers')::date        as today,
        (now() at time zone 'Africa/Algiers')::time        as local_time,
        180                                                as horizon_days
),
member_group as (
    select coalesce(
        m.current_group_id,
        (
            select gm.group_id
            from public.group_members gm
            where gm.member_id = m.id
              and gm.end_date is null
            order by gm.start_date desc nulls last
            limit 1
        )
    ) as group_id
    from public.members m
    join params p on p.member_id = m.id
),
g as (
    select gr.*
    from public.groups gr
    join member_group mg on mg.group_id = gr.id
),
days as (
    select d::date as day
    from params p
    cross join g
    cross join lateral generate_series(
        greatest(p.today, coalesce(g.start_date, p.today)),
        least(
            p.today + p.horizon_days,
            coalesce(g.end_date, p.today + p.horizon_days)
        ),
        interval '1 day'
    ) as d
),
-- Planning hebdomadaire : associe le jour ISO au nom français.
recurring as (
    select
        d.day,
        (kv.value)::time as start_time,
        'recurring'::text as source
    from days d
    cross join g
    cross join lateral jsonb_each_text(coalesce(g.schedule, '{}'::jsonb)) kv
    where kv.key = case extract(isodow from d.day)
        when 1 then 'lundi'
        when 2 then 'mardi'
        when 3 then 'mercredi'
        when 4 then 'jeudi'
        when 5 then 'vendredi'
        when 6 then 'samedi'
        when 7 then 'dimanche'
    end
    -- Pauses éventuelles (migration 016)
    and not (
        (to_jsonb(g) ->> 'pause_start_date') is not null
        and (to_jsonb(g) ->> 'pause_end_date') is not null
        and d.day between
            (to_jsonb(g) ->> 'pause_start_date')::date
            and (to_jsonb(g) ->> 'pause_end_date')::date
    )
),
-- Séances supplémentaires (migration 016), tolérant l'absence de colonne.
extras as (
    select
        (elem ->> 'date')::date                    as day,
        coalesce(
            nullif(elem ->> 'time', ''),
            nullif(elem ->> 'start_time', ''),
            nullif(elem ->> 'start', '')
        )::time                                    as start_time,
        'extra'::text                              as source
    from g
    cross join lateral jsonb_array_elements(
        coalesce(to_jsonb(g) -> 'extra_sessions', '[]'::jsonb)
    ) as elem
    where (elem ->> 'date') is not null
),
occurrences as (
    select * from recurring
    union all
    select * from extras
)
select
    o.day                                  as session_date,
    to_char(o.day, 'TMDay')                as day_of_week_en,
    o.start_time,
    o.source,
    case
        when o.day = p.today then 'Aujourd''hui'
        when o.day = p.today + 1 then 'Demain'
        else 'Dans ' || (o.day - p.today) || ' jours'
    end                                    as relative_label
from occurrences o
cross join params p
where o.start_time is not null
  -- Borne basse/haute de la saison
  and o.day between
        greatest(p.today, coalesce((select start_date from g), p.today))
        and least(
            p.today + p.horizon_days,
            coalesce((select end_date from g), p.today + p.horizon_days)
        )
  -- Exclut les annulations (même date + heure, sinon toute la journée)
  and not exists (
        select 1
        from public.sessions s
        where s.group_id = (select id from g)
          and s.session_date = o.day
          and s.status = 'cancelled'
          and (s.start_time is null or s.start_time::time = o.start_time)
  )
  -- Exclut les séances déjà passées aujourd'hui
  and (o.day > p.today or o.start_time > p.local_time)
order by o.day, o.start_time
limit 20;


-- ------------------------------------------------------------
-- 7. Contrôle de cohérence : nombre d'occurrences par source
--    sur l'horizon (récurrent vs supplémentaire).
-- ------------------------------------------------------------
with params as (
    select
        'FL1'::text                                 as member_id,
        (now() at time zone 'Africa/Algiers')::date as today,
        (now() at time zone 'Africa/Algiers')::time as local_time,
        180                                         as horizon_days
),
member_group as (
    select coalesce(
        m.current_group_id,
        (
            select gm.group_id
            from public.group_members gm
            where gm.member_id = m.id
              and gm.end_date is null
            order by gm.start_date desc nulls last
            limit 1
        )
    ) as group_id
    from public.members m
    join params p on p.member_id = m.id
),
g as (
    select gr.*
    from public.groups gr
    join member_group mg on mg.group_id = gr.id
),
days as (
    select d::date as day
    from params p
    cross join g
    cross join lateral generate_series(
        greatest(p.today, coalesce(g.start_date, p.today)),
        least(
            p.today + p.horizon_days,
            coalesce(g.end_date, p.today + p.horizon_days)
        ),
        interval '1 day'
    ) as d
),
recurring as (
    select d.day, (kv.value)::time as start_time, 'recurring'::text as source
    from days d
    cross join g
    cross join lateral jsonb_each_text(coalesce(g.schedule, '{}'::jsonb)) kv
    where kv.key = case extract(isodow from d.day)
        when 1 then 'lundi'
        when 2 then 'mardi'
        when 3 then 'mercredi'
        when 4 then 'jeudi'
        when 5 then 'vendredi'
        when 6 then 'samedi'
        when 7 then 'dimanche'
    end
    and not (
        (to_jsonb(g) ->> 'pause_start_date') is not null
        and (to_jsonb(g) ->> 'pause_end_date') is not null
        and d.day between
            (to_jsonb(g) ->> 'pause_start_date')::date
            and (to_jsonb(g) ->> 'pause_end_date')::date
    )
),
extras as (
    select
        (elem ->> 'date')::date as day,
        coalesce(
            nullif(elem ->> 'time', ''),
            nullif(elem ->> 'start_time', ''),
            nullif(elem ->> 'start', '')
        )::time as start_time,
        'extra'::text as source
    from g
    cross join lateral jsonb_array_elements(
        coalesce(to_jsonb(g) -> 'extra_sessions', '[]'::jsonb)
    ) as elem
    where (elem ->> 'date') is not null
),
occurrences as (
    select * from recurring
    union all
    select * from extras
)
select o.source, count(*) as occurrences
from occurrences o
cross join params p
where o.start_time is not null
  and o.day between
        greatest(p.today, coalesce((select start_date from g), p.today))
        and least(
            p.today + p.horizon_days,
            coalesce((select end_date from g), p.today + p.horizon_days)
        )
  and not exists (
        select 1
        from public.sessions s
        where s.group_id = (select id from g)
          and s.session_date = o.day
          and s.status = 'cancelled'
          and (s.start_time is null or s.start_time::time = o.start_time)
  )
  and (o.day > p.today or o.start_time > p.local_time)
group by o.source
order by o.source;


-- ------------------------------------------------------------
-- 8. Vérification côté client (console F12, page member-info.html)
-- ------------------------------------------------------------
-- Ouvrir : member-info.html?id=FL1
-- Puis dans la console :
--   await getUpcomingSessions('FL1', 5)
--   await getUpcomingSessionsData('FL1', 5)
--   UpcomingSessions.getState().lastData.reason
--
-- Attendu :
--   . reason === null                -> adhérent + groupe trouvés
--   . reason === 'no_group'          -> aucun groupe actif
--   . reason === 'member_not_found'  -> identifiant inconnu
--   . tableau trié par date puis heure, sans séance annulée
-- ============================================================
