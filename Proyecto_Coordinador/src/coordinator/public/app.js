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

async function loadWorkers() {
    refreshWorkersBtn.disabled = true;
    refreshWorkersBtn.innerText = "Cargando...";

    try {
        const res = await fetch("/task/workers");
        workersData = await res.json();

        workerSelect.innerHTML = `<option value="">— Selecciona un worker (${workersData.length}) —</option>`;
        workersData.forEach(w => {
            // Manejar compatibilidad si el compañero usa strings o la nueva estructura con objetos
            const caps = w.capabilities.length ? w.capabilities.map(c => typeof c === 'string' ? c : c.name).join(", ") : "sin caps";
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
        const capName = typeof cap === 'string' ? cap : cap.name;
        capabilitySelect.innerHTML += `<option value="${escapeHtml(capName)}">${escapeHtml(capName)}</option>`;
    });

    payloadArea.style.display = "none";
    sendTaskBtn.disabled = true;
}

const PAYLOAD_TEMPLATES = {
    math_compute: {
        fields: [
            { id: "operation", type: "select", label: "Operación", options: ["add", "sub", "mul", "div"] },
            { id: "a", placeholder: "10", type: "number", label: "A" },
            { id: "b", placeholder: "5", type: "number", label: "B" }
        ]
    },
    http_fetch: {
        fields: [{ id: "url", placeholder: "https://jsonplaceholder.typicode.com/posts/1", type: "text", label: "URL" }]
    },
    search_text: {
        fields: [
            { id: "text", placeholder: "hola mundo hola", type: "text", label: "Texto" },
            { id: "query", placeholder: "hola", type: "text", label: "Búsqueda (query)" }
        ]
    },
    stats_compute: {
        fields: [{ id: "numbers", placeholder: "1, 2, 3, 4, 5", type: "text", label: "Números (separados por coma)" }]
    },
    vector_distance: {
        fields: [
            { id: "a", placeholder: "0, 0", type: "text", label: "Vector A (x, y)" },
            { id: "b", placeholder: "3, 4", type: "text", label: "Vector B (x, y)" }
        ]
    },
    http_latency: {
        fields: [{ id: "url", placeholder: "https://google.com", type: "text", label: "URL a medir" }]
    },
    sort_numbers: {
        fields: [{ id: "numbers", placeholder: "9, 2, 5, 1, 7", type: "text", label: "Números (separados por coma)" }]
    }
};

function onCapabilityChange() {
    const capName = capabilitySelect.value;
    const workerName = workerSelect.value;
    
    if (!capName || !workerName) {
        payloadArea.style.display = "none";
        sendTaskBtn.disabled = true;
        return;
    }

    const worker = workersData.find(w => w.name === workerName);
    const capability = worker.capabilities.find(c => {
        const cName = typeof c === 'string' ? c : c.name;
        return cName === capName;
    });

    if (!capability) return;
    payloadArea.style.display = "block";
    
    const template = PAYLOAD_TEMPLATES[capName];

    // Soporte para el nuevo estandar de la clase (worker.schemas) y retrocompatibilidad
    const newSchemaObj = (worker.schemas && worker.schemas[capName]) ? worker.schemas[capName] : {};
    const dynamicSchema = newSchemaObj.payload || newSchemaObj.schema || (typeof capability === 'object' ? (capability.schema || capability.payload) : null);

    if (template) {
        // Tarea estándar conocida: pintar formulario bonito
        payloadArea.innerHTML = template.fields.map(f => {
            if (f.type === "select") {
                const options = f.options.map(o => `<option value="${o}">${o}</option>`).join("");
                return `
                    <label>${escapeHtml(f.label)}</label>
                    <select class="dynamic-field known-field" data-key="${escapeHtml(f.id)}">
                        ${options}
                    </select>
                `;
            } else {
                return `
                    <label>${escapeHtml(f.label)}</label>
                    <input class="dynamic-field known-field" data-key="${escapeHtml(f.id)}" type="${escapeHtml(f.type)}" placeholder="${escapeHtml(f.placeholder)}" />
                `;
            }
        }).join("");
    } else if (dynamicSchema && Object.keys(dynamicSchema).length > 0) {
            // Tarea desconocida pero con esquema dinámico provisto por el worker
            payloadArea.innerHTML = Object.entries(dynamicSchema).map(([key, desc]) => `
                <label>${escapeHtml(key)} <small style="color:#888; font-weight:normal;">(${escapeHtml(desc)})</small></label>
                <input class="dynamic-field unknown-field" data-key="${escapeHtml(key)}" type="text" placeholder="Ingresa ${escapeHtml(key)}" />
            `).join("");
        } else {
            // Tarea totalmente desconocida y sin esquema (Fallback a JSON)
            payloadArea.innerHTML = `
                <label>Payload (JSON PARA '${escapeHtml(capName.toUpperCase())}')</label>
                <textarea id="field-raw-json" rows="4">{\n  "key": "value"\n}</textarea>
            `;
        }

    sendTaskBtn.disabled = false;
}

async function sendTask() {
    const workerName = workerSelect.value;
    const type = capabilitySelect.value;

    if (!workerName || !type) return;

    let payload = {};
    const template = PAYLOAD_TEMPLATES[type];

    if (template) {
        // Recolectar datos del formulario bonito
        const fields = document.querySelectorAll(".known-field");
        fields.forEach(f => {
            const key = f.dataset.key;
            let val = f.value.trim();
            if (val === "" && f.placeholder) val = f.placeholder;

            if (type === "math_compute" && (key === "a" || key === "b")) {
                payload[key] = parseFloat(val);
            } else if (type === "stats_compute" || type === "sort_numbers") {
                payload[key] = val.replace(/[\[\]]/g, '').split(",").map(n => parseFloat(n.trim())).filter(n => !isNaN(n));
            } else if (type === "vector_distance") {
                payload[key] = val.replace(/[\[\]]/g, '').split(",").map(n => parseFloat(n.trim())).filter(n => !isNaN(n));
            } else {
                payload[key] = val;
            }
        });
    } else {
        // Recolectar datos dinámicos o JSON
        const unknownFields = document.querySelectorAll(".unknown-field");
        if (unknownFields.length > 0) {
            unknownFields.forEach(field => {
                const key = field.dataset.key;
                let value = field.value.trim();
                try { payload[key] = JSON.parse(value); } catch { payload[key] = value; }
            });
        } else {
            const raw = document.getElementById("field-raw-json");
            try {
                payload = raw ? JSON.parse(raw.value || "{}") : {};
            } catch {
                alert("JSON inválido en el payload");
                return;
            }
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
