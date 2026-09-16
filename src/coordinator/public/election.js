const banner = document.getElementById("banner");
const clusterMeta = document.getElementById("clusterMeta");
const nodesEl = document.getElementById("nodes");
const eventsEl = document.getElementById("events");
const algoButtons = document.getElementById("algoButtons");
const algoFamily = document.getElementById("algoFamily");
const algoSummary = document.getElementById("algoSummary");
const partitionPicker = document.getElementById("partitionPicker");

let algorithms = [];
let lastCluster = null;
let selected = new Set();

function escapeHtml(text) {
    return String(text ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

// Todas las ordenes a otros nodos van por el relay del coordinador local:
// asi el panel nunca hace peticiones cruzadas y funciona igual por ngrok.
async function control(url, path, body) {
    const res = await fetch("/relay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, path, body: body || {} })
    });

    return res.json();
}

function allNodes() {
    return lastCluster ? lastCluster.nodes.filter(node => node.id) : [];
}

/* ------------------------------------------------------------ algoritmos -- */

async function loadAlgorithms() {
    const res = await fetch("/election/algorithms");
    const data = await res.json();

    algorithms = data.available;
    renderAlgorithms(data.active);
}

function renderAlgorithms(active) {
    algoButtons.innerHTML = "";

    // Con un solo algoritmo un "selector" de un boton solo estorba.
    // Vuelve a aparecer solo si alguien registra otra estrategia.
    algoButtons.hidden = algorithms.length < 2;

    algorithms.forEach(algo => {
        const button = document.createElement("button");

        button.className = `algo ${algo.name === active ? "active" : ""}`;
        button.innerText = algo.name;
        button.onclick = () => switchAlgorithm(algo.name);

        algoButtons.appendChild(button);
    });

    const current = algorithms.find(algo => algo.name === active);
    if (!current) return;

    algoFamily.innerText = current.quorum ? `${current.family} · con quorum` : current.family;
    algoFamily.className = `pill ${current.quorum ? "quorum" : ""}`;
    algoSummary.innerText = current.summary;
}

async function switchAlgorithm(name) {
    [...algoButtons.children].forEach(button => { button.disabled = true; });

    // propagate: todo el cluster cambia a la vez, o hablarian idiomas distintos.
    await fetch("/election/algorithm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ algo: name, propagate: true })
    });

    eventsEl.innerHTML = "";
    setTimeout(() => { refresh(); loadAlgorithms(); }, 400);
}

/* --------------------------------------------------------------- cluster -- */

async function refresh() {
    try {
        const res = await fetch("/cluster");
        lastCluster = await res.json();
    } catch {
        banner.className = "banner danger";
        banner.innerText = "Sin conexion con el coordinador local";
        return;
    }

    renderBanner(lastCluster);
    renderNodes(lastCluster);
    renderCounters(lastCluster);
    renderPicker(lastCluster);
}

function renderBanner(cluster) {
    const leaders = cluster.leaders || [];

    clusterMeta.innerText = `${cluster.clusterSize} nodos · algoritmo ${cluster.algorithm}`;

    // Este panel lo sirve UN coordinador y solo sabe lo que ese coordinador
    // sabe. Si matas justo a ese, el panel se queda ciego y parece que el
    // cluster entero se ha parado. No se ha parado: es que estas preguntandole
    // a un muerto. Pasa en clase la primera vez, siempre.
    const self = cluster.nodes.find(node => node.self);

    if (self && self.faults && self.faults.paused) {
        const others = cluster.nodes
            .filter(node => !node.self && node.url)
            .map(node => `<a href="${node.url}/election.html" target="_blank">${escapeHtml(node.id || node.url)}</a>`)
            .join(" · ");

        banner.className = "banner warn";
        banner.innerHTML =
            `Has matado al nodo que sirve ESTE panel (${escapeHtml(self.id)}), asi que ya no ve nada. ` +
            `El cluster sigue vivo. Mira desde otro: ${others}`;
        return;
    }

    if (leaders.length > 1) {
        banner.className = "banner danger";
        banner.innerText =
            `SPLIT-BRAIN: ${leaders.length} lideres a la vez (${leaders.map(l => l.id).join("  y  ")})`;
        return;
    }

    if (leaders.length === 0) {
        banner.className = "banner warn";
        banner.innerText = "Sin lider: eleccion en curso";
        return;
    }

    const leader = leaders[0];
    const extra = leader.term ? ` (term ${leader.term})` : "";

    banner.className = "banner ok";
    banner.innerText = `Lider: ${leader.id}${extra}`;
}

