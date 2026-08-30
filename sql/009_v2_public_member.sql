-- ============================================================
-- MIGRATION 009 — V2 : fonction publique fiche adhérent (QR)
-- À exécuter dans le SQL Editor Supabase.
--
-- La page public-member.html?t=<token> appelle :
--   supabase.rpc('get_public_member', { p_token: <uuid> })
--
-- Sécurité : SECURITY DEFINER + champs strictement filtrés.
-- Aucune donnée sensible (téléphone, email, adresse, finances).
-- ============================================================

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
    v_planned     int;
    v_sub         record;
    v_next        record;
    v_month       text := to_char(current_date, 'YYYY-MM');
    v_present     int;
    v_target      int;
    v_absences    jsonb;
begin
    if p_token is null then
        return null;
    end if;

    -- Carte + adhérent liés au token public
    select mc.*, m.first_name, m.last_name, m.dob, m.photo_url,
           m.current_group_id
      into v_card
      from member_cards mc
      join members m on m.id = mc.member_id
     where mc.public_token = p_token
     limit 1;

    if not found then
        return null;
    end if;

    select * into v_member from members where id = v_card.member_id;

    -- Groupe courant
    v_group_id   := v_member.current_group_id;
    v_group_name := null;
    v_planned    := null;
    if v_group_id is not null then
        select g.name, g.planned_sessions_count
          into v_group_name, v_planned
          from groups g
         where g.id = v_group_id;
    end if;

    -- Statut d'abonnement (vue/règle centralisée)
    select s.is_active, s.end_effective
      into v_sub
      from member_subscription_status s
     where s.member_id = v_card.member_id;

    -- Prochaine séance du groupe
    select min(s.session_date)::text as session_date,
           min(s.start_time)::text   as start_time
      into v_next
      from sessions s
     where v_group_id is not null
       and s.group_id = v_group_id
       and s.session_date >= current_date
       and s.status not in ('completed', 'cancelled');

    -- Présences du mois en cours (table historique)
    select count(*)::int
      into v_present
      from attendance a
     where a.member_id = v_card.member_id
       and a.month = v_month;

    -- Objectif du mois : nb de séances planifiées du groupe ce mois-ci
    if v_group_id is not null then
        select count(*)::int
          into v_target
          from sessions s
         where s.group_id = v_group_id
           and to_char(s.session_date, 'YYYY-MM') = v_month
           and s.status <> 'cancelled';
    end if;
    v_target := coalesce(nullif(v_target, 0), v_planned);

    -- Absences des 6 derniers mois :
    -- séances terminées du groupe − présences enregistrées (plancher 0)
    select coalesce(jsonb_object_agg(t.month, t.abs), '{}'::jsonb)
      into v_absences
      from (
        select to_char(s.session_date, 'YYYY-MM') as month,
               greatest(
                   count(distinct s.id) - count(distinct sa.id),
                   0
               )::int as abs
          from sessions s
          left join session_attendances sa
                 on sa.session_id = s.id
                and sa.member_id  = v_card.member_id
                and sa.status     = 'PRESENT'
         where v_group_id is not null
           and s.group_id = v_group_id
           and s.status   = 'completed'
           and s.session_date < date_trunc('month', current_date)
           and s.session_date >= date_trunc('month', current_date) - interval '6 months'
         group by 1
      ) t;

    return jsonb_build_object(
        'full_name',        v_member.first_name || ' ' || v_member.last_name,
        'dob',              v_member.dob,
        'photo_url',        v_member.photo_url,
        'group_name',       v_group_name,
        'sub_status',       case when coalesce(v_sub.is_active, false) then 'ACTIF' else 'EXPIRE' end,
        'sub_end',          v_sub.end_effective,
        'next_session_date', v_next.session_date,
        'next_session_time', v_next.start_time,
        'month_present',    v_present,
        'month_target',     v_target,
        'absences',         v_absences
    );
end;
$$;

-- Accès anonyme autorisé uniquement via cette fonction
grant execute on function public.get_public_member(uuid) to anon, authenticated;

comment on function public.get_public_member(uuid) is
    'V2 - Fiche publique adhérent (QR). Champs filtrés, aucune donnée sensible.';
