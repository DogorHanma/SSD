// PROTOCOLO DEL EXAMEN - Comunicacion entre coordinadores
// Implementa los mensajes: hello, welcome, ping, pong, leader-announce
// Este modulo convive con el motor Bully existente.
// La eleccion interna sigue funcionando con Bully; este protocolo
// es la capa de presentacion que el examen exige para interoperar.

const axios = require("axios");
const log   = require("../utils/logger");

const HEADERS = { "ngrok-skip-browser-warning": "true" };
const TIMEOUT = 5000;

// Estado del protocolo del examen (separado del engine interno)
const state = {
    id:       null,   // NODE_ID del .env
    url:      null,   // PUBLIC_URL del .env
    priority: null,   // numero: ID numerico o timestamp de arranque
    peers:    new Map(), // url -> { id, url, alive, lastSeen }
    leader:   null,   // { id, url, priority }
};

// Log de comunicacion (para la UI)
const commLog = [];
const MAX_LOG = 100;

function addLog(direction, type, withId, detail) {
    const entry = {
        at: Date.now(),
        direction,   // "sent" | "received"
        type,
        with: withId,
        detail: detail || {}
    };
    commLog.unshift(entry);
    if (commLog.length > MAX_LOG) commLog.pop();
    return entry;
}

/* ----------------------------------------------------------------- init -- */

function init({ id, url }) {
    state.id  = id;
    state.url = url;
    // Prioridad = timestamp de arranque (cuanto mas antiguo = prioridad mas alta)
    // O el NODE_ID si es numerico.
    const numId = Number(id);
    state.priority = isNaN(numId) ? Date.now() : numId * 1000;
    log("INFO", `[ExamProtocol] Iniciado. ID=${id}, prioridad=${state.priority}`);

    // Regla del examen: leader-announce al arrancar
    setTimeout(() => broadcastLeaderAnnounce(), 500);
}

/* -------------------------------------------------------------- helpers -- */

function cleanUrl(url) {
    return String(url || "").trim().replace(/\/+$/, "");
}

function mySnapshot() {
    return {
        id:       state.id,
        url:      state.url,
        priority: state.priority,
        leader:   state.leader,
        peers:    [...state.peers.values()].map(p => ({
            id: p.id, url: p.url, alive: p.alive
        }))
    };
}

async function post(url, path, body) {
    try {
        const res = await axios.post(`${cleanUrl(url)}${path}`, body, {
            timeout: TIMEOUT,
            headers: HEADERS
        });
        return res.data;
    } catch (err) {
        const status = err.response ? err.response.status : "NET";
        log("WARN", `[ExamProtocol] POST ${url}${path} -> ${status}: ${err.message}`);
        return null;
    }
}

/* ---------------------------------------------------------- peers mgmt -- */

function addPeer(url, id) {
    const key = cleanUrl(url);
    if (!key || key === state.url) return null;

    if (!state.peers.has(key)) {
        state.peers.set(key, { url: key, id: id || null, alive: false, lastSeen: 0 });
        log("INFO", `[ExamProtocol] Peer conocido: ${id || key}`);
    }

    const peer = state.peers.get(key);
    if (id) peer.id = id;
    return peer;
}

function markAlive(url, id) {
    const peer = addPeer(url, id);
    if (peer) {
        peer.alive = true;
        peer.lastSeen = Date.now();
    }
    return peer;
}

/* ------------------------------------------------------- hello / welcome -- */

// Envio: yo me presento a otro coordinador
async function sendHello(targetUrl) {
    const body = {
        type: "hello",
        data: { id: state.id, url: state.url }
    };

    log("INFO", `[ExamProtocol] -> hello a ${targetUrl}`);
    addLog("sent", "hello", targetUrl, { id: state.id });

    const response = await post(targetUrl, "/coordinator/message", body);
    if (!response) return null;

    // Procesar el welcome que viene de vuelta
    if (response.type === "welcome") {
        handleWelcome(response.data, targetUrl);
    }

    return response;
}

