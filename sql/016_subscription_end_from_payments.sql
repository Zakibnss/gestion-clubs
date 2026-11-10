-- ============================================================
-- 016 — « Fin effective » calculée depuis les mois payés
--
-- Problème : la vue member_subscription_status ne lisait que
-- start_date + durée (ou la fin de l'inscription active). Cocher
-- un mois dans « Gérer les mois » écrivait bien dans
-- subscription_payments, mais la fin effective ne changeait
-- jamais.
--
-- Nouvelle règle :
--   • La période initiale (start_date + durée du type) reste
--     considérée payée si aucun paiement n'est enregistré
--     (compatibilité ancien système).
--   • Un mois explicitement « NON PAYE » coupe cette période.
--   • Le dernier mois payé fixe la fin : même jour du mois que
--     start_date, le mois suivant, ramené au dernier jour du
--     mois si besoin.
--     Ex.: début 15/09, septembre payé  → fin 15/10
--          octobre payé en plus          → fin 15/11
--   • is_active / days_left sont désormais calculés sur
--     end_effective (et non plus sur l'ancienne fin théorique).
--
-- Sans aucune ligne de paiement, le comportement précédent est
-- conservé (fin d'inscription active, sinon start_date + durée).
--
-- Réexécutable, non destructif.
-- ============================================================

create or replace view public.member_subscription_status as
with base as (
    select
        m.id                                              as member_id,
        m.club_id,
        m.last_name,
        m.first_name,
        m.start_date,
        date_trunc('month', m.start_date)::date           as start_month,
        (case m.subscription
            when 'monthly'   then 1
            when 'quarterly' then 3
            when 'biannual'  then 6
            when 'annual'    then 12
            else 1 end)                                   as duration_months,
        (m.start_date + interval '1 month' * (case m.subscription
            when 'monthly'   then 1
            when 'quarterly' then 3
            when 'biannual'  then 6
            when 'annual'    then 12
            else 1 end))::date                            as end_legacy,
        (select r.end_date
           from public.registrations r
          where r.member_id = m.id and r.is_active
          order by r.start_date desc
          limit 1)                                        as registration_end,
        (select r.season_key
           from public.registrations r
          where r.member_id = m.id and r.is_active
          order by r.start_date desc
          limit 1)                                        as season_key,
        exists (select 1
                  from public.subscription_payments p
                 where p.member_id = m.id)                as has_payments
    from public.members m
),
paid_agg as (
    select
        b.*,
        -- Dernier mois couvert par la période initiale
        (b.start_month + interval '1 month' * (b.duration_months - 1))::date as legacy_last_month,
        -- Dernier mois explicitement payé (à partir du mois de début)
        (select max(to_date(p.period_month || '-01', 'YYYY-MM-DD'))
           from public.subscription_payments p
          where p.member_id = b.member_id
            and p.status = 'PAYE'
            and p.period_month >= to_char(b.start_month, 'YYYY-MM'))         as last_paid_explicit,
        -- Premier mois explicitement non payé (coupe la période initiale)
        (select min(to_date(p.period_month || '-01', 'YYYY-MM-DD'))
           from public.subscription_payments p
          where p.member_id = b.member_id
            and p.status <> 'PAYE'
            and p.period_month >= to_char(b.start_month, 'YYYY-MM'))         as first_unpaid_explicit
    from base b
),
paid_cut as (
    select
        a.*,
        case
            when a.first_unpaid_explicit is not null
             and a.first_unpaid_explicit <= a.legacy_last_month
            then (a.first_unpaid_explicit - interval '1 month')::date
            else a.legacy_last_month
        end as legacy_last_after_cut
    from paid_agg a
),
paid_combined as (
    select
        c.*,
        greatest(c.legacy_last_after_cut, c.last_paid_explicit) as last_paid_month
    from paid_cut c
),
paid_end as (
    select
        k.*,
        case
            when k.last_paid_month is null then null
            -- Aucun mois payé : l'abonnement s'arrête au jour du début.
            when k.last_paid_month < k.start_month then k.start_date::date
            else least(
                -- jour du début d'abonnement, le mois suivant
                (k.last_paid_month + interval '1 month'
                    + (extract(day from k.start_date)::int - 1) * interval '1 day')::date,
                -- ramené au dernier jour du mois
                (k.last_paid_month + interval '2 months' - interval '1 day')::date
            )
        end as computed_end
    from paid_combined k
),
final_end as (
    select
        e.*,
        coalesce(
            case when e.has_payments then e.computed_end end,
            e.registration_end,
            e.computed_end,
            e.end_legacy
        )::date as end_effective
    from paid_end e
)
select
    member_id,
    club_id,
    last_name,
    first_name,
    end_effective,
    end_legacy,
    end_effective >= current_date                     as is_active,
    greatest(0, (end_effective - current_date))::int  as days_left,
    season_key
from final_end;

grant select on public.member_subscription_status to anon, authenticated;

-- ---------- Contrôles ----------
select member_id, end_legacy, end_effective, is_active, days_left
from public.member_subscription_status
order by end_effective desc nulls last
limit 20;
