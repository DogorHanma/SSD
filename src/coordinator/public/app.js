/* ============================================================
   COORDINADOR PANEL - app.js
   ============================================================ */

// Referencias DOM
const nodeIdEl      = document.getElementById("nodeId");
const nodeUrlEl     = document.getElementById("nodeUrl");
const leaderBanner  = document.getElementById("leaderBanner");
const roleBadge     = document.getElementById("roleBadge");
const leaderCard    = document.getElementById("leaderCard");
const peerList      = document.getElementById("peerList");
const workerList    = document.getElementById("workerList");
const commLog       = document.getElementById("commLog");
const taskResults   = document.getElementById("taskResults");
const eventsEl      = document.getElementById("events");

// Estado local
let lastDashboard = null;
let lastTaskList  = [];

function esc(text) {
    return String(text ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

function shortUrl(url) {
    return String(url || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function hint(el, text, type) {
    el.textContent = text;
    el.className   = "status-hint" + (type ? ` ${type}` : "");
}

/* ===== DASHBOARD ===== */

async function loadDashboard() {
    try {
        const res = await fetch("/dashboard");
        lastDashboard = await res.json();
    } catch { return; }

    renderHeader(lastDashboard);
    renderLeader(lastDashboard);
    renderPeers(lastDashboard);
    renderWorkers(lastDashboard);
    renderCommLog(lastDashboard);
}

async function loadTaskResults() {
    try {
        const res = await fetch("/task/results");
        lastTaskList = await res.json();
        renderTasks(lastTaskList);
    } catch { /* silencioso */ }
}

function renderHeader(data) {
    const self = data.self || {};
    nodeIdEl.textContent  = self.id  || "Coordinador";
    nodeUrlEl.textContent = self.url || "";

    const role  = self.role || "follower";
    roleBadge.textContent  = role;
    roleBadge.className    = `role-badge ${role}`;

    const leader = self.leader;

    if (!leader) {
        leaderBanner.textContent = "Sin líder · elección en curso";
        leaderBanner.className   = "leader-banner warn";
    } else if (leader.id === self.id) {
        leaderBanner.textContent = `👑 Soy el líder (ID: ${leader.id})`;
        leaderBanner.className   = "leader-banner ok";
    } else {
        leaderBanner.textContent = `Líder: ${leader.id}`;
        leaderBanner.className   = "leader-banner ok";
    }
}

function renderLeader(data) {
    const leader = data.self && data.self.leader;

    if (!leader) {
        leaderCard.innerHTML = `<p class="empty-state">Sin líder conocido</p>`;
        leaderCard.className = "leader-card no-leader";
        return;
    }

    leaderCard.className = "leader-card";
    leaderCard.innerHTML = `
        <div class="ldr-id">👑 ${esc(leader.id)}</div>
        <div class="ldr-url">${esc(leader.url || "")}</div>
        <div class="ldr-prio">Prioridad: <strong>${leader.priority}</strong></div>`;
}

function renderPeers(data) {
    const peers = data.peers || [];

    if (!peers.length) {
        peerList.innerHTML = `<li class="empty-state">Ningún coordinador conocido</li>`;
        return;
    }

    peerList.innerHTML = peers.map(p => `
        <li class="peer-item ${p.alive ? "alive" : "dead"}">
            <span class="peer-dot"></span>
            <div class="peer-info">
                <div class="peer-id">${esc(p.id || "—")}</div>
                <div class="peer-url">${esc(shortUrl(p.url))}</div>
            </div>
        </li>`).join("");
}

function renderWorkers(data) {
    const workers = data.workers || [];

    if (!workers.length) {
        workerList.innerHTML = `<li class="empty-state">Ningún worker registrado</li>`;
        return;
    }

    workerList.innerHTML = workers.map(w => `
        <li class="worker-item ${w.online ? "online" : "offline"}">
            <span class="w-dot"></span>
            <span class="w-name">${esc(w.name)}</span>
            <span class="w-msgs">${(w.messages || []).length} msg</span>
        </li>`).join("");
}

function renderTasks(tasks) {
    if (!tasks || !tasks.length) {
        taskResults.innerHTML = `<li class="empty-state">Sin tareas aún</li>`;
        return;
    }

    taskResults.innerHTML = tasks.slice(0, 30).map(t => {
        const status = t.status || "pending";
        const dur    = t.duration ? `${t.duration}ms` : "";
        const time   = t.assignedAt ? new Date(t.assignedAt).toLocaleTimeString() : "";

        let detail = "";
        if (status === "ok")      detail = `<div class="tr-result">${esc(JSON.stringify(t.result).slice(0, 80))}</div>`;
        if (status === "error")   detail = `<div class="tr-error">${esc(t.error || "")}</div>`;
        if (status === "running") detail = `<div class="tr-error" style="color:var(--blue)">Ejecutando...</div>`;

        return `<li class="task-result-item ${status}">
            <span class="tr-badge ${status}">${status}</span>
            <div class="tr-info">
                <div class="tr-type">${esc(t.type)}</div>
                <div class="tr-worker">worker: ${esc(t.workerName || "—")} ${dur ? `· ${dur}` : ""}</div>
                ${detail}
            </div>
            <span class="tr-time">${esc(time)}</span>
        </li>`;
    }).join("");
}

/* ===== LOG DE COMUNICACION ===== */

const TYPE_COLORS = {
    hello:           "hello",
    welcome:         "welcome",
    ping:            "ping",
    pong:            "pong",
    "leader-announce": "leader-announce"
};

function renderCommLog(data) {
    const entries = data.commLog || [];

    if (!entries.length) {
        commLog.innerHTML = `<li class="empty-state">Sin mensajes intercambiados aún</li>`;
        return;
    }

    commLog.innerHTML = entries.slice(0, 40).map(e => {
        const time    = new Date(e.at).toLocaleTimeString();
        const typeClass = TYPE_COLORS[e.type] || "";
        const withStr = e.with && e.with !== "all-peers"
            ? shortUrl(e.with)
            : (e.with || "—");

        return `<li class="comm-entry">
            <span class="comm-time">${esc(time)}</span>
            <span class="comm-dir ${e.direction}">${e.direction === "sent" ? "→" : "←"}</span>
            <span class="comm-type ${typeClass}">${esc(e.type)}</span>
            <span class="comm-with">${esc(withStr)}</span>
        </li>`;
    }).join("");
}

/* ===== ACCIONES ===== */

// Conectar a un coordinador externo
document.getElementById("connectBtn").addEventListener("click", async () => {
    const url = document.getElementById("connectUrl").value.trim();
    const statusEl = document.getElementById("connectStatus");

    if (!url) return;

    hint(statusEl, "Enviando hello...");

    try {
        const res  = await fetch("/coordinator/connect", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ url })
        });
        const data = await res.json();

        if (res.ok) {
            hint(statusEl, `✓ Conectado. Peers conocidos: ${(data.peers || []).length}`, "ok");
            document.getElementById("connectUrl").value = "";
            loadDashboard();
        } else {
            hint(statusEl, data.error || `Error ${res.status}`, "error");
        }
    } catch {
        hint(statusEl, "No se pudo conectar", "error");
    }
});

// Crear worker local
document.getElementById("createWorkerBtn").addEventListener("click", async () => {
    const name     = document.getElementById("workerName").value.trim();
    const statusEl = document.getElementById("workerCreateStatus");

    if (!name) return;

    hint(statusEl, "Creando worker...");

    try {
        const res  = await fetch("/create-server", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ name })
        });
        const data = await res.json();

        if (res.ok) {
            hint(statusEl, `✓ ${data.message}`, "ok");
            document.getElementById("workerName").value = "";
            loadDashboard();
        } else {
            hint(statusEl, data.error || `Error ${res.status}`, "error");
        }
    } catch {
        hint(statusEl, "Error al crear el worker", "error");
    }
});

