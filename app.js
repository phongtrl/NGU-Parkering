// NGU Parkering – enkel administrasjon av fire parkeringsplasser.
// All tilstand lagres lokalt i nettleseren (localStorage).

(() => {
    "use strict";

    const STORAGE_KEY = "ngu-parkering-v2";
    const SPOT_COUNT = 4;

    // Ladeøkter. Bilen kan lade i én av to økter per dag.
    const SLOTS = {
        am: { label: "07:00–11:30", end: [11, 30] },
        pm: { label: "11:30–16:00", end: [16, 0] },
    };

    // Standardtilstand for én plass.
    const emptySpot = (id) => ({
        id,
        taken: false,
        regnr: "",
        name: "",
        slot: null, // "am" | "pm"
    });

    /** @type {Array<ReturnType<typeof emptySpot>>} */
    let spots = load();

    // ---------- Lagring ----------
    function load() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed) && parsed.length === SPOT_COUNT) {
                    return parsed;
                }
            }
        } catch {
            /* ignorer korrupt data */
        }
        return Array.from({ length: SPOT_COUNT }, (_, i) => emptySpot(i + 1));
    }

    function save() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(spots));
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

    // ---------- Rendering ----------
    const spotsEl = document.getElementById("spots");
    const template = document.getElementById("spotTemplate");

    function buildSpots() {
        spotsEl.innerHTML = "";
        for (const spot of spots) {
            const node = template.content.firstElementChild.cloneNode(true);
            node.dataset.id = String(spot.id);
            node.querySelector(".spot-number").textContent = `Plass ${spot.id}`;

            const regInput = node.querySelector(".input-regnr");
            const nameInput = node.querySelector(".input-name");
            regInput.value = spot.regnr;
            nameInput.value = spot.name;

            // Lagre feltene mens man skriver.
            regInput.addEventListener("input", () => {
                spot.regnr = regInput.value;
                save();
            });
            nameInput.addEventListener("input", () => {
                spot.name = nameInput.value;
                save();
            });

            // Sett opptatt / ledig.
            node.querySelector(".btn-toggle").addEventListener("click", () => {
                spot.taken = !spot.taken;
                spot.slot = spot.taken ? defaultSlot() : null;
                save();
                renderSpot(node, spot);
                renderSummary();
            });

            // Bytt ladeøkt.
            node.querySelectorAll(".slot-btn").forEach((btn) => {
                btn.addEventListener("click", () => {
                    spot.slot = btn.dataset.slot;
                    save();
                    renderSpot(node, spot);
                });
            });

            // Frigjør: tøm og sett ledig.
            node.querySelector(".btn-clear").addEventListener("click", () => {
                if (spot.taken && !confirm(`Frigjøre plass ${spot.id}?`)) return;
                Object.assign(spot, emptySpot(spot.id));
                regInput.value = "";
                nameInput.value = "";
                save();
                renderSpot(node, spot);
                renderSummary();
            });

            renderSpot(node, spot);
            spotsEl.appendChild(node);
        }
    }

    // Oppdaterer statusavhengige elementer for én plass.
    function renderSpot(node, spot) {
        node.classList.toggle("taken", spot.taken);

        const badge = node.querySelector(".status-badge");
        badge.textContent = spot.taken ? "Lader" : "Ledig";

        node.querySelector(".btn-toggle").textContent = spot.taken
            ? "Avslutt lading"
            : "Start lading";

        node.querySelector(".slot-field").hidden = !spot.taken;
        node.querySelectorAll(".slot-btn").forEach((btn) => {
            btn.classList.toggle("active", btn.dataset.slot === spot.slot);
        });

        const countdown = node.querySelector(".countdown");
        countdown.hidden = !spot.taken;

        // Nullstill nedtellingen når lading er stanset eller plassen frigjort.
        if (!spot.taken) {
            countdown.classList.remove("overdue");
            node.querySelector(".countdown-time").textContent = "00:00:00";
            node.querySelector(".countdown-label").textContent = "Ladeøkt slutter om";
        }
    }

    // Oppdaterer bare nedtellingstekst (kjøres hvert sekund).
    function tickSpot(node, spot) {
        if (!spot.taken || !spot.slot) return;
        const countdown = node.querySelector(".countdown");
        const timeEl = node.querySelector(".countdown-time");
        const labelEl = node.querySelector(".countdown-label");

        const deadline = slotDeadline(spot.slot);
        const { text, overdue } = formatDuration(deadline.getTime() - Date.now());

        timeEl.textContent = text;
        countdown.classList.toggle("overdue", overdue);
        labelEl.textContent = overdue ? "Ladeøkt er over" : "Ladeøkt slutter om";
    }

    function renderSummary() {
        const taken = spots.filter((s) => s.taken).length;
        document.getElementById("countTaken").textContent = String(taken);
        document.getElementById("countFree").textContent = String(SPOT_COUNT - taken);
    }

    // ---------- Klokke + tick ----------
    function tick() {
        const now = new Date();
        document.getElementById("clock").textContent = now.toLocaleTimeString("no-NO");

        const nodes = spotsEl.querySelectorAll(".spot");
        nodes.forEach((node) => {
            const id = Number(node.dataset.id);
            const spot = spots.find((s) => s.id === id);
            if (spot) tickSpot(node, spot);
        });
    }

    // ---------- Oppstart ----------
    buildSpots();
    renderSummary();
    tick();
    setInterval(tick, 1000);
})();