function renderNodes(cluster) {
    nodesEl.innerHTML = "";

    cluster.nodes.forEach(node => {
        const card = document.createElement("div");
        const faults = node.faults || {};

        const classes = ["node"];
        if (!node.reachable) classes.push("unreachable");
        if (faults.paused) classes.push("paused");
        if (node.role) classes.push(node.role);

        card.className = classes.join(" ");

        if (!node.reachable) {
            card.innerHTML = `
                <div class="node-head"><strong>${escapeHtml(node.id || node.url)}</strong><span class="role">sin respuesta</span></div>
                <div class="node-body">${escapeHtml(node.url)}</div>`;
            nodesEl.appendChild(card);
            return;
        }

        const flags = [];
        if (faults.paused) flags.push('<span class="flag">PAUSADO</span>');
        if ((faults.blocked || []).length) flags.push(`<span class="flag">AISLADO DE ${escapeHtml(faults.blocked.join(","))}</span>`);
        if (faults.clockSkew) flags.push(`<span class="flag skew">RELOJ ${faults.clockSkew > 0 ? "+" : ""}${faults.clockSkew}ms</span>`);
        if (faults.latency) flags.push(`<span class="flag slow">+${faults.latency}ms</span>`);
        if (faults.drop) flags.push(`<span class="flag slow">PIERDE ${Math.round(faults.drop * 100)}%</span>`);

        card.innerHTML = `
            <div class="node-head">
                <strong>${escapeHtml(node.id)}</strong>
                <span class="role ${node.role}">${escapeHtml(node.role)}</span>
            </div>
            <div class="node-flags">${flags.join("")}</div>
            <div class="node-body">
                lider: <code>${escapeHtml(node.leader || "ninguno")}</code>
                ${node.term ? `<br />term: <code>${escapeHtml(node.term)}</code>` : ""}
                ${describeStrategy(node)}
            </div>
            ${renderWorkers(node, faults)}
            <div class="node-actions">
                <button class="${faults.paused ? "" : "danger"}" data-action="${faults.paused ? "resume" : "pause"}" data-url="${escapeHtml(node.url)}">
                    ${faults.paused ? "Reanudar" : "Matar"}
                </button>
                <button class="ghost" data-action="heal" data-url="${escapeHtml(node.url)}">Sanar</button>
            </div>`;

        nodesEl.appendChild(card);
    });

    nodesEl.querySelectorAll("button[data-action]").forEach(button => {
        button.onclick = async () => {
            button.disabled = true;

            const target = cluster.nodes.find(node => node.url === button.dataset.url);

            // Matar a un follower no dispara nada, y sin este aviso parece que
            // el panel se ha colgado. La eleccion solo salta si cae EL LIDER.
            if (button.dataset.action === "pause" && target && target.role !== "leader") {
                note(`${target.id} no era el lider: no habra eleccion. Mata al lider para ver el failover.`);
            }

            await control(button.dataset.url, `/debug/${button.dataset.action}`);
            refresh();
        };
    });
}

