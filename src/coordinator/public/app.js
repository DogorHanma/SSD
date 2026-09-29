const input = document.getElementById("nameInput");
const button = document.getElementById("createBtn");
const list = document.getElementById("serverList");
const reloadBtn = document.getElementById("reloadBtn");
const lastUpdate = document.getElementById("lastUpdate");

button.addEventListener("click", createServer);
reloadBtn.addEventListener("click", loadServers);

function escapeHtml(text) {
    return String(text)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

async function createServer() {
    const name = input.value.trim();
    if (!name) return;

    await fetch("/create-server", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
    });

    input.value = "";
    loadServers();
}

async function loadServers() {
    reloadBtn.disabled = true;
    reloadBtn.innerText = "Loading...";

    try {
        await renderServers();
        lastUpdate.innerText = `actualizado ${new Date().toLocaleTimeString()}`;
    } catch {
        lastUpdate.innerText = "no se pudo actualizar";
    }

    reloadBtn.disabled = false;
    reloadBtn.innerText = "Reload";
}

async function renderServers() {
    const res = await fetch("/overview");
    const servers = await res.json();

    list.innerHTML = "";

    servers.forEach(server => {
        const items = server.messages.length
            ? server.messages.map(entry => `
                <li class="message">
                    <span>${escapeHtml(entry.message)}</span>
                    <time>${new Date(entry.at).toLocaleTimeString()}</time>
                </li>
            `).join("")
            : `<li class="message empty">Sin mensajes</li>`;

        const li = document.createElement("li");

        const state = server.online ? "online" : "offline";
        const url = server.url || "";

        li.innerHTML = `
            <div class="server-head">
                <strong>
                    <span class="dot ${state}" title="${state}"></span>
                    ${escapeHtml(server.name)}
                </strong>
                <span class="meta">${server.messages.length} msg</span>
            </div>
            <div class="server-addr">
                <a href="${encodeURI(url)}" target="_blank">${escapeHtml(url || "sin url")}</a>
                <span class="ip">${escapeHtml(server.owner || "?")}</span>
            </div>
            <ul class="messages">${items}</ul>
        `;

        list.appendChild(li);
    });
}

loadServers();

/* ================================================================
   TASK PANEL
   ================================================================ */

const workerSelect = document.getElementById("workerSelect");
const capabilitySelect = document.getElementById("capabilitySelect");
const payloadArea = document.getElementById("payloadArea");
const sendTaskBtn = document.getElementById("sendTaskBtn");
const refreshWorkersBtn = document.getElementById("refreshWorkersBtn");
const refreshTasksBtn = document.getElementById("refreshTasksBtn");
const taskListDiv = document.getElementById("taskList");

let workersData = [];

refreshWorkersBtn.addEventListener("click", loadWorkers);
refreshTasksBtn.addEventListener("click", loadTasks);
workerSelect.addEventListener("change", onWorkerChange);
capabilitySelect.addEventListener("change", onCapabilityChange);
sendTaskBtn.addEventListener("click", sendTask);

// Payload templates para las 6 capacidades del examen + custom
const PAYLOAD_TEMPLATES = {
    // CAP 1: math_compute
    math_compute: {
        fields: [
            { id: "operation", placeholder: "add | sub | mul | div", type: "text", label: "Operación" },
            { id: "a", placeholder: "10", type: "number", label: "Operando A" },
            { id: "b", placeholder: "5", type: "number", label: "Operando B" }
        ],
        build: () => ({
            operation: document.getElementById("field-operation").value.trim(),
            a: parseFloat(document.getElementById("field-a").value),
            b: parseFloat(document.getElementById("field-b").value)
        })
    },
    // CAP 2: http_fetch
    http_fetch: {
        fields: [{ id: "url", placeholder: "https://jsonplaceholder.typicode.com/posts/1", type: "text", label: "URL a consultar" }],
        build: () => ({ url: document.getElementById("field-url").value.trim() })
    },
    // CAP 3: search_text
    search_text: {
        fields: [
            { id: "text", placeholder: "hola mundo hola", type: "text", label: "Texto" },
            { id: "query", placeholder: "hola", type: "text", label: "Búsqueda (query)" }
        ],
        build: () => ({
            text: document.getElementById("field-text").value,
            query: document.getElementById("field-query").value
        })
    },
    // CAP 4: stats_compute
    stats_compute: {
        fields: [{ id: "numbers", placeholder: "1, 2, 3, 4, 5", type: "text", label: "Números (separados por coma)" }],
        build: () => {
            const raw = document.getElementById("field-numbers").value;
            const numbers = raw.split(",").map(n => parseFloat(n.trim())).filter(n => !isNaN(n));
            return { numbers };
        }
    },
    // CAP 5: vector_distance
    vector_distance: {
        fields: [
            { id: "vec-a", placeholder: "0, 0", type: "text", label: "Vector A (x, y)" },
            { id: "vec-b", placeholder: "3, 4", type: "text", label: "Vector B (x, y)" }
        ],
        build: () => {
            const a = document.getElementById("field-vec-a").value.split(",").map(n => parseFloat(n.trim()));
            const b = document.getElementById("field-vec-b").value.split(",").map(n => parseFloat(n.trim()));
            return { a, b };
        }
    },
    // CAP 6: http_latency
    http_latency: {
        fields: [{ id: "url", placeholder: "https://google.com", type: "text", label: "URL a medir" }],
        build: () => ({ url: document.getElementById("field-url").value.trim() })
    }
};

