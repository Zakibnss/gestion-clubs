-- ============================================================
-- 015 — Renouvellement : mois payés depuis la rentrée (septembre)
--
-- Préréquis : migration 012 (table registrations, RPC
-- renew_member_registration, season_key_for_date, vue
-- member_subscription_status) et table subscription_payments
-- (unique member_id + period_month) déjà présentes.
--
-- Nouvelle règle : la saison sportive commence en SEPTEMBRE.
-- Lors d'un renouvellement d'inscription :
--   1. La saison cible = saison de la DATE de renouvellement
--      (fonction season_key_for_date déjà en place : janv.→août =
--      saison année-1/année, sept.→déc. = saison année/année+1).
--   2. start_date = date EXACTE du renouvellement (14/11/2026).
--   3. Tous les mois de SEPTEMBRE jusqu'au MOIS du renouvellement
--      INCLUS sont créés PAYÉ dans subscription_payments.
--      => la fin d'abonnement reste calculée par la logique existante
--         (vue registration_status / member_subscription_status :
--         start_date + durée selon le type d'abonnement).
--   4. Les mois postérieurs au renouvellement restent impayés
--      (aucune ligne PAYE créée après le mois du renouvellement).
--   5. Anti-doublon conservé : unique (member_id, season_key) +
--      vérification RPC -> jamais de seconde inscription.
--   6. Nan jamais modifiés : anciennes saisons, anciens paiements
--      (period_month hors plage), présences, NFC.
--
-- Additif : remplace la RPC renew_member_registration (même signature,
-- grants inchangés). Réexécutable.
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
    v_member       public.members%rowtype;
    v_dup          public.registrations;
    v_type         text := lower(trim(p_subscription_type));
    v_season       text;      -- saison cible = saison de la date du renouvellement
    v_season_year  int;       -- année de début de la saison (année du septembre)
    v_start        date := p_start_date;
    v_reg          public.registrations;
begin
    -- L'adhérent doit exister
    select * into v_member from public.members where id = p_member_id;
    if not found then
        raise exception 'Adhérent introuvable' using errcode = 'P0001';
    end if;

    -- Type d'abonnement valide
    if v_type not in ('monthly','quarterly','biannual','annual') then
        raise exception 'Type d''abonnement invalide : %', p_subscription_type using errcode = 'P0001';
    end if;

    -- SAISON CIBLE : dérivée de la date de renouvellement (la rentrée est
    -- en septembre). Le paramètre p_season_key est conservé pour la
    -- compatibilité, mais la saison fait toujours foi.
    v_season := public.season_key_for_date(v_start);
    if v_season !~ '^[0-9]{4}/[0-9]{4}$' then
        raise exception 'Saison invalide : %', v_season using errcode = 'P0001';
    end if;

    -- Double renouvellement interdit (contrôle applicatif + contrainte unique)
    select * into v_dup from public.registrations
     where member_id = p_member_id and season_key = v_season;
    if found then
        raise exception 'Cet adhérent est déjà inscrit pour la saison %', v_season
            using errcode = 'P0001';
    end if;

    -- Désactive l'ancienne inscription active (historique conservé)
    update public.registrations
       set is_active = false,
           end_date  = coalesce(end_date, v_start - 1)
     where member_id = p_member_id and is_active;

    -- Crée la nouvelle inscription (start_date = date exacte du renouvellement)
    insert into public.registrations
        (member_id, club_id, season_key, subscription_type, start_date, months_from, is_active, notes)
    values
        (p_member_id, v_member.club_id, v_season, v_type, v_start, v_start, true, p_notes)
    returning * into v_reg;

    -- Continuité de l'affichage legacy (members.start_date / subscription)
    update public.members
       set start_date  = v_start,
           subscription = v_type
     where id = p_member_id;

    -- Mois payés automatiquement : du 1er septembre de la saison jusqu'au
    -- mois du renouvellement INCLUS. Upsert (member_id, period_month) :
    -- aucun doublon, aucune ligne hors de la plage [septembre, renouvellement].
    v_season_year := left(v_season, 4)::int;
    insert into public.subscription_payments
        (member_id, club_id, period_month, status, paid_on, previous_status, changed_by)
    select
        p_member_id,
        v_member.club_id,
        to_char(g, 'YYYY-MM'),   -- période '2026-11'
        'PAYE',
        v_start,                 -- payé le jour du renouvellement
        'NON PAYE',
        'renewal'
    from generate_series(
        make_date(v_season_year, 9, 1)::timestamp,
        v_start::timestamp,
        interval '1 month'
    ) as g
    on conflict (member_id, period_month)
    do update set
        status          = 'PAYE',
        paid_on         = excluded.paid_on,
        previous_status = public.subscription_payments.status,
        changed_by      = 'renewal';

    return v_reg;
end;
$$;

grant execute on function public.renew_member_registration(text, text, text, date, text)
    to anon, authenticated;

comment on function public.renew_member_registration(text, text, text, date, text) is
    'V2 - Renouvellement d''inscription : saison de la date, mois PAYÉ de septembre au renouvellement inclus.';