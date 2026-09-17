-- ============================================================
-- 016 — Planification centralisée des séances
--
-- Règles métier appliquées PARTOUT (génération, présences,
-- rapports, fiche QR) :
--   1. Toute séance respecte la saison (rentrée SEPTEMBRE) :
--      le calcul démarre au 1er septembre de la saison du groupe.
--   2. Une séance « planifiée » = planning hebdomadaire (jours +
--      heures) + séances en plus (extra) − pauses du groupe −
--      séances annulées (sessions.status='cancelled').
--   3. Les données existantes (sessions, présences, paiements)
--      ne sont JAMAIS supprimées : la génération se contente de
--      créer les lignes `sessions` manquantes.
--   4. La présence d'un adhérent démarre à sa date de
--      RÉINSCRIPTION (registrations.start_date active, sinon
--      members.start_date) : pas d'absence avant cette date.
--
-- Ajouts (additifs / réexécutables) :
--   . colonnes groups.pause_start_date / pause_end_date /
--     extra_sessions (jsonb [{date,time},…])
--   . RPC  public.group_planned_sessions(group_id, from, to)
--          -> TABLE (session_date date, start_time text, source text)
--   . RPC  public.generate_group_sessions(group_id) -> int
--   . Helper public.season_start_date(date) -> 1er septembre
--   . Réécriture de public.get_public_member (fiche QR) utilisant
--     la même source de vérité + `week_sessions`.
--
-- À exécuter dans le SQL Editor Supabase.
-- ============================================================

-- ---------- 1. Colonnes du groupe ----------
alter table public.groups
    add column if not exists pause_start_date date;

alter table public.groups
    add column if not exists pause_end_date date;

alter table public.groups
    add column if not exists extra_sessions jsonb default '[]'::jsonb;

-- ---------- 2. Helper saison : 1er septembre de la saison d'une date ----------
create or replace function public.season_start_date(p_date date)
returns date
language sql
immutable
as $$
    select make_date(
        case when extract(month from p_date) >= 9
             then extract(year from p_date)::int
             else extract(year from p_date)::int - 1 end,
        9, 1);
$$;

grant execute on function public.season_start_date(date) to anon, authenticated;

-- ---------- 3. RPC : séances planifiées d'un groupe sur une période ----------
-- Source de vérité unique pour : génération, présences/absences,
-- rapports et fiche QR. N'inclut QUE les séances qui DEVRAIENT se
-- tenir : planning + extras − pauses − annulées, dans la saison.
create or replace function public.group_planned_sessions(
    p_group_id uuid,
    p_from     date,
    p_to       date
)
returns table (session_date date, start_time text, source text)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_grp          public.groups%rowtype;
    v_start        date;
    v_end          date;
    v_day_keys     text[] := array['lundi','mardi','mercredi','jeudi','vendredi','samedi','dimanche'];
begin
    if p_group_id is null or p_from is null or p_to is null then
        return;
    end if;

    select * into v_grp from public.groups where id = p_group_id;
    if not found then
        return;
    end if;

    -- La borne basse est le début du groupe (qui doit être un début de
    -- saison, septembre) : aucune séance avant. Si aucune date de début
    -- n'est définie, on prend la rentrée (septembre) de la saison en
    -- cours. La borne haute est la fin du groupe si définie.
    v_start := greatest(p_from, coalesce(v_grp.start_date, public.season_start_date(current_date)));
    v_end   := least(p_to, coalesce(v_grp.end_date, p_to));
    if v_start > v_end then
        return;
    end if;

    return query
    with planned as (
        -- répétition hebdomadaire du planning (jours + heures)
        select
            d::date as session_date,
            v_grp.schedule ->> v_day_keys[extract(isodow from d)::int] as start_time,
            'schedule'::text as source
        from generate_series(v_start, v_end, interval '1 day') as d
        where v_grp.schedule ->> v_day_keys[extract(isodow from d)::int] is not null

        union all

        -- séances en plus explicitement ajoutées
        select
            (x->>'date')::date as session_date,
            x->>'time'         as start_time,
            'extra'::text      as source
        from jsonb_array_elements(coalesce(v_grp.extra_sessions, '[]'::jsonb)) as x
        where x ? 'date'
          and x->>'date' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
          and (x->>'date')::date between v_start and v_end
    )
    select distinct on (p.session_date)
        p.session_date,
        p.start_time,
        p.source
    from planned p
    where not (
        -- pause du groupe (les deux bornes renseignées)
        v_grp.pause_start_date is not null
        and v_grp.pause_end_date is not null
        and p.session_date between v_grp.pause_start_date and v_grp.pause_end_date
    )
      and not exists (
        -- séance annulée : on ne la compte plus comme planifiée
        select 1
        from public.sessions s
        where s.group_id = p_group_id
          and s.session_date = p.session_date
          and s.status = 'cancelled'
    )
    order by
        p.session_date,
        case when p.source = 'schedule' then 0 else 1 end,
        p.start_time;
