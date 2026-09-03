-- Backend for NGU Parkering: Teams-varsler via Supabase Edge Function + pg_cron.
-- Kjør dette i Supabase → SQL Editor ETTER at Edge Function-en er deployet.
-- Bytt ut <CRON_SECRET> med samme hemmelighet som du satte på funksjonen.

-- 1) Utvidelser for planlegging og HTTP-kall
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 2) Dedup-tabell: sikrer at hvert varsel bare sendes én gang per plass/økt/dag.
create table if not exists public.charging_notifications (
    spot_id    int  not null,
    day        date not null,
    slot       text not null,
    kind       text not null,          -- 'warn' | 'expired'
    created_at timestamptz not null default now(),
    primary key (spot_id, day, slot, kind)
);

-- Kun Edge Function-en (service role) skal skrive her. Ingen policy = ingen anon-tilgang.
alter table public.charging_notifications enable row level security;

-- 3) Planlegg funksjonen hvert minutt.
--    Funksjons-URL bruker prosjekt-referansen din (zdmzduaqmdvligexmrkq).
select cron.schedule(
    'notify-charging-every-minute',
    '* * * * *',
    $$
    select net.http_post(
        url     := 'https://zdmzduaqmdvligexmrkq.functions.supabase.co/notify-charging',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'x-cron-secret', '<CRON_SECRET>'
        ),
        body    := '{}'::jsonb
    );
    $$
);

-- 4) (Valgfritt) Rydd bort gamle dedup-rader én gang i uka.
select cron.schedule(
    'cleanup-charging-notifications',
    '0 3 * * 1',
    $$ delete from public.charging_notifications where day < (current_date - 7); $$
);

-- Nyttige kommandoer:
--   select * from cron.job;                      -- se planlagte jobber
--   select cron.unschedule('notify-charging-every-minute');  -- stopp jobben