// Recibo: alguien me dice hello -> respondo con welcome
function handleHello(data) {
    const { id, url } = data;
    addLog("received", "hello", id || url, data);
    markAlive(url, id);

    // Si el recien llegado tiene prioridad mas alta que el lider actual, se postulara el solo.
    // Nosotros le damos la bienvenida con la info actual y dejamos que el protocolo actue.
    const welcome = {
        type: "welcome",
        data: {
            id:         state.id,
            knownPeers: [...state.peers.values()].map(p => ({ id: p.id, url: p.url })),
            leader:     state.leader
        }
    };

    addLog("sent", "welcome", id || url, welcome.data);
    log("INFO", `[ExamProtocol] <- welcome a ${id || url}`);

    // Conectarse a los nuevos peers que el recien llegado NO conocia aun.
    // (En la respuesta HTTP devolvemos el welcome; el hello lo lanzamos async)
    setTimeout(() => sendHelloToNewPeers([{ id, url }]), 100);

    return welcome;
}

// Recibo: alguien me manda welcome con lista de peers y lider
function handleWelcome(data, fromUrl) {
    const { id, knownPeers, leader } = data;
    addLog("received", "welcome", id || fromUrl, data);

    markAlive(fromUrl, id);

    // Aprendo a los peers que el me cuenta
    (knownPeers || []).forEach(p => addPeer(p.url, p.id));

    // Actualizo el lider si el que me dicen tiene mayor prioridad
    if (leader) {
        updateLeaderIfBetter(leader);
    }

    // Me conecto a los nuevos peers que acabo de conocer
    sendHelloToNewPeers(knownPeers || []);
}

async function sendHelloToNewPeers(peers) {
    for (const p of peers) {
        const key = cleanUrl(p.url);
        if (!key || key === state.url) continue;

        const existing = state.peers.get(key);
        if (existing && existing.alive) continue; // ya lo conozco y responde

        await sendHello(key);
    }
}

/* --------------------------------------------------------- ping / pong -- */

async function sendPing(targetUrl) {
    const body = {
        type: "ping",
        data: { id: state.id, url: state.url, message: "ping de tin" }
    };

    addLog("sent", "ping", targetUrl, {});

    const response = await post(targetUrl, "/coordinator/message", body);

    const peer = state.peers.get(cleanUrl(targetUrl));

    if (response && response.type === "pong") {
        addLog("received", "pong", targetUrl, {});
        if (peer) {
            const wasAlive = peer.alive;
            peer.alive    = true;
            peer.lastSeen = Date.now();

            if (!wasAlive) {
                log("INFO", `[ExamProtocol] Peer recuperado: ${peer.id || targetUrl}`);
            }
        }
        return true;
    }

    // Sin respuesta
    if (peer) {
        const retries = (peer._retries || 0) + 1;
        peer._retries = retries;

        if (retries >= 3 && peer.alive) {
            peer.alive = false;
            log("WARN", `[ExamProtocol] Peer caido tras ${retries} intentos: ${peer.id || targetUrl}`);

            // Si era el lider, todos nos postulamos
            if (state.leader && state.leader.url === cleanUrl(targetUrl)) {
                log("WARN", `[ExamProtocol] El lider cayo. Me postulo.`);
                setTimeout(() => broadcastLeaderAnnounce(), 200);
            }
        }
    }

    return false;
}

function handlePing(data) {
    const { id, url } = data;
    addLog("received", "ping", id || url, {});
    markAlive(url, id);

    const pong = {
        type: "pong",
        data: { id: state.id, url: state.url, message: "pong de tan" }
    };

    addLog("sent", "pong", id || url, {});
    return pong;
}

/* --------------------------------------------------- leader-announce -- */