// Cada algoritmo saca aqui lo suyo: lo que devuelva su describe().
function describeStrategy(node) {
    const s = node.strategyState || {};
    const parts = [];

    if (s.electing !== undefined) parts.push(`eligiendo: <code>${s.electing}</code>`);

    // Campos de cualquier estrategia que anadan despues.
    if (s.votes !== undefined) parts.push(`votos: <code>${s.votes}/${s.needs}</code>`);
    if (s.msToTimeout !== undefined) parts.push(`timeout en <code>${(s.msToTimeout / 1000).toFixed(1)}s</code>`);

    return parts.length ? `<br />${parts.join("<br />")}` : "";
}

// Los workers enganchados a este coordinador. Esta es LA parte que hay que
// mirar en clase: al matar al lider, estas etiquetas saltan solas a otra
// tarjeta. Nadie toca nada; los workers se reenganchan ellos.
function renderWorkers(node, faults) {
    const workers = node.workers || [];

    // Un nodo congelado conserva la lista que tenia al morir. Si no se avisa,
    // parece que los mismos workers estan en dos coordinadores a la vez.
    const stale = faults.paused;

    if (!workers.length) {
        return `<div class="workers empty">sin workers</div>`;
    }

    const badges = workers
        .map(worker => `<span class="worker ${worker.online ? "" : "off"}">${escapeHtml(worker.name)}</span>`)
        .join("");

    return `
        <div class="workers ${stale ? "stale" : ""}">
            ${stale ? '<span class="stale-note">congelado: lista de antes de morir</span>' : ""}
            ${badges}
        </div>`;
}

function renderCounters(cluster) {
    const totals = cluster.nodes.reduce((acc, node) => {
        const counters = node.counters || {};

        acc.protocol += counters.protocol || 0;
        acc.ping += counters.ping || 0;

        Object.entries(counters.byType || {}).forEach(([type, count]) => {
            acc.byType[type] = (acc.byType[type] || 0) + count;
        });

        return acc;
    }, { protocol: 0, ping: 0, byType: {} });

    document.getElementById("msgProtocol").innerText = totals.protocol;
    document.getElementById("msgPing").innerText = totals.ping;

    const types = Object.entries(totals.byType)
        .sort((a, b) => b[1] - a[1])
        .map(([type, count]) => `${type} ${count}`)
        .join("  ·  ");

    document.getElementById("msgTypes").innerText = types || "-";
}

/* ---------------------------------------------------------- herramientas -- */

function renderPicker(cluster) {
    const ids = allNodes().map(node => node.id);
    const signature = ids.join(",");

    if (partitionPicker.dataset.signature === signature) return;
    partitionPicker.dataset.signature = signature;

    partitionPicker.innerHTML = "";

    cluster.nodes.filter(node => node.id).forEach(node => {
        const label = document.createElement("label");

        label.className = selected.has(node.id) ? "on" : "";
        label.innerHTML = `<input type="checkbox" ${selected.has(node.id) ? "checked" : ""} /> ${escapeHtml(node.id)}`;

        label.querySelector("input").onchange = event => {
            if (event.target.checked) selected.add(node.id);
            else selected.delete(node.id);

            label.className = event.target.checked ? "on" : "";
        };

        partitionPicker.appendChild(label);
    });
}

document.getElementById("applyPartition").onclick = async () => {
    const side = [...selected];
    if (!side.length) return;

    const others = allNodes().map(node => node.id).filter(id => !selected.has(id));

    // Cada lado bloquea al otro. La particion tiene que ser simetrica: si solo
    // corta un lado, el otro sigue enviandole y no seria una particion real.
    await Promise.all(allNodes().map(node =>
        control(node.url, "/debug/partition", { block: side.includes(node.id) ? others : side })
    ));

    refresh();
};

document.getElementById("healNetwork").onclick = async () => {
    await Promise.all(allNodes().map(node => control(node.url, "/debug/heal")));
    selected.clear();
    partitionPicker.dataset.signature = "";
    refresh();
};

document.getElementById("applyNetwork").onclick = async () => {
    const ms = Number(document.getElementById("latency").value) || 0;
    const drop = (Number(document.getElementById("drop").value) || 0) / 100;

    await Promise.all(allNodes().flatMap(node => [
        control(node.url, "/debug/latency", { ms, jitter: Math.round(ms / 2) }),
        control(node.url, "/debug/drop", { probability: drop })
    ]));

    refresh();
};

