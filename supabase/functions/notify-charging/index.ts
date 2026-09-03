// Edge Function: overvåker ladefristene og varsler en Microsoft Teams-kanal.
// Kjøres av pg_cron hvert minutt (se backend_setup.sql).
//
// Miljøvariabler (settes med `supabase secrets set ...`):
//   TEAMS_WEBHOOK_URL   – Incoming Webhook / Workflow-URL til Teams-kanalen
//   CRON_SECRET         – delt hemmelighet som pg_cron sender i header x-cron-secret
// SUPABASE_URL og SUPABASE_SERVICE_ROLE_KEY injiseres automatisk av Supabase.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TEAMS_WEBHOOK_URL = Deno.env.get("TEAMS_WEBHOOK_URL") ?? "";
const CRON_SECRET = Deno.env.get("CRON_SECRET") ?? "";

const SLOTS: Record<string, { label: string; endMin: number }> = {
    am: { label: "07:00–11:30", endMin: 11 * 60 + 30 },
    pm: { label: "11:30–16:00", endMin: 16 * 60 },
};

const WARN_MIN = 10; // varsle når det er 10 min eller mindre igjen
const EXPIRED_GRACE = 15; // send «ute»-varsel innen 15 min etter fristen

// Klokkeslett i Oslo-tid (håndterer sommertid automatisk).
function osloNow(): { dateKey: string; minutes: number } {
    const parts = Object.fromEntries(
        new Intl.DateTimeFormat("en-GB", {
            timeZone: "Europe/Oslo",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
        })
            .formatToParts(new Date())
            .map((p) => [p.type, p.value]),
    );
    return {
        dateKey: `${parts.year}-${parts.month}-${parts.day}`,
        minutes: Number(parts.hour) * 60 + Number(parts.minute),
    };
}

async function sendTeams(text: string): Promise<void> {
    // Payload `{ text }` fungerer for klassisk Incoming Webhook. For en
    // Teams Workflow (Power Automate) leser du feltet `text` i flyten.
    await fetch(TEAMS_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
    });
}

Deno.serve(async (req) => {
    if (CRON_SECRET && req.headers.get("x-cron-secret") !== CRON_SECRET) {
        return new Response("Unauthorized", { status: 401 });
    }
    if (!TEAMS_WEBHOOK_URL) {
        return new Response("TEAMS_WEBHOOK_URL mangler", { status: 500 });
    }

    const db = createClient(SUPABASE_URL, SERVICE_KEY);
    const { dateKey, minutes } = osloNow();

    const { data: spots, error } = await db.from("parking_spots").select("*");
    if (error) return new Response(error.message, { status: 500 });

    const sent: string[] = [];
    for (const spot of spots ?? []) {
        const slot = SLOTS[spot.slot as string];
        if (!spot.taken || !slot) continue;

        const remaining = slot.endMin - minutes;
        let kind: "warn" | "expired" | null = null;
        if (remaining > 0 && remaining <= WARN_MIN) kind = "warn";
        else if (remaining <= 0 && remaining >= -EXPIRED_GRACE) kind = "expired";
        if (!kind) continue;

        // Dedup: reserver (plass, dato, økt, type). Finnes den → allerede sendt.
        const { error: insErr } = await db
            .from("charging_notifications")
            .insert({ spot_id: spot.id, day: dateKey, slot: spot.slot, kind });
        if (insErr) continue; // unik-konflikt (23505) eller annen feil → hopp over

        const car = String(spot.car ?? "").trim();
        const who = car ? ` (${car})` : "";
        const end = slot.label.split("–")[1];
        const text =
            kind === "warn"
                ? `⚡ Plass ${spot.id}${who}: ${remaining} min igjen av ladeøkten (slutter ${end}).`
                : `🔌 Plass ${spot.id}${who}: ladetiden er ute – flytt bilen så andre får ladet.`;

        await sendTeams(text);
        sent.push(text);
    }

    return new Response(JSON.stringify({ sent: sent.length, results: sent }), {
        headers: { "Content-Type": "application/json" },
    });
});
