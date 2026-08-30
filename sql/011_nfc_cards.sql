-- ============================================================
-- MIGRATION 011 — V2 : cartes NFC basées sur l'UID / Serial Number
--
-- Remplace l'ancien système qui écrivait des infos personnelles
-- (ID adhérent en texte) sur la carte. Désormais on se base sur
-- l'UID (Serial Number) gravé en usine sur la puce, qui n'est
-- jamais écrit ni réécrit : l'attribution à un adhérent est
-- stockée ici, côté base, et reste modifiable/désattribuable.
--
-- Tables créées :
--   public.nfc_cards      — l'inventaire des cartes (UID unique)
--   public.nfc_attendance_events — historique des scans (présence)
--
-- Vues :
--   public.nfc_card_status — N° d'adhérent + nom référencés par UID
--
-- À exécuter dans le SQL Editor Supabase.
-- ============================================================

-- ---------- Table nfc_cards ----------
create table if not exists public.nfc_cards (
    id            uuid primary key default gen_random_uuid(),
    uid           text        not null unique,
    member_id     text        references public.members(id) on delete set null,
    status        text        not null default 'unassigned'
                              check (status in ('assigned', 'unassigned', 'lost', 'retired')),
    assigned_at   timestamptz,
    unassigned_at timestamptz,
    notes         text,
    created_at    timestamptz not null default now(),
    updated_at    timestamptz not null default now()
);

-- ---------- Table nfc_attendance_events (scanner de présence) ----------
create table if not exists public.nfc_attendance_events (
    id           uuid primary key default gen_random_uuid(),
    club_id      text,
    uid          text,
    member_id    text        references public.members(id) on delete set null,
    scan_time    timestamptz not null default now(),
    scan_date    date        not null default current_date,
    scan_result  text        not null default 'present'
                           check (scan_result in ('present', 'unassigned', 'expired', 'unknown')),
    method       text        not null default 'NFC'
);

create index if not exists idx_nfc_attendance_member
    on public.nfc_attendance_events (member_id, scan_date);

create index if not exists idx_nfc_attendance_date
    on public.nfc_attendance_events (scan_date);

create index if not exists idx_nfc_cards_member
    on public.nfc_cards (member_id);

create index if not exists idx_nfc_cards_status
    on public.nfc_cards (status);

-- ---------- Trigger updated_at ----------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists trg_nfc_cards_updated on public.nfc_cards;
create trigger trg_nfc_cards_updated
    before update on public.nfc_cards
    for each row execute function public.set_updated_at();

-- ---------- Vue nfc_card_status ----------
create or replace view public.nfc_card_status as
select
    c.id,
    c.uid,
    c.status,
    c.assigned_at,
    c.unassigned_at,
    c.member_id,
    m.first_name,
    m.last_name,
    m.photo_url,
    c.created_at,
    c.updated_at
from public.nfc_cards c
left join public.members m on m.id = c.member_id;

-- ---------- Accès REST (identical aux autres tables V2) ----------
alter table if exists public.nfc_cards           disable row level security;
alter table if exists public.nfc_attendance_events disable row level security;

grant all privileges on public.nfc_cards,
    public.nfc_attendance_events
    to anon, authenticated;

grant select on public.nfc_card_status to anon, authenticated;

-- ---------- RPC : attribution d'une carte ----------
create or replace function public.assign_nfc_card(
    p_uid       text,
    p_member_id text
)
returns public.nfc_cards
language plpgsql
security definer
set search_path = public
as $$
declare
    v_existing public.nfc_cards;
    v_member   public.members%rowtype;
    v_card     public.nfc_cards;
begin
    -- L'adhérent doit exister
    select * into v_member from public.members where id = p_member_id;
    if not found then
        raise exception 'Adhérent introuvable' using errcode = 'P0001';
    end if;

    -- La carte ne doit pas déjà être attribuée à un autre adhérent
    select * into v_existing from public.nfc_cards
     where uid = p_uid;
    if found and v_existing.status = 'assigned' and v_existing.member_id <> p_member_id then
        raise exception 'Carte déjà attribuée à un autre adhérent' using errcode = 'P0001';
    end if;

    if found then
        update public.nfc_cards
           set member_id     = p_member_id,
               status        = 'assigned',
               assigned_at   = now(),
               unassigned_at = null
         where id = v_existing.id
         returning * into v_card;
    else
        insert into public.nfc_cards (uid, member_id, status, assigned_at)
        values (p_uid, p_member_id, 'assigned', now())
        returning * into v_card;
    end if;

    return v_card;
end;
$$;

grant execute on function public.assign_nfc_card(text, text) to anon, authenticated;

comment on function public.assign_nfc_card(text, text) is
    'V2 - Attribue une carte NFC (UID) à un adhérent, ou réattribue si libre.';