function updateLeaderIfBetter(candidate) {
    const candidatePriority = Number(candidate.priority) || 0;
    const currentPriority   = state.leader ? Number(state.leader.priority) || 0 : -1;

    if (candidatePriority > currentPriority) {
        state.leader = {
            id:       candidate.leaderId || candidate.id,
            url:      candidate.leaderUrl || candidate.url,
            priority: candidatePriority
        };
        log("INFO", `[ExamProtocol] Nuevo lider aceptado: ${state.leader.id} (prio ${state.leader.priority})`);
        return true;
    }
    return false;
}

// Yo me postulo como lider y propago
async function broadcastLeaderAnnounce() {
    const announcement = {
        type: "leader-announce",
        data: {
            leaderId:   state.id,
            leaderUrl:  state.url,
            priority:   state.priority
        }
    };

    // Me acepto a mi mismo primero
    state.leader = { id: state.id, url: state.url, priority: state.priority };

    log("INFO", `[ExamProtocol] Me postulo como lider (prio ${state.priority})`);
    addLog("sent", "leader-announce", "all-peers", announcement.data);

    // Propago a todos los peers conocidos
    const sends = [...state.peers.values()].map(peer =>
        post(peer.url, "/coordinator/message", announcement)
    );

    await Promise.allSettled(sends);
}

// Recibo un leader-announce de otro nodo
function handleLeaderAnnounce(data, fromId) {
    const { leaderId, leaderUrl, priority } = data;
    addLog("received", "leader-announce", fromId || leaderId, data);

    const candidatePriority = Number(priority) || 0;
    const currentPriority   = state.leader ? Number(state.leader.priority) || 0 : -1;

    if (candidatePriority > currentPriority) {
        // Acepto al nuevo lider
        state.leader = { id: leaderId, url: leaderUrl, priority: candidatePriority };
        log("INFO", `[ExamProtocol] Lider aceptado: ${leaderId} (prio ${candidatePriority})`);

        // Propago a mis peers (excepto de quien lo recibi)
        const announcement = { type: "leader-announce", data };
        [...state.peers.values()]
            .filter(p => p.url !== cleanUrl(leaderUrl) && p.id !== fromId)
            .forEach(p => post(p.url, "/coordinator/message", announcement));

        return true;
    }

    // Mi lider actual es mejor: me postulo yo
    if (currentPriority > candidatePriority && state.leader && state.leader.id === state.id) {
        setTimeout(() => broadcastLeaderAnnounce(), 100);
    }

    return false;
}

/* ----------------------------------------------- router principal -- */

// Punto de entrada: recibe CUALQUIER mensaje del protocolo del examen
function handleMessage(body) {
    const { type, data } = body || {};

    if (!type || !data) {
        return { type: "error", data: { message: "Formato invalido: se esperaba { type, data }" } };
    }

    switch (type) {
        case "hello":          return handleHello(data);
        case "ping":           return handlePing(data);
        case "leader-announce":
            handleLeaderAnnounce(data, data.leaderId);
            return { type: "ok", data: { accepted: true } };
        default:
            return { type: "error", data: { message: `Tipo desconocido: ${type}` } };
    }
}

/* ---------------------------------------------------- heartbeat loop -- */

let pingLoop = null;

function startHeartbeat(intervalMs) {
    stopHeartbeat();
    const every = intervalMs || 2000;

    pingLoop = setInterval(async () => {
        for (const peer of state.peers.values()) {
            await sendPing(peer.url);
        }
    }, every);

    log("INFO", `[ExamProtocol] Heartbeat iniciado (cada ${every}ms)`);
}

function stopHeartbeat() {
    if (pingLoop) { clearInterval(pingLoop); pingLoop = null; }
}

/* --------------------------------------------------------------- exports -- */

module.exports = {
    init,
    handleMessage,
    sendHello,
    broadcastLeaderAnnounce,
    startHeartbeat,
    stopHeartbeat,
    addPeer,
    getState:   () => ({ ...state, peers: [...state.peers.values()] }),
    getCommLog: () => commLog,
    mySnapshot
};
