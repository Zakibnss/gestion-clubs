-- ============================================================
-- MIGRATION 010 — V2 : accès REST pour toute l'application
--
-- L'app utilise la clé `anon` + son propre login (table clubs),
-- comme pour toutes les tables legacy. Si les tables V2 ont été
-- créées avec RLS activé (défaut du dashboard) sans policy,
-- l'API renvoie 401/403 sur les requêtes de l'application.
--
-- Option A (ci-dessous) : désactiver RLS = comportement identique
-- aux tables existantes de l'app.
-- ============================================================

-- Tables V2
alter table if exists public.groups               disable row level security;
alter table if exists public.group_members        disable row level security;
alter table if exists public.sessions             disable row level security;
alter table if exists public.session_attendances  disable row level security;
alter table if exists public.subscription_payments disable row level security;
alter table if exists public.events               disable row level security;
alter table if exists public.event_participants   disable row level security;
alter table if exists public.member_cards         disable row level security;

-- S'assurer que les rôles API ont les droits
grant all privileges on public.groups, public.group_members,
    public.sessions, public.session_attendances,
    public.subscription_payments, public.events, public.event_participants,
    public.member_cards
    to anon, authenticated;

-- Vues utilisées par l'app
grant select on public.member_subscription_status to anon, authenticated;
-- upcoming_sessions peut être une vue ou une table :
do $$
begin
    if exists (select 1 from information_schema.views
               where table_schema='public' and table_name='upcoming_sessions') then
        execute 'grant select on public.upcoming_sessions to anon, authenticated';
    end if;
end $$;

-- RPC fiche publique
grant execute on function public.get_public_member(uuid) to anon, authenticated;
