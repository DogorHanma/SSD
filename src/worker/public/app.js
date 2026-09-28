const nameEl       = document.getElementById("serverName");
const portEl       = document.getElementById("serverPort");
const button       = document.getElementById("shutdownBtn");

const statusCard   = document.getElementById("statusCard");
const statusDot    = document.getElementById("statusDot");
const statusText   = document.getElementById("statusText");
const currentParent= document.getElementById("currentParent");
const pulseInfo    = document.getElementById("pulseInfo");
const coordList    = document.getElementById("coordList");
const journalEl    = document.getElementById("journal");

const parentInput  = document.getElementById("parentInput");
const parentBtn    = document.getElementById("parentBtn");
const parentStatus = document.getElementById("parentStatus");

const messageInput = document.getElementById("messageInput");
const sendBtn      = document.getElementById("sendBtn");
const statusEl     = document.getElementById("status");

const loadBar      = document.getElementById("loadBar");
const capList      = document.getElementById("capList");
const activeTaskList    = document.getElementById("activeTaskList");
const completedTaskList = document.getElementById("completedTaskList");

let lastSeq = 0;

function escapeHtml(text) {
    return String(text ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

function setHint(el, text, type) {
    el.innerText = text;
    el.className = `hint ${type || ""}`;
}

function shortUrl(url) {
    return String(url || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

/* ------------------------------------------------------------- estado -- */

async function loadStatus() {
    let data;
    try {
        const res = await fetch("/status");
        data = await res.json();
    } catch {
        statusText.innerText = "Mi worker no responde";
        return;
    }

    nameEl.innerText = `Worker: ${data.name}`;
    portEl.innerText = `Puerto ${data.port} · ${data.publicUrl}`;

    renderStatus(data);
    renderCapabilities(data);
    renderActiveTasks(data);
    renderCompletedTasks(data);
    renderCoordinators(data);
    renderJournal(data);
}

const ESTADOS = {
    conectado:   { clase: "ok",   texto: "Conectado a mi coordinador" },
    buscando:    { clase: "warn", texto: "Mi coordinador se ha caido: buscando otro" },
    redirigido:  { clase: "warn", texto: "Me estan redirigiendo al nuevo lider" },
    "sin lider": { clase: "bad",  texto: "Nadie manda todavia: hay eleccion en curso" },
    arrancando:  { clase: "warn", texto: "Arrancando" }
};

function renderStatus(data) {
    const estado = ESTADOS[data.status] || ESTADOS.arrancando;

    statusCard.className = `status-card ${estado.clase}`;
    statusDot.className  = `dot ${estado.clase}`;
    statusText.innerText = estado.texto;

    currentParent.innerText = shortUrl(data.parent) || "ninguno";

    if (data.status !== "conectado" || data.sincePulse === null) {
        pulseInfo.innerText = "";
        return;
    }

    const segundos = (data.sincePulse / 1000).toFixed(1);
    const tarde    = data.sincePulse > data.pulseInterval * 2;

    pulseInfo.className  = `status-pulse ${tarde ? "late" : ""}`;
    pulseInfo.innerText  = `ultimo pulso hace ${segundos}s (cada ${data.pulseInterval / 1000}s)`;
}

/* ----------------------------------------------------------- capacidades -- */

function renderCapabilities(data) {
    const caps  = data.capabilities || [];
    const load  = data.load || 0;
    const lagMs = data.taskLagMs || 0;

    // Barra de carga
    const pct = Math.round(load * 100);
    loadBar.style.width = `${pct}%`;
    loadBar.className   = `load-fill ${load > 0.7 ? "high" : load > 0.3 ? "mid" : "low"}`;
    loadBar.title       = `Carga: ${pct}%`;

    // Chips de capacidades
    capList.innerHTML = caps.map(c =>
        `<span class="cap-chip">${escapeHtml(c)}</span>`
    ).join("") + (lagMs > 0 ? `<span class="cap-chip lag">lag: ${lagMs}ms</span>` : "");
}

/* -------------------------------------------------------------- tareas activas -- */

function renderActiveTasks(data) {
    const tasks = data.activeTasks || [];

    if (!tasks.length) {
        activeTaskList.innerHTML = `<li class="task-empty">Sin tareas activas</li>`;
        return;
    }

    activeTaskList.innerHTML = tasks.map(t => {
        const elapsed = ((Date.now() - t.startedAt) / 1000).toFixed(1);
        return `<li class="task-item running">
            <span class="task-badge running">corriendo</span>
            <span class="task-id">${escapeHtml(t.taskId)}</span>
            <span class="task-type">${escapeHtml(t.type)}</span>
            <span class="task-time">${elapsed}s</span>
        </li>`;
    }).join("");
}

/* --------------------------------------------------------- historial de tareas -- */

function renderCompletedTasks(data) {
    const tasks = (data.completedTasks || []).slice(0, 20);

    if (!tasks.length) {
        completedTaskList.innerHTML = `<li class="task-empty">Sin historial todavía</li>`;
        return;
    }

    completedTaskList.innerHTML = tasks.map(t => {
        const dur = t.duration ? `${t.duration}ms` : "";
        const ok  = t.status === "ok";
        const preview = ok
            ? escapeHtml(JSON.stringify(t.result).slice(0, 60))
            : escapeHtml(String(t.error || "").slice(0, 60));

        return `<li class="task-item ${ok ? "ok" : "err"}">
            <span class="task-badge ${ok ? "ok" : "err"}">${ok ? "ok" : "error"}</span>
            <span class="task-type">${escapeHtml(t.type)}</span>
            <span class="task-result">${preview}</span>
            ${dur ? `<span class="task-time">${dur}</span>` : ""}
        </li>`;
    }).join("");
}

/* ------------------------------------------------------------ coordinadores -- */

const ROLES = {
    leader:   { etiqueta: "LIDER",       clase: "leader" },
    follower: { etiqueta: "no manda",    clase: "follower" },
    down:     { etiqueta: "no responde", clase: "down" }
};

function renderCoordinators(data) {
    const coordinators = data.coordinators || [];

    if (!coordinators.length) {
        coordList.innerHTML = `<li class="empty">Todavia no conozco a nadie</li>`;
        return;
    }

    coordList.innerHTML = coordinators.map(coordinator => {
        const rol    = ROLES[coordinator.role] || { etiqueta: "no se", clase: "unknown" };
        const actual = coordinator.url === data.parent;

        return `
            <li class="${actual ? "current" : ""}">
                <span class="badge ${rol.clase}">${rol.etiqueta}</span>
                <span class="url">${escapeHtml(coordinator.id || shortUrl(coordinator.url))}</span>
                ${coordinator.id ? `<span class="host">${escapeHtml(shortUrl(coordinator.url))}</span>` : ""}
                ${actual ? '<span class="mine">el mio</span>' : ""}
                ${coordinator.note ? `<span class="note">${escapeHtml(coordinator.note)}</span>` : ""}
            </li>`;
    }).join("");
}

/* --------------------------------------------------------------- diario -- */

const RESALTADOS = ["registro", "caida", "busqueda", "redirect", "tarea"];

function lineaDiario(entry) {
    const veces = entry.repeated > 1 ? ` <em class="repeated">x${entry.repeated}</em>` : "";
    return `<time>${new Date(entry.at).toLocaleTimeString()}</time>` +
           `<span>${escapeHtml(entry.text)}${veces}</span>`;
}

function renderJournal(data) {
    const entries = data.journal || [];
    const ultima  = entries[entries.length - 1];

    if (ultima && ultima.seq === lastSeq && journalEl.lastChild) {
        journalEl.lastChild.innerHTML = lineaDiario(ultima);
    }

    entries
        .filter(entry => entry.seq > lastSeq)
        .forEach(entry => {
            lastSeq = entry.seq;

            const li = document.createElement("li");
            li.className = RESALTADOS.includes(entry.kind) ? `entry ${entry.kind}` : "entry";
            li.innerHTML = lineaDiario(entry);
            journalEl.appendChild(li);
        });

    while (journalEl.children.length > 60) journalEl.removeChild(journalEl.firstChild);
    journalEl.scrollTop = journalEl.scrollHeight;
}

/* ------------------------------------------------------------ acciones -- */

async function switchParent() {
    const url = parentInput.value.trim();
    if (!url) return;

    parentBtn.disabled = true;
    setHint(parentStatus, "Registrando...");

    try {
        const res  = await fetch("/parent", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url })
        });
        const data = await res.json();

        if (res.ok) {
            setHint(parentStatus, `Registrado en ${data.parent}`, "ok");
        } else {
            setHint(parentStatus, data.error || `Error ${res.status}`, "error");
        }
    } catch {
        setHint(parentStatus, "Este mini server no responde", "error");
    }

    parentBtn.disabled = false;
    loadStatus();
}

async function sendMessage() {
    const message = messageInput.value.trim();
    if (!message) return;

    sendBtn.disabled = true;

    try {
        const res = await fetch("/send-message", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message })
        });

        if (res.ok) {
            messageInput.value = "";
            setHint(statusEl, "Enviado al coordinador", "ok");
        } else {
            const err = await res.json();
            setHint(statusEl, err.error || `Error ${res.status}`, "error");
        }
    } catch {
        setHint(statusEl, "Este mini server no responde", "error");
    }

    sendBtn.disabled = false;
}

parentBtn.addEventListener("click", switchParent);
sendBtn.addEventListener("click", sendMessage);

parentInput.addEventListener("keydown", event => {
    if (event.key === "Enter") switchParent();
});

messageInput.addEventListener("keydown", event => {
    if (event.key === "Enter") sendMessage();
});

button.addEventListener("click", async () => {
    button.disabled = true;
    button.innerText = "Shutting down...";
    await fetch("/shutdown", { method: "POST" });
});

loadStatus();
setInterval(loadStatus, 1000);