end;
$$;

grant execute on function public.group_planned_sessions(uuid, date, date) to anon, authenticated;

comment on function public.group_planned_sessions(uuid, date, date) is
    'Source unique des séances planifiées d''un groupe : planning + extras - pauses - annulées, dans la saison (septembre).';

-- ---------- 4. RPC : génération des séances manquantes ----------
-- Crée les lignes `sessions` (waiting) pour toutes les dates
-- planifiées du groupe qui n'existent pas encore. Aucune donnée
-- existante n'est modifiée/supprimée. Retourne le nombre créé.
-- L'intervalle couvre du début du groupe jusqu'à la fin de la
-- SAISON EN COURS (31 août) si aucune date de fin n'est définie :
-- le passage de septembre crée donc naturellement la nouvelle saison.
create or replace function public.generate_group_sessions(p_group_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
    v_grp     public.groups%rowtype;
    v_from    date;
    v_to      date;
    v_created int;
begin
    if p_group_id is null then
        return 0;
    end if;

    select * into v_grp from public.groups where id = p_group_id;
    if not found then
        return 0;
    end if;

    v_from := coalesce(v_grp.start_date, public.season_start_date(current_date));
    v_to   := coalesce(
        v_grp.end_date,
        (public.season_start_date(greatest(current_date, v_from)) + interval '1 year - 1 day')::date
    );
    if v_from > v_to then
        return 0;
    end if;

    insert into public.sessions (club_id, group_id, session_date, start_time, status, group_type)
    select v_grp.club_id, v_grp.id, p.session_date, p.start_time, 'waiting', v_grp.name
    from public.group_planned_sessions(p_group_id, v_from, v_to) p
    where not exists (
        select 1 from public.sessions s
        where s.group_id = p_group_id and s.session_date = p.session_date
    )
    order by p.session_date;

    get diagnostics v_created = row_count;
    return v_created;
end;
$$;

grant execute on function public.generate_group_sessions(uuid) to anon, authenticated;

comment on function public.generate_group_sessions(uuid) is
    'Crée les séances manquantes d''un groupe selon le planning centralisé (saison septembre).';

-- ---------- 5. Fiche publique QR : source de vérité unifiée ----------
-- . Présences du mois courant  : table attendance (même source que
--   NFC et scan manuel) — cohérence rétablie avec les absences.
-- . Objectif du mois           : séances planifiées du groupe sur le
--   mois, à partir de la date de RÉINSCRIPTION.
-- . Absences des 6 derniers mois : planifiées post-réinscription −
--   présences enregistrées (plancher 0).
-- . week_sessions               : séances planifiées de la semaine
--   courante (lundi→dimanche) pour l'affichage QR.
create or replace function public.get_public_member(p_token uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_card        record;
    v_member      record;
    v_group_id    uuid;
    v_group_name  text;
    v_rein        date;
    v_sub         record;
    v_month       text := to_char(current_date, 'YYYY-MM');
    v_month_start date;
    v_month_end   date;
    v_monday      date;
    v_present     int := 0;
    v_target      int := 0;
    v_absences    jsonb;
    v_week        jsonb;
    v_next        record;
begin
    if p_token is null then
        return null;
    end if;

    select mc.*, m.first_name, m.last_name, m.dob, m.photo_url,
           m.current_group_id
      into v_card
      from public.member_cards mc
      join public.members m on m.id = mc.member_id
     where mc.public_token = p_token
     limit 1;

    if not found then
        return null;
    end if;

    select * into v_member from public.members where id = v_card.member_id;

    -- Groupe courant (repli : affectation active si absent du membre)
    v_group_id := v_member.current_group_id;
    if v_group_id is null then
        select gm.group_id into v_group_id
          from public.group_members gm
         where gm.member_id = v_member.id and gm.end_date is null
         order by gm.start_date desc
         limit 1;
    end if;

    if v_group_id is not null then
        select g.name into v_group_name
          from public.groups g
         where g.id = v_group_id;
    end if;

    -- Statut d'abonnement (vue/règle centralisée)
    select s.is_active, s.end_effective
      into v_sub
      from public.member_subscription_status s
     where s.member_id = v_member.id;

    -- Date de réinscription : inscription active la plus récente,
    -- sinon date de début legacy. Aucune présence/absence avant.
    select coalesce(
        (select r.start_date
           from public.registrations r
          where r.member_id = v_member.id and r.is_active
          order by r.start_date desc
          limit 1),
        v_member.start_date
    ) into v_rein;

    -- Bornes du mois courant
    v_month_start := date_trunc('month', current_date)::date;
    v_month_end   := (date_trunc('month', current_date) + interval '1 month - 1 day')::date;

    -- Présences du mois courant (table historique, source NFC/scanner),
    -- uniquement à partir de la réinscription.
    select count(*)::int
      into v_present
      from public.attendance a
     where a.member_id = v_member.id
       and a.month = v_month
       and (v_rein is null or a.attendance_date is null or a.attendance_date >= v_rein);

    -- Objectif du mois : planifiées du groupe entre la réinscription
    -- et la fin du mois (borné au mois courant).
    if v_group_id is not null then
        select count(*)::int
          into v_target
          from public.group_planned_sessions(
              v_group_id,
              greatest(v_month_start, v_rein),
              v_month_end
          );
    end if;

    -- Absences des 6 derniers mois (mois révolus) : planifiées
    -- post-réinscription − présences enregistrées, plancher 0.
    select coalesce(jsonb_object_agg(t.month, t.abs), '{}'::jsonb)
      into v_absences
      from (
        select to_char(md, 'YYYY-MM') as month,
               greatest(
                   (select count(*)::int
                      from public.group_planned_sessions(
                          v_group_id,
                          greatest(md, v_rein),
                          (md + interval '1 month - 1 day')::date
                      )) -
                   (select count(*)::int
                      from public.attendance a
                     where a.member_id = v_member.id
                       and a.month = to_char(md, 'YYYY-MM')
                       and (v_rein is null or a.attendance_date is null or a.attendance_date >= v_rein)),
                   0
               )::int as abs
          from generate_series(
              (date_trunc('month', current_date) - interval '6 months')::date,
              (date_trunc('month', current_date) - interval '1 day')::date,
              interval '1 month'
          ) as md
      ) t;

    -- Séances planifiées de la semaine courante (lundi → dimanche)
    v_monday := current_date - (extract(isodow from current_date)::int - 1);
    v_week   := '[]'::jsonb;
    if v_group_id is not null then
        select coalesce(
            jsonb_agg(jsonb_build_object(
                'date',  s.session_date::text,
                'time',  s.start_time,
                'extra', s.source = 'extra'
            ) order by s.session_date, s.start_time),
            '[]'::jsonb
        )
          into v_week
          from public.group_planned_sessions(v_group_id, v_monday, v_monday + 6) s;
    end if;

    -- Prochaine séance : première planifiée non passée (pauses et
    -- annulations déjà exclues par la fonction centrale).
    if v_group_id is not null then
        select s.session_date::text, s.start_time::text
          into v_next
          from public.group_planned_sessions(
              v_group_id,
              current_date,
              current_date + interval '180 days'
          ) s
         order by s.session_date, s.start_time
         limit 1;
    end if;

    return jsonb_build_object(
        'full_name',         v_member.first_name || ' ' || v_member.last_name,
        'dob',               v_member.dob,
        'photo_url',         v_member.photo_url,
        'group_name',        v_group_name,
        'group_id',          v_group_id,
        'sub_status',        case when coalesce(v_sub.is_active, false) then 'ACTIF' else 'EXPIRE' end,
        'sub_end',           v_sub.end_effective,
        'rein_date',         v_rein,
        'next_session_date', v_next.session_date,
        'next_session_time', v_next.start_time,
        'month_present',     v_present,
        'month_target',      v_target,
        'absences',          v_absences,
        'week_sessions',     v_week
    );
end;
$$;

grant execute on function public.get_public_member(uuid) to anon, authenticated;

comment on function public.get_public_member(uuid) is
    'Fiche publique adhérent (QR) : présences/absences depuis la réinscription, séances de la semaine, aucune donnée sensible.';

-- ---------- 6. Contrôles ----------
select
    column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name   = 'groups'
  and column_name in ('pause_start_date','pause_end_date','extra_sessions')
order by ordinal_position;
