-- ============================================================
-- 013 — Correction : sessions.group_id manquant
--
-- Problème : l'application et plusieurs fonctions/vues s'appuient
-- sur sessions.group_id (séances liées à un groupe :
--   . js/groups.js        : comptage des séances par groupe,
--                           filtrage viewGroupSessions, génération
--   . js/reports.js       : rapport groupe + matrice de présence
--   . sql/009 RPC get_public_member : prochaine séance, absences
-- )
-- mais la colonne est absente de la table « sessions » créée via le
-- dashboard Supabase -> erreur :  column sessions.group_id does not exist
--
-- Correctif : ajouter la colonne (CHAMP NON DESTRUCTIF, réexécutable)
--   + clé étrangère vers groups + index (lectures par groupe).
-- Aucune donnée existante n'est modifiée ; group_id reste NULL pour
-- les séances déjà créées sans groupe (à rattacher via le groupe).
-- ============================================================

alter table public.sessions
    add column if not exists group_id uuid;

-- ============================================================
-- Colonnes horodatage de séance (utilisées par js/groups.js
-- setSessionStatus) : manquantes dans le schéma du dashboard.
--   session_started_at : horodatage de début / reprise
--   session_paused_at  : horodatage de pause
--   session_ended_at   : horodatage de fin
-- ============================================================
alter table public.sessions
    add column if not exists session_started_at timestamptz;

alter table public.sessions
    add column if not exists session_paused_at  timestamptz;

alter table public.sessions
    add column if not exists session_ended_at   timestamptz;

-- Clé étrangère optionnelle vers le groupe (suppression d'un groupe ->
-- ses séances suivent sa cascade si la FK de groupe existait déjà).
do $$
declare
    v_has_fk boolean;
begin
    select exists (
        select 1
        from pg_constraint con
        join pg_class rel on rel.oid = con.conrelid
        join pg_namespace nsp on nsp.oid = rel.relnamespace
        where con.conname = 'sessions_group_id_fkey'
          and rel.relname  = 'sessions'
          and nsp.nspname  = 'public'
    ) into v_has_fk;

    if not v_has_fk then
        alter table public.sessions
            add constraint sessions_group_id_fkey
            foreign key (group_id) references public.groups (id)
            on delete cascade;
    end if;
end;
$$;

-- Index pour les lectures fréquentes par groupe (reports / views / RPC)
create index if not exists idx_sessions_group_id
    on public.sessions (group_id);

-- Index composé fréquemment utilisé : club + date + statut
create index if not exists idx_sessions_club_date_status
    on public.sessions (club_id, session_date, status);

-- Vérifications immédiates (à relancer depuis l'éditeur si besoin)
select
    column_name,
    data_type
from information_schema.columns
where table_schema = 'public'
  and table_name   = 'sessions'
order by ordinal_position;