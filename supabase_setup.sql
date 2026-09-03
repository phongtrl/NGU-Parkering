-- NGU Parkering – oppsett for delt database (kjør i Supabase SQL Editor)

-- 1) Tabell for parkeringsplassene
create table if not exists public.parking_spots (
    id          integer primary key,          -- 1..6
    taken       boolean     not null default false,
    car         text        not null default '',
    name        text        not null default '',
    slot        text,                          -- 'am' | 'pm' | null
    since       timestamptz,                   -- når plassen ble opptatt
    updated_at  timestamptz not null default now()
);

-- 1b) Migrering for eksisterende databaser: legg til kolonnen «since».
alter table public.parking_spots add column if not exists since timestamptz;

-- 2) Row Level Security
alter table public.parking_spots enable row level security;

-- 3) Tilgangsregler.
--    NB: Dette gir alle med anon-nøkkelen (dvs. alle som åpner siden) lov til å
--    lese og skrive. Det passer for en intern, delt parkeringstavle. Ønsker du
--    strengere kontroll, bytt til innlogging (Supabase Auth) og begrens med auth.uid().
create policy "read spots"   on public.parking_spots for select using (true);
create policy "insert spots" on public.parking_spots for insert with check (true);
create policy "update spots" on public.parking_spots for update using (true) with check (true);

-- 4) Aktiver sanntid (så andre enheter ser endringer umiddelbart)
alter publication supabase_realtime add table public.parking_spots;

-- 5) (Valgfritt) Opprett plassene på forhånd.
--    Appen gjør dette automatisk første gang, men du kan seede manuelt:
insert into public.parking_spots (id) values (1), (2), (3), (4), (5), (6)
on conflict (id) do nothing;