async function loadWorkers() {
    refreshWorkersBtn.disabled = true;
    refreshWorkersBtn.innerText = "Cargando...";

    try {
        const res = await fetch("/task/workers");
        workersData = await res.json();

        workerSelect.innerHTML = `<option value="">— Selecciona un worker (${workersData.length}) —</option>`;
        workersData.forEach(w => {
            const caps = w.capabilities.length ? w.capabilities.join(", ") : "sin caps";
            const loadPct = Math.round(w.load * 100);
            workerSelect.innerHTML += `<option value="${escapeHtml(w.name)}">${escapeHtml(w.name)} (${caps}) [${loadPct}%]</option>`;
        });

        capabilitySelect.innerHTML = `<option value="">— Selecciona un worker primero —</option>`;
        payloadArea.style.display = "none";
        sendTaskBtn.disabled = true;
    } catch (err) {
        workerSelect.innerHTML = `<option value="">Error cargando workers</option>`;
    }

    refreshWorkersBtn.disabled = false;
    refreshWorkersBtn.innerText = "Refresh Workers";
}

function onWorkerChange() {
    const name = workerSelect.value;
    const worker = workersData.find(w => w.name === name);

    if (!worker || !worker.capabilities.length) {
        capabilitySelect.innerHTML = `<option value="">— Sin capacidades —</option>`;
        payloadArea.style.display = "none";
        sendTaskBtn.disabled = true;
        return;
    }

    capabilitySelect.innerHTML = `<option value="">— Selecciona capacidad —</option>`;
    worker.capabilities.forEach(cap => {
        capabilitySelect.innerHTML += `<option value="${escapeHtml(cap)}">${escapeHtml(cap)}</option>`;
    });

    payloadArea.style.display = "none";
    sendTaskBtn.disabled = true;
}

function onCapabilityChange() {
    const cap = capabilitySelect.value;
    const template = PAYLOAD_TEMPLATES[cap];

    if (!template) {
        // Capacidad desconocida: campo JSON genérico
        payloadArea.style.display = "block";
        payloadArea.innerHTML = `
            <label>Payload (JSON)</label>
            <textarea id="field-raw-json" rows="3" placeholder='{"key": "value"}'></textarea>
        `;
        sendTaskBtn.disabled = false;
        return;
    }

    payloadArea.style.display = "block";
    payloadArea.innerHTML = template.fields.map(f => `
        <label>${escapeHtml(f.label || template.label)}</label>
        <input id="field-${f.id}" type="${f.type}" placeholder="${escapeHtml(f.placeholder)}" />
    `).join("");

    sendTaskBtn.disabled = false;
}

async function sendTask() {
    const workerName = workerSelect.value;
    const type = capabilitySelect.value;

    if (!workerName || !type) return;

    const template = PAYLOAD_TEMPLATES[type];
    let payload;

    if (template) {
        payload = template.build();
    } else {
        // Intentar parsear JSON genérico
        const raw = document.getElementById("field-raw-json");
        try {
            payload = raw ? JSON.parse(raw.value || "{}") : {};
        } catch {
            alert("JSON inválido en el payload");
            return;
        }
    }

    sendTaskBtn.disabled = true;
    sendTaskBtn.innerText = "Enviando...";

    try {
        const res = await fetch("/task/send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ workerName, type, payload })
        });

        const data = await res.json();

        if (!res.ok) {
            alert(`Error: ${data.error}`);
        } else {
            // Recargar historial
            setTimeout(loadTasks, 500);
        }
    } catch (err) {
        alert(`Error de red: ${err.message}`);
    }

    sendTaskBtn.disabled = false;
    sendTaskBtn.innerText = "Enviar Tarea";
}

async function loadTasks() {
    try {
        const res = await fetch("/task/list");
        const tasks = await res.json();

        if (!tasks.length) {
            taskListDiv.innerHTML = `<p class="empty-hint">No hay tareas aún.</p>`;
            return;
        }

        taskListDiv.innerHTML = tasks.map(t => {
            const statusClass = t.status === "ok" ? "task-ok"
                : t.status === "error" ? "task-error"
                : t.status === "running" ? "task-running"
                : "task-pending";

            const duration = t.finishedAt
                ? `${((t.finishedAt - t.assignedAt) / 1000).toFixed(1)}s`
                : "en curso...";

            let resultHtml = "";
            if (t.status === "ok" && t.result) {
                resultHtml = `<div class="task-result"><code>${escapeHtml(JSON.stringify(t.result))}</code></div>`;
            } else if (t.status === "error" && t.error) {
                resultHtml = `<div class="task-error-msg">${escapeHtml(t.error)}</div>`;
            }

            return `
                <div class="task-card ${statusClass}">
                    <div class="task-card-head">
                        <span class="task-type">${escapeHtml(t.type)}</span>
                        <span class="task-status-badge ${statusClass}">${escapeHtml(t.status)}</span>
                    </div>
                    <div class="task-card-meta">
                        <span>👤 ${escapeHtml(t.worker)}</span>
                        <span>⏱ ${duration}</span>
                        <span>${new Date(t.assignedAt).toLocaleTimeString()}</span>
                    </div>
                    ${resultHtml}
                    <div class="task-id">${escapeHtml(t.taskId)}</div>
                </div>
            `;
        }).join("");

    } catch {
        taskListDiv.innerHTML = `<p class="empty-hint">Error cargando tareas.</p>`;
    }
}

// Auto-cargar workers y tareas
loadWorkers();
loadTasks();

// Auto-refresh tareas cada 3s
setInterval(loadTasks, 3000);
