// NGU Parkering – enkel administrasjon av fire parkeringsplasser.
// Delt tilstand via Supabase (sanntid), med localStorage som frakoblet reserve.

(() => {
    "use strict";

    const STORAGE_KEY = "ngu-parkering-v3";
    const SPOT_COUNT = 6;

    // To grupper ladere, vist én om gangen via bryteren øverst.
    const GROUPS = [
        { key: "nye", label: "Nye ladere", ids: [1, 2, 3, 4] },
        { key: "gamle", label: "Gamle ladere", ids: [5, 6] },
    ];
    const GROUP_KEY = "ngu-parkering-group";
    let currentGroup =
        GROUPS.some((g) => g.key === localStorage.getItem(GROUP_KEY))
            ? localStorage.getItem(GROUP_KEY)
            : "nye";

    function activeGroup() {
        return GROUPS.find((g) => g.key === currentGroup) || GROUPS[0];
    }

    function visibleSpots() {
        const ids = activeGroup().ids;
        return spots.filter((s) => ids.includes(s.id));
    }

    // Varsle brukeren dette antall millisekunder før ladeøkten slutter.
    const WARN_BEFORE_MS = 10 * 60 * 1000;

    // ---------- Supabase-konfig ----------
    // Fyll inn fra Supabase-prosjektet ditt (Project Settings → API).
    // Kjør også supabase_setup.sql i SQL Editor før bruk.
    const SUPABASE_URL = "https://zdmzduaqmdvligexmrkq.supabase.co";
    const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpkbXpkdWFxbWR2bGlnZXhtcmtxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgzMjQ0MDIsImV4cCI6MjEwMzkwMDQwMn0.KQk6enDnDDygCKhyNO-NKeUQ7i3ERwFjAN3TINeGvq4";
    const TABLE = "parking_spots";

    const remoteEnabled =
        !SUPABASE_URL.includes("YOUR-") &&
        !SUPABASE_ANON_KEY.includes("YOUR-") &&
        typeof window !== "undefined" &&
        !!window.supabase;
    const db = remoteEnabled
        ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
        : null;

    // Settes til false hvis databasen ennå mangler «since»-kolonnen.
    let sinceSupported = true;

    // «regnr» lagres inne i «car»-kolonnen (skilletegn) slik at det synkroniseres
    // på tvers av enheter uten at databasen trenger en egen kolonne.
    const REGNR_SEP = "\u001F";
    const packCar = (car, regnr) => (regnr ? `${car}${REGNR_SEP}${regnr}` : car);
    const unpackCar = (value) => {
        const [car, regnr] = String(value || "").split(REGNR_SEP);
        return { car: car || "", regnr: regnr || "" };
    };

    // Ladeøkter. Bilen kan lade i én av to økter per dag.
    const SLOTS = {
        am: { label: "07:30–11:30", end: [11, 30] },
        pm: { label: "11:30–16:00", end: [16, 0] },
    };

    // Standardtilstand for én plass.
    const emptySpot = (id) => ({
        id,
        taken: false,
        car: "",
        regnr: "",
        name: "",
        slot: null, // "am" | "pm"
        since: null, // ISO-tid for når plassen ble opptatt
    });

    /** @type {Array<ReturnType<typeof emptySpot>>} */
    let spots = load();

    // ---------- Lokal lagring (frakoblet reserve) ----------
    function load() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed) && parsed.length === SPOT_COUNT) {
                    // Fyll inn nye felt (f.eks. «regnr») for data lagret før de fantes.
                    return parsed.map((s) => ({ ...emptySpot(s.id), ...s, regnr: s.regnr || "" }));
                }
            }
        } catch {
            /* ignorer korrupt data */
        }
        return Array.from({ length: SPOT_COUNT }, (_, i) => emptySpot(i + 1));
    }

    function saveLocal() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(spots));
    }

    // ---------- Historikk (gjenbruk av tidligere tekster) ----------
    // Lagrer tidligere brukte verdier for Bil, Regnr og Navn lokalt, slik at de
    // kan foreslås (datalist) og gjenbrukes ved ny registrering.
    const HISTORY_KEY = "ngu-parkering-history";
    const HISTORY_LIMIT = 25;
    const HISTORY_FIELDS = ["car", "regnr", "name"];

    function loadHistory() {
        const base = { car: [], regnr: [], name: [], records: [] };
        try {
            const raw = localStorage.getItem(HISTORY_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                for (const field of HISTORY_FIELDS) {
                    if (Array.isArray(parsed[field])) {
                        base[field] = parsed[field].filter((v) => typeof v === "string");
                    }
                }
                if (Array.isArray(parsed.records)) {
                    base.records = parsed.records.filter(
                        (r) => r && typeof r.regnr === "string"
                    );
                }
            }
        } catch {
            /* ignorer korrupt data */
        }
        return base;
    }

    const history = loadHistory();

    function saveHistory() {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    }

    // Legger en verdi fremst i historikken (nyeste først, uten duplikater).
    function rememberValue(field, value) {
        const text = String(value || "").trim();
        if (!text) return false;
        const list = history[field];
        const existing = list.findIndex((v) => v.toLowerCase() === text.toLowerCase());
        if (existing !== -1) list.splice(existing, 1);
        list.unshift(text);
        if (list.length > HISTORY_LIMIT) list.length = HISTORY_LIMIT;
        return true;
    }

    // Kobler Bil + Navn til et Regnr, slik at valg av Regnr kan autofylle resten.
    function rememberRecord(spot) {
        const regnr = String(spot.regnr || "").trim();
        if (!regnr) return false;
        const car = String(spot.car || "").trim();
        const name = String(spot.name || "").trim();
        const records = history.records;
        const at = records.findIndex(
            (r) => r.regnr.toLowerCase() === regnr.toLowerCase()
        );
        const prev = at !== -1 ? records[at] : null;
        // Behold tidligere Bil/Navn dersom denne registreringen mangler dem.
        const merged = {
            regnr,
            car: car || (prev ? prev.car : ""),
            name: name || (prev ? prev.name : ""),
        };
        if (
            prev &&
            prev.regnr === merged.regnr &&
            prev.car === merged.car &&
            prev.name === merged.name &&
            at === 0
        ) {
            return false;
        }
        if (at !== -1) records.splice(at, 1);
        records.unshift(merged);
        if (records.length > HISTORY_LIMIT) records.length = HISTORY_LIMIT;
        return true;
    }

    // Finner en tidligere registrering ut fra Regnr.
    function lookupByRegnr(regnr) {
        const text = String(regnr || "").trim().toLowerCase();
        if (!text) return null;
        return (
            history.records.find((r) => r.regnr.toLowerCase() === text) || null
        );
    }

    // Husker alle tekstfeltene for en plass og oppdaterer forslagslistene.
    function rememberSpot(spot) {
        let changed = false;
        for (const field of HISTORY_FIELDS) {
            if (rememberValue(field, spot[field])) changed = true;
        }
        if (rememberRecord(spot)) changed = true;
        if (changed) {
            saveHistory();
            renderHistoryOptions();
        }
    }

    // Fyller historikken med verdier som allerede finnes (lokalt eller fra andre
    // enheter), slik at tidligere brukte tekster kan gjenbrukes med én gang.
    function seedHistoryFrom(list) {
        let changed = false;
        for (const spot of list || []) {
            if (!spot) continue;
            for (const field of HISTORY_FIELDS) {
                if (rememberValue(field, spot[field])) changed = true;
            }
            if (rememberRecord(spot)) changed = true;
        }
        if (changed) {
            saveHistory();
            renderHistoryOptions();
        }
    }

    // Fyller <datalist>-elementene med lagrede verdier.
    function renderHistoryOptions() {
        const map = { car: "carHistory", regnr: "regnrHistory", name: "nameHistory" };
        for (const field of HISTORY_FIELDS) {
            const list = document.getElementById(map[field]);
            if (!list) continue;
            list.innerHTML = "";
            for (const value of history[field]) {
                const opt = document.createElement("option");
                opt.value = value;
                list.appendChild(opt);
            }
        }
    }

    function debounce(fn, ms) {
        let t;
        return (...args) => {
            clearTimeout(t);
            t = setTimeout(() => fn(...args), ms);
        };
    }

    // Lagrer én plass lokalt + i den delte databasen (umiddelbart).
    function persist(spot) {
        saveLocal();
        upsertSpot(spot);
    }

    // ---------- Delt database (Supabase) ----------
    function setSyncStatus(text) {
        const s = document.getElementById("lastSaved");
        if (s) s.textContent = text;
    }

    async function upsertSpot(spot) {
        if (!remoteEnabled) return;
        const payload = {
            id: spot.id,
            taken: spot.taken,
            car: packCar(spot.car, spot.regnr),
            name: spot.name,
            slot: spot.slot,
            updated_at: new Date().toISOString(),
        };
        // «since» sendes kun hvis databasen har kolonnen (eldre baser mangler den).
        if (sinceSupported) payload.since = spot.since;
        const { error } = await db.from(TABLE).upsert(payload);
        if (error) {
            // Mangler «since»-kolonnen? Slå den av og lagre resten som normalt.
            if (sinceSupported && /since/i.test(error.message)) {
                sinceSupported = false;
                return upsertSpot(spot);
            }
            console.error("Supabase upsert:", error.message);
            setSyncStatus("Frakoblet – endringer lagres kun lokalt");
        }
    }

    // Skriving av tekstfelt slås sammen for å unngå én skriving per tastetrykk.
    const upsertDebounced = debounce(upsertSpot, 400);

    // Finner starttid: bruk «since» hvis den finnes, ellers lokal tid, ellers
    // «updated_at» (≈ tidspunktet plassen ble opptatt) slik at også andre enheter
    // ser «parkert siden» selv om databasen mangler «since»-kolonnen.
    function resolveSince(row, spot) {
        if (row.since) return row.since;
        if (!row.taken) return null;
        if (spot && spot.since) return spot.since;
        return row.updated_at || null;
    }

    // Fletter en rad fra databasen inn i lokal tilstand.
    function applyRow(row) {
        const spot = spots.find((s) => s.id === row.id);
        if (!spot) return;
        spot.since = resolveSince(row, spot); // beregnes før taken/felt overskrives
        spot.taken = !!row.taken;
        // «car» kan inneholde «regnr» pakket med skilletegn – pakk det ut.
        const carData = unpackCar(row.car);
        spot.car = carData.car;
        spot.regnr = carData.regnr;
        spot.name = row.name || "";
        spot.slot = row.slot || null;
    }

    // Kalles når en annen enhet endrer en plass.
    function onRemoteChange(row) {
        applyRow(row);
        saveLocal();
        const node = nodeFor(row.id);
        if (node) renderSpot(node, spots.find((s) => s.id === row.id));
        renderSummary();
        seedHistoryFrom([spots.find((s) => s.id === row.id)]);

        // Oppdater popup hvis den er åpen for samme plass – uten å forstyrre skriving.
        if (modal.open && currentId === row.id) {
            const spot = currentSpot();
            if (document.activeElement !== el.car) el.car.value = spot.car || "";
            if (document.activeElement !== el.regnr) el.regnr.value = spot.regnr || "";
            if (document.activeElement !== el.name) el.name.value = spot.name || "";
            renderModal();
            tickModal();
        }
    }

    // Henter alle plasser på nytt og fletter inn endringer fra andre enheter.
    // Brukes som reserve der sanntid (WebSocket) er blokkert av tjenerens CSP.
    async function pollRemote() {
        if (!remoteEnabled) return;
        const { data, error } = await db.from(TABLE).select("*");
        if (error || !data) return;
        for (const row of data) {
            const spot = spots.find((s) => s.id === row.id);
            if (!spot) continue;
            // Hopp over plassen som akkurat redigeres i åpen popup.
            if (modal.open && currentId === row.id) continue;
            const carData = unpackCar(row.car);
            const differs =
                spot.taken !== !!row.taken ||
                spot.car !== carData.car ||
                spot.regnr !== carData.regnr ||
                spot.name !== (row.name || "") ||
                spot.slot !== (row.slot || null) ||
                spot.since !== resolveSince(row, spot);
            if (differs) onRemoteChange(row);
        }
    }

    function renderAll() {
        spotsEl.querySelectorAll(".spot").forEach((node) => {
            const spot = spots.find((s) => s.id === Number(node.dataset.id));
            if (spot) renderSpot(node, spot);
        });
        renderSummary();
    }

    async function initRemote() {
        if (!remoteEnabled) {
            setSyncStatus("Lokal lagring – ingen delt database konfigurert");
            return;
        }
        setSyncStatus("Kobler til delt database …");

        const { data, error } = await db.from(TABLE).select("*").order("id");
        if (error) {
            console.error("Supabase select:", error.message);
            setSyncStatus("Frakoblet – bruker lokal lagring");
            return;
        }

        if (data && data.length) {
            const present = new Set(data.map((r) => r.id));
            data.forEach(applyRow);
            // Opprett plasser som mangler i databasen (f.eks. nye gamle-ladere 5–6).
            for (const spot of spots) {
                if (!present.has(spot.id)) await upsertSpot(spot);
            }
        } else {
            // Første gang: opprett alle plassene i databasen.
            for (const spot of spots) await upsertSpot(spot);
        }
        saveLocal();
        seedHistoryFrom(spots);
        renderAll();

        // Lytt på endringer fra alle enheter (sanntid via WebSocket der det er tillatt).
        db.channel("parking-spots")
            .on(
                "postgres_changes",
                { event: "*", schema: "public", table: TABLE },
                (payload) => {
                    if (payload.new) onRemoteChange(payload.new);
                }
            )
            .subscribe();

        // Reserve: poll over HTTPS (fungerer selv når WebSocket er blokkert av CSP).
        setInterval(pollRemote, 4000);

        setSyncStatus("Synkronisert på tvers av enheter");
    }

    // ---------- Nedtelling ----------
    // Velger passende ladeøkt ut fra klokkeslettet nå.
    function defaultSlot(now = new Date()) {
        const minutes = now.getHours() * 60 + now.getMinutes();
        return minutes < 11 * 60 + 30 ? "am" : "pm";
    }

    // Sluttidspunkt for en ladeøkt i dag.
    function slotDeadline(slotKey) {
        const [h, m] = SLOTS[slotKey].end;
        const d = new Date();
        d.setHours(h, m, 0, 0);
        return d;
    }

    function formatDuration(ms) {
        const overdue = ms < 0;
        const total = Math.floor(Math.abs(ms) / 1000);
        const h = String(Math.floor(total / 3600)).padStart(2, "0");
        const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
        const s = String(total % 60).padStart(2, "0");
        return { text: `${h}:${m}:${s}`, overdue };
    }

    // Klokkeslett (HH:MM) for når plassen ble opptatt.
    function formatSince(iso) {
        if (!iso) return "";
        const d = new Date(iso);
        if (isNaN(d)) return "";
        return d.toLocaleTimeString("no-NO", { hour: "2-digit", minute: "2-digit" });
    }

    // Hvor lenge plassen har vært opptatt (HH:MM:SS, timer utelates når 0).
    function formatElapsed(ms) {
        const total = Math.floor(Math.max(0, ms) / 1000);
        const pad = (n) => String(n).padStart(2, "0");
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const s = total % 60;
        return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
    }

    // Tekst som viser starttid og hvor lenge plassen har stått.
    function sinceParts(spot) {
        if (!spot.taken || !spot.since) return null;
        const start = new Date(spot.since);
        if (isNaN(start)) return null;
        const elapsed = formatElapsed(Date.now() - start.getTime());
        return {
            full: `Parkert siden ${formatSince(spot.since)} · ${elapsed}`,
            short: `Parkert ${elapsed}`, // kompakt variant for mobil
        };
    }

    function sinceText(spot) {
        const parts = sinceParts(spot);
        return parts ? parts.full : "";
    }

    // Oppdaterer et «parkert siden»-element (full + kompakt tekst).
    function renderSince(node, spot) {
        if (!node) return;
        const parts = sinceParts(spot);
        node.hidden = !parts;
        if (!parts) return;
        const full = node.querySelector(".since-full");
        const short = node.querySelector(".since-short");
        if (full) full.textContent = parts.full;
        if (short) short.textContent = parts.short;
    }

    // ---------- Fliser (kompakt oversikt) ----------
    const spotsEl = document.getElementById("spots");
    const template = document.getElementById("spotTemplate");

    function buildSpots() {
        const group = activeGroup();
        spotsEl.innerHTML = "";
        spotsEl.dataset.count = String(group.ids.length);
        for (const spot of visibleSpots()) {
            const node = template.content.firstElementChild.cloneNode(true);
            node.dataset.id = String(spot.id);
            node.querySelector(".spot-number").textContent = `Plass ${spot.id}`;
            node.addEventListener("click", () => openModal(spot.id));
            renderSpot(node, spot);
            spotsEl.appendChild(node);
        }
    }

    // ---------- Bryter mellom ladergrupper ----------
    function updateGroupSwitch() {
        const sw = document.getElementById("groupSwitch");
        if (!sw) return;
        let activeBtn = null;
        sw.querySelectorAll(".group-btn").forEach((btn) => {
            const on = btn.dataset.group === currentGroup;
            btn.classList.toggle("active", on);
            btn.setAttribute("aria-selected", on ? "true" : "false");
            if (on) activeBtn = btn;
        });
        // Flytt «dråpen» til den aktive knappen.
        if (activeBtn) {
            sw.style.setProperty("--pill-x", `${activeBtn.offsetLeft}px`);
            sw.style.setProperty("--pill-w", `${activeBtn.offsetWidth}px`);
            // Slå på animasjon etter første måling (unngår hopp ved oppstart).
            requestAnimationFrame(() => sw.setAttribute("data-ready", ""));
        }
    }

    function setupGroupSwitch() {
        const sw = document.getElementById("groupSwitch");
        if (!sw) return;
        sw.querySelectorAll(".group-btn").forEach((btn) => {
            btn.addEventListener("click", () => setGroup(btn.dataset.group));
        });
        updateGroupSwitch();
        // Hold «dråpen» på plass når bredden endres.
        window.addEventListener("resize", updateGroupSwitch);
    }

    // ---------- Info-trekkspill med åpne/lukke-animasjon ----------
    // Kollapser høyden i JS (Web Animations API) slik at boksen faktisk
    // krymper – uten en tom boks som henger igjen. Virker likt på iOS/Android.
    function setupInfoAccordion() {
        const info = document.getElementById("info");
        const summary = info?.querySelector(".info-summary");
        const body = info?.querySelector(".info-body");
        if (!info || !summary || !body) return;

        const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        let anim = null;

        const clearInline = () => {
            body.style.removeProperty("max-height");
            body.style.removeProperty("overflow");
            body.style.removeProperty("padding-top");
            body.style.removeProperty("padding-bottom");
        };

        summary.addEventListener("click", (e) => {
            e.preventDefault();
            if (anim) {
                anim.cancel();
                anim = null;
            }

            if (!info.open) {
                info.open = true;
                if (reduce) return;
                const full = body.scrollHeight;
                body.style.overflow = "hidden";
                anim = body.animate(
                    [
                        { maxHeight: "0px", opacity: 0, paddingTop: "0px", paddingBottom: "0px" },
                        { maxHeight: `${full}px`, opacity: 1 },
                    ],
                    { duration: 300, easing: "cubic-bezier(0.34, 1.3, 0.64, 1)" }
                );
                anim.onfinish = anim.oncancel = () => {
                    clearInline();
                    anim = null;
                };
            } else {
                if (reduce) {
                    info.open = false;
                    return;
                }
                const full = body.scrollHeight;
                body.style.overflow = "hidden";
                anim = body.animate(
                    [
                        { maxHeight: `${full}px`, opacity: 1 },
                        { maxHeight: "0px", opacity: 0, paddingTop: "0px", paddingBottom: "0px" },
                    ],
                    { duration: 170, easing: "ease-in" }
                );
                anim.onfinish = anim.oncancel = () => {
                    clearInline();
                    anim = null;
                    info.open = false;
                };
            }
        });
    }

    // Bytter aktiv ladergruppe og oppdaterer visningen.
    function setGroup(key) {
        if (!key || currentGroup === key || !GROUPS.some((g) => g.key === key)) return;
        currentGroup = key;
        localStorage.setItem(GROUP_KEY, currentGroup);
        updateGroupSwitch();
        buildSpots();
        renderSummary();
    }

    // Mobil: sveip venstre/høyre for å bytte mellom ladergruppene.
    function setupSwipeGroups() {
        let startX = 0;
        let startY = 0;
        let tracking = false;
        const SWIPE_MIN = 60; // px horisontalt før et bytte utløses

        spotsEl.addEventListener(
            "touchstart",
            (e) => {
                if (modal.open || e.touches.length !== 1) {
                    tracking = false;
                    return;
                }
                startX = e.touches[0].clientX;
                startY = e.touches[0].clientY;
                tracking = true;
            },
            { passive: true }
        );

        spotsEl.addEventListener(
            "touchend",
            (e) => {
                if (!tracking) return;
                tracking = false;
                const touch = e.changedTouches[0];
                const dx = touch.clientX - startX;
                const dy = touch.clientY - startY;
                // Kun tydelige horisontale sveip skal bytte gruppe.
                if (Math.abs(dx) < SWIPE_MIN || Math.abs(dx) < Math.abs(dy) * 1.5) return;
                const idx = GROUPS.findIndex((g) => g.key === currentGroup);
                const next = dx < 0 ? idx + 1 : idx - 1;
                if (next < 0 || next >= GROUPS.length) return;
                setGroup(GROUPS[next].key);
            },
            { passive: true }
        );
    }

    // Oppdaterer en flis ut fra plassens tilstand.
    function renderSpot(node, spot) {
        node.classList.toggle("taken", spot.taken);
        node.querySelector(".status-badge").textContent = spot.taken ? "Lader" : "Ledig";

        node.querySelector(".spot-car").textContent = spot.car || "";
        const regnrEl = node.querySelector(".spot-regnr");
        regnrEl.textContent = spot.regnr || "";
        regnrEl.hidden = !spot.regnr;
        node.querySelector(".spot-name").textContent = spot.name || "";
        renderSince(node.querySelector(".spot-since"), spot);
        node.querySelector(".spot-slot").textContent = spot.slot ? SLOTS[spot.slot].label : "";
        node.querySelector(".spot-timer").hidden = !spot.taken;
    }

    function tickSpot(node, spot) {
        renderSince(node.querySelector(".spot-since"), spot);
        if (!spot.taken || !spot.slot) return;
        const timer = node.querySelector(".spot-timer");
        const { text, overdue } = formatDuration(slotDeadline(spot.slot).getTime() - Date.now());
        const label = node.querySelector(".spot-timer-label");
        if (label) label.textContent = overdue ? "Over tiden" : "Tid igjen";
        node.querySelector(".spot-timer-time").textContent = text;
        timer.classList.toggle("overdue", overdue);
    }

    function renderSummary() {
        const vis = visibleSpots();
        const taken = vis.filter((s) => s.taken).length;
        document.getElementById("countTaken").textContent = String(taken);
        document.getElementById("countFree").textContent = String(vis.length - taken);
        const total = document.getElementById("countTotal");
        if (total) total.textContent = String(vis.length);
    }

    function nodeFor(id) {
        return spotsEl.querySelector(`.spot[data-id="${id}"]`);
    }

    // ---------- Popup (rediger plass) ----------
    const modal = document.getElementById("modal");
    const el = {
        title: document.getElementById("modalTitle"),
        status: document.getElementById("modalStatus"),
        car: document.getElementById("modalCar"),
        regnr: document.getElementById("modalRegnr"),
        regnrField: document.getElementById("modalRegnrField"),
        regnrError: document.getElementById("modalRegnrError"),
        name: document.getElementById("modalName"),
        slotField: document.getElementById("modalSlotField"),
        slot: document.getElementById("modalSlot"),
        countdown: document.getElementById("modalCountdown"),
        since: document.getElementById("modalSince"),
        toggle: document.getElementById("modalToggle"),
        clear: document.getElementById("modalClear"),
        save: document.getElementById("modalSave"),
        saveHint: document.getElementById("modalSaveHint"),
        close: document.getElementById("modalClose"),
    };

    let currentId = null;

    function currentSpot() {
        return spots.find((s) => s.id === currentId) || null;
    }

    function openModal(id) {
        currentId = id;
        const spot = currentSpot();
        el.car.value = spot.car || "";
        el.regnr.value = spot.regnr || "";
        el.name.value = spot.name || "";
        setRegnrError(false);
        renderModal();
        modal.showModal();
        (spot.taken ? el.name : el.car).focus();
    }

    function closeModal() {
        currentId = null;
        modal.close();
    }

    // Egendefinert bekreftelse (unngår nettleserens "slusen.ngu.no says").
    const confirmDialog = document.getElementById("confirmDialog");
    const confirmText = document.getElementById("confirmText");
    const confirmOk = document.getElementById("confirmOk");
    const confirmCancel = document.getElementById("confirmCancel");

    function askConfirm(message) {
        confirmText.textContent = message;
        confirmDialog.showModal();
        return new Promise((resolve) => {
            const done = (result) => {
                confirmOk.removeEventListener("click", onOk);
                confirmCancel.removeEventListener("click", onCancel);
                confirmDialog.removeEventListener("cancel", onCancel);
                confirmDialog.close();
                resolve(result);
            };
            const onOk = () => done(true);
            const onCancel = (e) => { if (e) e.preventDefault(); done(false); };
            confirmOk.addEventListener("click", onOk);
            confirmCancel.addEventListener("click", onCancel);
            confirmDialog.addEventListener("cancel", onCancel);
        });
    }

    function renderModal() {
        const spot = currentSpot();
        if (!spot) return;

        el.title.textContent = `Plass ${spot.id}`;
        el.status.textContent = spot.taken ? "Lader" : "Ledig";
        el.status.classList.toggle("taken", spot.taken);
        modal.classList.toggle("taken", spot.taken);
        el.toggle.textContent = spot.taken ? "Avslutt lading" : "Start lading";
        el.save.hidden = !spot.taken;
        if (el.saveHint) el.saveHint.hidden = !spot.taken;

        el.slotField.hidden = !spot.taken;
        el.slot.querySelectorAll(".slot-btn").forEach((btn) => {
            btn.classList.toggle("active", btn.dataset.slot === spot.slot);
        });

        el.countdown.hidden = !spot.taken;
        if (!spot.taken) {
            el.countdown.classList.remove("overdue");
            el.countdown.querySelector(".countdown-time").textContent = "00:00:00";
            el.countdown.querySelector(".countdown-label").textContent = "Ladeøkt slutter om";
        }

        if (el.since) {
            const t = sinceText(spot);
            el.since.hidden = !t;
            el.since.textContent = t;
        }
    }

    function tickModal() {
        const spot = currentSpot();
        if (!modal.open || !spot) return;
        if (el.since) {
            const t = sinceText(spot);
            el.since.hidden = !t;
            el.since.textContent = t;
        }
        if (!spot.taken || !spot.slot) return;
        const { text, overdue } = formatDuration(slotDeadline(spot.slot).getTime() - Date.now());
        el.countdown.querySelector(".countdown-time").textContent = text;
        el.countdown.classList.toggle("overdue", overdue);
        el.countdown.querySelector(".countdown-label").textContent = overdue
            ? "Ladeøkt er over"
            : "Ladeøkt slutter om";
    }

    // Oppdaterer flis + oppsummering etter en endring.
    function syncSpot() {
        const spot = currentSpot();
        if (spot) renderSpot(nodeFor(spot.id), spot);
        renderSummary();
    }

    el.car.addEventListener("input", () => {
        const spot = currentSpot();
        spot.car = el.car.value;
        saveLocal();
        syncSpot();
        upsertDebounced(spot);
    });
    // Viser/skjuler feilmelding for påkrevd Regnr.
    function setRegnrError(show) {
        el.regnrField.classList.toggle("invalid", show);
        el.regnrError.hidden = !show;
    }

    // Fyller Bil og Navn fra en tidligere registrering når Regnr gjenkjennes.
    function autofillFromRegnr(spot) {
        const match = lookupByRegnr(spot.regnr);
        if (!match) return;
        if (match.car && !el.car.value.trim()) {
            spot.car = match.car;
            el.car.value = match.car;
        }
        if (match.name && !el.name.value.trim()) {
            spot.name = match.name;
            el.name.value = match.name;
        }
    }

    el.regnr.addEventListener("input", () => {
        const spot = currentSpot();
        spot.regnr = el.regnr.value;
        if (el.regnr.value.trim()) setRegnrError(false);
        autofillFromRegnr(spot);
        saveLocal();
        syncSpot();
        upsertDebounced(spot);
    });
    el.name.addEventListener("input", () => {
        const spot = currentSpot();
        spot.name = el.name.value;
        saveLocal();
        syncSpot();
        upsertDebounced(spot);
    });

    el.slot.querySelectorAll(".slot-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            const spot = currentSpot();
            spot.slot = btn.dataset.slot;
            persist(spot);
            renderModal();
            tickModal();
            syncSpot();
        });
    });

    // Kort bekreftelses-popup nederst på skjermen.
    let toastTimer;
    function showToast(message) {
        let toast = document.getElementById("toast");
        if (!toast) {
            toast = document.createElement("div");
            toast.id = "toast";
            toast.className = "toast";
            document.body.appendChild(toast);
        }
        toast.textContent = message;
        toast.classList.add("show");
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => toast.classList.remove("show"), 3500);
    }

    el.toggle.addEventListener("click", async () => {
        const spot = currentSpot();
        // Avslutt lading: tøm plassen og lukk popupen.
        if (spot.taken) {
            if (!(await askConfirm("Er du sikker på at du vil avslutte økten din?"))) return;
            Object.assign(spot, emptySpot(spot.id));
            el.car.value = "";
            el.regnr.value = "";
            el.name.value = "";
            setRegnrError(false);
            persist(spot);
            syncSpot();
            closeModal();
            return;
        }
        // Start lading: Regnr er påkrevd.
        if (!el.regnr.value.trim()) {
            setRegnrError(true);
            el.regnr.focus();
            return;
        }
        setRegnrError(false);
        spot.taken = true;
        spot.slot = defaultSlot();
        spot.since = new Date().toISOString();
        rememberSpot(spot);
        persist(spot);
        renderModal();
        tickModal();
        syncSpot();
        closeModal();
        showToast(`Lading har startet for ${spot.regnr}`);
    });

    el.close.addEventListener("click", closeModal);
    // Lagrer endringer på en aktiv registrering (Regnr, Bil, Navn) og lukker.
    el.save.addEventListener("click", () => {
        const spot = currentSpot();
        if (!spot) return;
        if (!el.regnr.value.trim()) {
            setRegnrError(true);
            el.regnr.focus();
            return;
        }
        spot.car = el.car.value.trim();
        spot.regnr = el.regnr.value.trim();
        spot.name = el.name.value.trim();
        rememberSpot(spot);
        persist(spot);
        syncSpot();
        closeModal();
    });
    // Tømmer tekstfeltene (Regnr, Bil, Navn) uten å endre status.
    el.clear.addEventListener("click", () => {
        const spot = currentSpot();
        if (!spot) return;
        spot.car = "";
        spot.regnr = "";
        spot.name = "";
        el.car.value = "";
        el.regnr.value = "";
        el.name.value = "";
        setRegnrError(false);
        el.regnr.focus();
        persist(spot);
        syncSpot();
    });
    // Lukk ved klikk på bakgrunnen.
    modal.addEventListener("click", (e) => {
        if (e.target === modal) closeModal();
    });
    modal.addEventListener("close", () => {
        currentId = null;
    });

    // ---------- Klokke + tick ----------
    function tick() {
        document.getElementById("clock").textContent = new Date().toLocaleTimeString("no-NO");

        spotsEl.querySelectorAll(".spot").forEach((node) => {
            const spot = spots.find((s) => s.id === Number(node.dataset.id));
            if (spot) tickSpot(node, spot);
        });
        tickModal();
        checkDeadlines();
    }

    // ---------- Varsler (nettleser) ----------
    const NOTIFY_KEY = "ngu-parkering-notify";
    const notifySupported = typeof Notification !== "undefined";
    let notifyEnabled =
        notifySupported &&
        localStorage.getItem(NOTIFY_KEY) === "1" &&
        Notification.permission === "granted";
    // Sporer hvilke varsler som allerede er sendt per plass og ladeøkt.
    const notifyLog = {};

    function updateNotifyUI() {
        const btn = document.getElementById("notifyBtn");
        const status = document.getElementById("notifyStatus");
        if (!btn) return;
        if (!notifySupported) {
            btn.disabled = true;
            btn.textContent = "🔕 Varsler støttes ikke";
            if (status) status.textContent = "Nettleseren din støtter ikke varsler.";
            return;
        }
        if (notifyEnabled) {
            btn.textContent = "🔔 Varsler på";
            btn.classList.add("on");
            if (status) status.textContent = "Du varsles ~10 min før ladeøkten slutter.";
        } else {
            btn.textContent = "🔕 Slå på varsler";
            btn.classList.remove("on");
            if (status) {
                status.textContent =
                    Notification.permission === "denied"
                        ? "Varsler er blokkert i nettleserinnstillingene."
                        : "";
            }
        }
    }

    async function toggleNotify() {
        if (!notifySupported) return;
        if (notifyEnabled) {
            notifyEnabled = false;
            localStorage.setItem(NOTIFY_KEY, "0");
            updateNotifyUI();
            return;
        }
        let perm = Notification.permission;
        if (perm !== "granted") perm = await Notification.requestPermission();
        notifyEnabled = perm === "granted";
        localStorage.setItem(NOTIFY_KEY, notifyEnabled ? "1" : "0");
        if (notifyEnabled) {
            showNotification("Varsler er på", "Du varsles når ladetiden nærmer seg slutt.");
        }
        updateNotifyUI();
    }

    function showNotification(title, body) {
        if (!notifyEnabled || !notifySupported || Notification.permission !== "granted") return;
        try {
            new Notification(title, { body, tag: "ngu-parkering", renotify: true });
        } catch {
            /* noen nettlesere tillater kun varsler via service worker */
        }
    }

    // Sender varsel når en ladeøkt nærmer seg slutt eller er over.
    function checkDeadlines() {
        if (!notifyEnabled) return;
        for (const spot of spots) {
            if (!spot.taken || !spot.slot) {
                delete notifyLog[spot.id];
                continue;
            }
            const remaining = slotDeadline(spot.slot).getTime() - Date.now();
            let log = notifyLog[spot.id];
            if (!log || log.slot !== spot.slot) {
                log = notifyLog[spot.id] = { slot: spot.slot, warned: false, expired: false };
            }
            const who = spot.car.trim() ? ` (${spot.car.trim()})` : "";
            const endTime = SLOTS[spot.slot].label.split("–")[1];
            if (remaining <= 0) {
                if (!log.expired) {
                    log.expired = true;
                    showNotification(
                        `Plass ${spot.id}: ladetiden er ute`,
                        `Flytt bilen${who} så andre får ladet.`
                    );
                }
            } else if (remaining <= WARN_BEFORE_MS && !log.warned) {
                log.warned = true;
                const mins = Math.max(1, Math.round(remaining / 60000));
                showNotification(
                    `Plass ${spot.id}: ${mins} min igjen`,
                    `Ladeøkten${who} slutter ${endTime}.`
                );
            }
        }
    }

    // ---------- Dra ned for å oppdatere ----------
    async function refreshFromRemote() {
        if (!remoteEnabled) return;
        const { data, error } = await db.from(TABLE).select("*");
        if (error || !data) return;
        data.forEach(applyRow);
        saveLocal();
        renderAll();
    }

    function setupPullToRefresh() {
        const indicator = document.createElement("div");
        indicator.className = "ptr-indicator";
        indicator.innerHTML = '<span class="ptr-spinner"></span>';
        document.body.appendChild(indicator);

        const THRESHOLD = 70;
        let startY = 0;
        let dist = 0;
        let pulling = false;

        const move = (px, ready) => {
            indicator.style.transform = `translateX(-50%) translateY(${px}px)`;
            indicator.style.opacity = String(Math.min(px / THRESHOLD, 1));
            indicator.classList.toggle("ready", ready);
        };

        const reset = () => {
            indicator.classList.add("resetting");
            indicator.classList.remove("ready", "loading");
            indicator.style.transform = "translateX(-50%) translateY(0)";
            indicator.style.opacity = "0";
            setTimeout(() => indicator.classList.remove("resetting"), 260);
        };

        window.addEventListener(
            "touchstart",
            (e) => {
                if (window.scrollY > 0 || modal.open || e.touches.length !== 1) return;
                startY = e.touches[0].clientY;
                dist = 0;
                pulling = true;
                indicator.classList.remove("resetting");
            },
            { passive: true }
        );

        window.addEventListener(
            "touchmove",
            (e) => {
                if (!pulling) return;
                dist = e.touches[0].clientY - startY;
                if (dist <= 0) {
                    move(0, false);
                    return;
                }
                // Motstand: dra saktere enn fingeren.
                const px = Math.min(dist * 0.6, THRESHOLD);
                move(px, dist >= THRESHOLD);
            },
            { passive: true }
        );

        window.addEventListener("touchend", async () => {
            if (!pulling) return;
            pulling = false;
            if (dist >= THRESHOLD) {
                indicator.classList.add("loading");
                move(THRESHOLD, false);
                try {
                    await refreshFromRemote();
                } finally {
                    setTimeout(reset, 500);
                }
            } else {
                reset();
            }
            dist = 0;
        });
    }

    // ---------- Installer som app (PWA) ----------
    // Tegner et app-ikon og kobler til manifest + Apple-ikon uten egne filer,
    // slik at siden kan installeres selv om Slusen bare serverer HTML-en.
    function makeIcon(size, radiusRatio) {
        const c = document.createElement("canvas");
        c.width = c.height = size;
        const ctx = c.getContext("2d");
        const r = size * radiusRatio;
        ctx.fillStyle = "#18181b";
        ctx.beginPath();
        ctx.moveTo(r, 0);
        ctx.arcTo(size, 0, size, size, r);
        ctx.arcTo(size, size, 0, size, r);
        ctx.arcTo(0, size, 0, 0, r);
        ctx.arcTo(0, 0, size, 0, r);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = `700 ${Math.round(size * 0.6)}px Inter, "Segoe UI", system-ui, sans-serif`;
        ctx.fillText("P", size / 2, size / 2 + size * 0.02);
        return c.toDataURL("image/png");
    }

    function setupInstall() {
        const base = location.href.split("?")[0].split("#")[0];
        const icon = makeIcon(512, 0.22);

        const apple = document.createElement("link");
        apple.rel = "apple-touch-icon";
        apple.href = makeIcon(180, 0);
        document.head.appendChild(apple);

        const manifest = {
            name: "NGU Parkering",
            short_name: "Parkering",
            id: base,
            start_url: base,
            scope: base,
            display: "standalone",
            orientation: "portrait",
            background_color: "#fafafa",
            theme_color: "#18181b",
            icons: [
                { src: icon, sizes: "512x512", type: "image/png", purpose: "any" },
                { src: icon, sizes: "512x512", type: "image/png", purpose: "maskable" },
            ],
        };
        const link = document.createElement("link");
        link.rel = "manifest";
        // data: URI (ikke blob:) fordi Slusens CSP blokkerer blob-URLer.
        link.href =
            "data:application/manifest+json," +
            encodeURIComponent(JSON.stringify(manifest));
        document.head.appendChild(link);

        setupInstallHint();
    }

    function setupInstallHint() {
        const standalone =
            window.matchMedia("(display-mode: standalone)").matches ||
            window.navigator.standalone === true;
        if (standalone || localStorage.getItem("ngu-install-dismissed") === "1") return;
        if (!/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) return;

        const isiOS = /iPhone|iPad|iPod/i.test(navigator.userAgent);
        const how = isiOS
            ? "Trykk Del-ikonet og velg «Legg til på Hjem-skjerm»."
            : "Åpne menyen og velg «Installer app» / «Legg til på startskjerm».";

        const bar = document.createElement("div");
        bar.className = "install-hint";
        const text = document.createElement("span");
        text.textContent = `📲 Installer NGU Parkering som app. ${how}`;
        const close = document.createElement("button");
        close.type = "button";
        close.className = "install-close";
        close.setAttribute("aria-label", "Lukk");
        close.textContent = "×";
        bar.append(text, close);
        document.body.appendChild(bar);

        const dismiss = () => {
            bar.remove();
            localStorage.setItem("ngu-install-dismissed", "1");
        };
        close.addEventListener("click", dismiss);

        // Der nettleseren støtter det, gi et ekte «Installer»-trykk.
        window.addEventListener("beforeinstallprompt", (e) => {
            e.preventDefault();
            close.textContent = "Installer";
            close.classList.add("install-do");
            close.removeEventListener("click", dismiss);
            close.addEventListener("click", async () => {
                e.prompt();
                await e.userChoice;
                dismiss();
            });
        });
    }

    // ---------- Oppstart ----------
    buildSpots();
    setupGroupSwitch();
    setupSwipeGroups();
    setupInfoAccordion();
    seedHistoryFrom(spots);
    renderHistoryOptions();
    renderSummary();
    tick();
    setInterval(tick, 1000);
    initRemote();
    setupPullToRefresh();
    setupInstall();
    document.getElementById("notifyBtn")?.addEventListener("click", toggleNotify);
    updateNotifyUI();
})();