// Asignar tarea
document.getElementById("assignTaskBtn").addEventListener("click", async () => {
    const type      = document.getElementById("taskType").value;
    const rawPayload= document.getElementById("taskPayload").value.trim();
    const statusEl  = document.getElementById("taskStatus");

    let payload = {};
    if (rawPayload) {
        try { payload = JSON.parse(rawPayload); }
        catch { hint(statusEl, "El payload no es JSON válido", "error"); return; }
    }

    hint(statusEl, "Asignando tarea...");
    document.getElementById("assignTaskBtn").disabled = true;

    try {
        const res  = await fetch("/task/assign", {
            method:  "POST",
            headers: { "Content-Type": "application/json" },
            body:    JSON.stringify({ type, payload })
        });
        const data = await res.json();

        if (res.ok) {
            hint(statusEl, `✓ Tarea asignada a ${data.worker} (ID: ${data.taskId})`, "ok");
        } else {
            hint(statusEl, data.error || `Error ${res.status}`, "error");
        }
    } catch {
        hint(statusEl, "Error al asignar la tarea", "error");
    }

    document.getElementById("assignTaskBtn").disabled = false;
    loadTaskResults();
});


/* ===== EVENTOS SSE (motor interno) ===== */

const IMPORTANT = ["leader-change", "election-won"];
const BAD       = ["peer-down", "leader-lost", "fault"];

function connectFeed() {
    const source = new EventSource("/events");

    source.onmessage = msg => {
        let event;
        try { event = JSON.parse(msg.data); } catch { return; }

        // Filtrar los más ruidosos
        if (event.kind === "recv" || event.kind === "send") return;

        const li   = document.createElement("li");
        const time = new Date(event.at || Date.now()).toLocaleTimeString();

        if (IMPORTANT.includes(event.kind)) li.className = "important";
        if (BAD.includes(event.kind))       li.className = "bad";

        const detail = Object.entries(event)
            .filter(([k]) => !["seq", "at", "kind"].includes(k))
            .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
            .join(" ");

        li.innerHTML = `<time>${time}</time><span>${esc(event.kind)} ${esc(detail)}</span>`;
        eventsEl.appendChild(li);

        while (eventsEl.children.length > 200) eventsEl.removeChild(eventsEl.firstChild);
        if (document.getElementById("autoscroll").checked) eventsEl.scrollTop = eventsEl.scrollHeight;
    };

    source.onerror = () => { source.close(); setTimeout(connectFeed, 2000); };
}

/* ===== PAYLOAD DEFAULTS ===== */

document.getElementById("taskType").addEventListener("change", function() {
    const defaults = {
        stats_compute: '{"numbers": [5, 3, 8, 1, 9]}',
        http_fetch:    '{"url": "https://httpbin.org/get"}',
        sort_numbers:  '{"numbers": [5, 3, 8, 1, 9], "order": "asc"}'
    };
    document.getElementById("taskPayload").value = defaults[this.value] || "";
});

// Trigger default on load
document.getElementById("taskPayload").value = '{"numbers": [5, 3, 8, 1, 9]}';

/* ===== INIT ===== */

loadDashboard();
loadTaskResults();
connectFeed();

setInterval(loadDashboard,    2000);
setInterval(loadTaskResults,  3000);
