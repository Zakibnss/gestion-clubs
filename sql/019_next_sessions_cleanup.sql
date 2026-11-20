-- ============================================================
-- 019 — Nettoyage du générateur de séances (DIAGNOSTIC)
-- ============================================================
-- Objectif : supprimer les données futures générées par l'ancien
-- générateur, SANS toucher aux séances ponctuelles saisies
-- manuellement par le coach.
--
-- ⚠️ CE FICHIER EST LECTURE SEULE.
--    Les instructions DELETE / DROP ci-dessous sont COMMENTÉES :
--    elles ne doivent être exécutées qu'APRÈS validation manuelle
--    des identifiants par le coach.
--
-- Le planning récurrent est désormais calculé à la volée depuis
-- `training_sessions` (js/next-sessions.js). Aucune date future
-- n'est stockée par l'application.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Planning récurrent actif (source de vérité)
-- ------------------------------------------------------------
SELECT id,
       club_id,
       group_id,
       day_of_week,   -- 1 = lundi … 7 = dimanche
       start_time,
       end_time,
       coach,
       is_active
FROM public.training_sessions
WHERE is_active = true
ORDER BY group_id, day_of_week, start_time;


-- ------------------------------------------------------------
-- 2. Toutes les séances FUTURES présentes dans `sessions`
--    (à examiner une par une avant toute suppression)
-- ------------------------------------------------------------
SELECT id,
       group_id,
       session_date,
       start_time,
       end_time,
       status,
       group_type
FROM public.sessions
WHERE session_date >= CURRENT_DATE
ORDER BY session_date, start_time;


-- ------------------------------------------------------------
-- 3a. Candidates « probablement générées » (schéma à group_id)
--     Séances futures dont la date + l'heure correspondent exactement
--     à un créneau récurrent actif du même groupe.
--     Ces lignes sont de forts candidats (à confirmer manuellement) :
--     le coach a pu aussi saisir volontairement la même date.
--
--     NB : certains déploiements rattachent training_sessions par
--     `group_type` (libellé) et non par `group_id`. Voir requête 3b.
-- ------------------------------------------------------------
SELECT s.id,
       s.group_id,
       s.session_date,
       s.start_time,
       s.status,
       s.group_type,
       t.id          AS training_session_id,
       t.day_of_week,
       t.coach
FROM public.sessions s
JOIN public.training_sessions t
  ON t.group_id = s.group_id
 AND t.is_active = true
 AND t.day_of_week = EXTRACT(ISODOW FROM s.session_date)::int
 AND t.start_time::text LIKE (split_part(s.start_time::text, ':', 1) || ':' ||
                              split_part(s.start_time::text, ':', 2)) || '%'
WHERE s.session_date >= CURRENT_DATE
ORDER BY s.session_date, s.start_time;


-- ------------------------------------------------------------
-- 3b. Variante pour un schéma à `group_type` (sans `group_id`)
--     Remplacer 'Adultes' par le nom du groupe à contrôler.
-- ------------------------------------------------------------
SELECT s.id,
       s.group_id,
       s.session_date,
       s.start_time,
       s.status,
       s.group_type,
       t.id          AS training_session_id,
       t.day_of_week,
       t.coach
FROM public.sessions s
JOIN public.groups g
  ON g.id = s.group_id
JOIN public.training_sessions t
  ON lower(coalesce(t.group_type, '')) = lower(coalesce(g.name, ''))
 AND t.is_active = true
 AND t.day_of_week = EXTRACT(ISODOW FROM s.session_date)::int
 AND t.start_time::text LIKE (split_part(s.start_time::text, ':', 1) || ':' ||
                              split_part(s.start_time::text, ':', 2)) || '%'
WHERE s.session_date >= CURRENT_DATE
  AND lower(coalesce(g.name, '')) = lower('Adultes')
ORDER BY s.session_date, s.start_time;


-- ------------------------------------------------------------
-- 4. Ancienne table `upcoming_sessions` : existe-t-elle encore ?
--    (requête dynamique : fonctionne même si la table est absente)
-- ------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'upcoming_sessions'
  ) THEN
    RAISE NOTICE 'upcoming_sessions existe : % lignes',
      (SELECT COUNT(*) FROM public.upcoming_sessions);
  ELSE
    RAISE NOTICE 'upcoming_sessions : table absente (rien à nettoyer).';
  END IF;
END $$;

-- Variante simple si la table est connue présente :
-- SELECT COUNT(*) FROM public.upcoming_sessions;


-- ============================================================
-- SUPPRESSIONS OPTIONNELLES — COMMENTÉES
-- À décommenter UNIQUEMENT après validation des IDs par le coach.
-- ============================================================

-- -- a) Supprimer les séances générées confirmées une par une :
-- DELETE FROM public.sessions
-- WHERE id IN (
--   -- '<id confirmé 1>',
--   -- '<id confirmé 2>'
-- )
--   AND session_date >= CURRENT_DATE
--   AND status = 'waiting';

-- -- b) Supprimer l'ancienne table si elle existe et est vide :
-- DROP TABLE IF EXISTS public.upcoming_sessions;