document.getElementById("resetCounters").onclick = async () => {
    await Promise.all(allNodes().map(node => control(node.url, "/debug/reset-counters")));
    refresh();
};

// Mensaje del propio panel en el feed de eventos (no viene del servidor).
function note(text) {
    const li = document.createElement("li");

    li.className = "note";
    li.innerHTML = `<time>${new Date().toLocaleTimeString()}</time>${escapeHtml(text)}`;

    eventsEl.appendChild(li);
    eventsEl.scrollTop = eventsEl.scrollHeight;
}

/* ---------------------------------------------------------------- eventos -- */

const IMPORTANT = ["leader-change", "election-won", "lease-acquired"];
const BAD = ["peer-down", "leader-lost", "fault", "lease-expired", "quorum-lost", "gossip-reset"];

function connectFeed() {
    const source = new EventSource("/events");

    source.onmessage = message => {
        let event;

        try { event = JSON.parse(message.data); } catch { return; }
        if (event.kind === "recv" || event.kind === "send") return;   // demasiado ruido

        const li = document.createElement("li");

        if (IMPORTANT.includes(event.kind)) li.className = "important";
        if (BAD.includes(event.kind)) li.className = "bad";

        const time = new Date(event.at || Date.now()).toLocaleTimeString();
        const detail = Object.entries(event)
            .filter(([key]) => !["seq", "at", "kind"].includes(key))
            .map(([key, value]) => `${key}=${typeof value === "object" ? JSON.stringify(value) : value}`)
            .join(" ");

        li.innerHTML = `<time>${time}</time>${escapeHtml(event.kind)} ${escapeHtml(detail)}`;
        eventsEl.appendChild(li);

        while (eventsEl.children.length > 200) eventsEl.removeChild(eventsEl.firstChild);
        if (document.getElementById("autoscroll").checked) eventsEl.scrollTop = eventsEl.scrollHeight;
    };

    // Si ngrok corta el stream, EventSource reconecta solo; esto es por si
    // el corte fue del lado del servidor y hay que rearmarlo a mano.
    source.onerror = () => {
        source.close();
        setTimeout(connectFeed, 2000);
    };
}

loadAlgorithms();
refresh();
connectFeed();
setInterval(refresh, 1000);

document.getElementById("connectPeerBtn").addEventListener("click", async () => {
    const input = document.getElementById("connectPeerInput");
    const url = input.value.trim();
    if (!url) return;

    try {
        const btn = document.getElementById("connectPeerBtn");
        btn.disabled = true;
        btn.textContent = "...";
        
        // The professor's API expects the URL in the body
        const res = await fetch("/election/peers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url })
        });
        
        const data = await res.json();
        if (res.ok) {
            input.value = "";
            refresh();
        } else {
            alert(data.error || "Error al conectar con el peer");
        }
    } catch (err) {
        alert("Error de red al intentar conectar");
    } finally {
        const btn = document.getElementById("connectPeerBtn");
        btn.disabled = false;
        btn.textContent = "Conectar";
    }
});

document.getElementById("changeIdBtn").addEventListener("click", async () => {
    const input = document.getElementById("changeIdInput");
    const id = input.value.trim().toUpperCase();
    if (!id) return;

    try {
        const btn = document.getElementById("changeIdBtn");
        btn.disabled = true;
        btn.textContent = "...";
        
        const res = await fetch("/election/id", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id })
        });
        
        const data = await res.json();
        if (res.ok) {
            input.value = "";
            refresh();
        } else {
            alert(data.error || "Error al cambiar el ID");
        }
    } catch (err) {
        alert("Error de red al intentar cambiar el ID");
    } finally {
        const btn = document.getElementById("changeIdBtn");
        btn.disabled = false;
        btn.textContent = "Cambiar";
    }
});
