const timingPresets = require("./timing");
const transport = require("./transport");
const faults = require("./faults");
const events = require("./events");
const ids = require("./ids");
const strategies = require("./strategies");
const log = require("../utils/logger");

const state = {
    id: null,
    url: null,
    algo: null,
    role: "follower",      // follower | candidate | leader
    leader: null,          // id del lider conocido
    leaderUrl: null,
    term: 0,               // term / epoch / ballot, segun el algoritmo
    fencingToken: 0,       // solo lo usa lease
    startedAt: Date.now()
};

const peers = new Map();   // url -> { url, id, lastSeen, alive }
const timers = new Map();

let timing = timingPresets.get("wan");
let strategy = null;
let ctx = null;
let tickHandle = null;
let pingHandle = null;
let algoLocked = false;    // true en cuanto alguien conmuta a mano
let dataVersionFn = () => 0;
let workersFn = () => [];

/* ---------------------------------------------------------------- peers -- */

function addPeer(url) {
    const clean = String(url || "").trim().replace(/\/+$/, "");

    if (!clean) return null;
    if (clean === state.url) return null;
    if (peers.has(clean)) return peers.get(clean);

    const peer = { url: clean, id: null, lastSeen: 0, alive: false };
    peers.set(clean, peer);

    log("INFO", `Peer anadido: ${clean}`);
    events.emit({ kind: "peer-added", url: clean });

    return peer;
}

function removePeer(url) {
    return peers.delete(String(url || "").replace(/\/+$/, ""));
}

function peerById(id) {
    for (const peer of peers.values()) {
        if (peer.id && String(peer.id) === String(id)) return peer;
    }
    return null;
}

function alivePeers() {
    return [...peers.values()].filter(peer => peer.alive && peer.id);
}

// El quorum se calcula sobre el cluster CONFIGURADO, no sobre el alcanzable.
// Si se calculara sobre los vivos, el lado minoritario de una particion
// tendria su propia "mayoria" y elegiria lider: justo lo que hay que evitar.
function clusterSize() {
    return peers.size + 1;
}

function quorum() {
    return Math.floor(clusterSize() / 2) + 1;
}

// Todos los nodos conocidos con id resuelto (incluido yo), ordenados.
function allNodes() {
    const list = [{ id: state.id, url: state.url, self: true, alive: true }];

    peers.forEach(peer => {
        if (peer.id) list.push({ id: peer.id, url: peer.url, self: false, alive: peer.alive });
    });

    return list.sort((a, b) => ids.compare(a.id, b.id));
}

/* ------------------------------------------------------------ liderazgo -- */

function announceLeader(previous) {
    if (previous === state.leader) return;

    log("INFO", `Lider ahora: ${state.leader || "ninguno"} (term ${state.term}, algo ${state.algo})`);
    events.emit({ kind: "leader-change", leader: state.leader, term: state.term, role: state.role });
}

function becomeLeader() {
    const previous = state.leader;

    state.role = "leader";
    state.leader = state.id;
    state.leaderUrl = state.url;

    announceLeader(previous);
}

function becomeFollower(leaderId) {
    const previous = state.leader;
    const peer = leaderId ? peerById(leaderId) : null;

    state.role = "follower";
    state.leader = leaderId || null;
    state.leaderUrl = String(leaderId) === String(state.id) ? state.url : (peer ? peer.url : null);

    announceLeader(previous);
}

function becomeCandidate() {
    state.role = "candidate";
    events.emit({ kind: "candidate", node: state.id, term: state.term });
}

function stepDown() {
    const previous = state.leader;

    state.role = "follower";
    state.leader = null;
    state.leaderUrl = null;

    announceLeader(previous);
}

/* -------------------------------------------------------------- mensajes -- */

function send(target, type, payload) {
    const peer = typeof target === "object" ? target : peerById(target);
    if (!peer) return;

    const envelope = {
        algo: state.algo,
        type,
        from: { id: state.id, url: state.url },
        term: state.term,
        payload: payload || {},
        sentAt: faults.now()
    };

    // Sin await: los algoritmos son de paso de mensajes asincrono.
    // Las respuestas llegan como mensajes entrantes, no como valor de retorno.
    transport.send(peer, envelope, timing.rpcTimeout);
}

function broadcast(type, payload, filter) {
    peers.forEach(peer => {
        if (!peer.id) return;
        if (filter && !filter(peer)) return;
        send(peer, type, payload);
    });
}

function handleMessage(envelope) {
    if (faults.state.paused) return { ok: false, reason: "paused" };

    const fromId = envelope && envelope.from ? envelope.from.id : null;

    if (!faults.canTalkTo(fromId)) return { ok: false, reason: "partitioned" };
    if (!strategy) return { ok: false, reason: "no-strategy" };

    // Mensaje de un algoritmo que ya no esta activo: se descarta.
    if (envelope.algo && envelope.algo !== state.algo) {
        return { ok: false, reason: "stale-algorithm", algo: state.algo };
    }

    events.count(envelope.type, "received");
    events.emit({ kind: "recv", from: fromId, to: state.id, type: envelope.type, term: envelope.term });

    // Cualquier mensaje es prueba de vida del emisor.
    if (envelope.from && envelope.from.url) {
        const peer = addPeer(envelope.from.url) || peers.get(envelope.from.url);
        if (peer) {
            peer.id = peer.id || fromId;
            peer.lastSeen = Date.now();
            peer.alive = true;
        }
    }

    try {
        strategy.onMessage(ctx, envelope);
    } catch (err) {
        log("ERROR", `Estrategia ${state.algo} fallo con ${envelope.type}: ${err.message}`);
    }

    return { ok: true };
}

/* ------------------------------------------------- deteccion de fallos -- */

function handlePing(body) {
    if (faults.state.paused) return null;

    const fromId = body && body.from ? body.from.id : null;
    if (!faults.canTalkTo(fromId)) return null;

    if (body && body.from && body.from.url) {
        const peer = addPeer(body.from.url) || peers.get(body.from.url);
        if (peer) {
            peer.id = body.from.id;
            peer.lastSeen = Date.now();
            peer.alive = true;
        }
    }

    // Auto-ensamblado: aprendo los peers que conoce quien me pinga. Asi basta
    // con que todos apunten a una semilla para que la malla se forme sola.
    (body && body.peers ? body.peers : []).forEach(addPeer);

    events.count("__ping", "received");

    return snapshot();
}

async function pingPeer(peer) {
    if (!faults.canTalkTo(peer.id)) return;

    const body = {
        from: { id: state.id, url: state.url },
        peers: [...peers.keys(), state.url],
        algo: state.algo
    };

    events.count("__ping", "sent");

    try {
        const res = await transport.post(peer.url, "/election/ping", body, timing.rpcTimeout);
        if (!res) return;

        const wasAlive = peer.alive;

        peer.id = res.id || peer.id;
        peer.lastSeen = Date.now();
        peer.alive = true;
        peer.snapshot = res;      // cache para /cluster

        (res.peers || []).map(item => (typeof item === "string" ? item : item.url)).forEach(addPeer);

        // Un nodo que arranca tarde adopta el algoritmo que ya corre el cluster.
        if (!algoLocked && res.algo && res.algo !== state.algo && strategies.has(res.algo)) {
            log("INFO", `Adoptando el algoritmo del cluster: ${res.algo}`);
            setAlgorithm(res.algo, false);
        }

        if (!wasAlive) {
            events.emit({ kind: "peer-up", node: peer.id || peer.url });
            if (strategy && strategy.onPeerRecovered) strategy.onPeerRecovered(ctx, peer.id);
        }

    } catch {
        // El timeout se evalua en checkSuspicions, no aqui: un fallo suelto
        // no es una caida, es solo un fallo suelto.
    }
}

function checkSuspicions() {
    const now = Date.now();

    peers.forEach(peer => {
        if (!peer.alive) return;
        if (now - peer.lastSeen <= timing.suspect) return;

        peer.alive = false;

        log("WARN", `Peer [${peer.id || peer.url}] sospechoso de caida`);
        events.emit({ kind: "peer-down", node: peer.id || peer.url });

        if (state.leader && peer.id && String(peer.id) === String(state.leader)) {
            events.emit({ kind: "leader-lost", node: peer.id });
            stepDown();
        }

        if (strategy && strategy.onPeerSuspected) {
            try {
                strategy.onPeerSuspected(ctx, peer.id);
            } catch (err) {
                log("ERROR", `onPeerSuspected fallo: ${err.message}`);
            }
        }
    });
}

/* ---------------------------------------------------------------- ciclo -- */

function tick() {
    checkSuspicions();

    if (!strategy || faults.state.paused) return;

    try {
        strategy.onTick(ctx);
    } catch (err) {
        log("ERROR", `Tick de ${state.algo} fallo: ${err.message}`);
    }
}

function pingRound() {
    if (faults.state.paused) return;
    peers.forEach(peer => pingPeer(peer));
}

/* ----------------------------------------------------------- algoritmo -- */

function clearTimers() {
    timers.forEach(handle => clearTimeout(handle));
    timers.clear();
}

function setAlgorithm(name, propagate) {
    if (!strategies.has(name)) throw new Error(`Algoritmo desconocido: ${name}`);

    if (strategy && strategy.teardown) {
        try { strategy.teardown(ctx); } catch { /* nos vamos igual */ }
    }

    clearTimers();

    state.algo = name;
    state.role = "follower";
    state.leader = null;
    state.leaderUrl = null;
    state.term = 0;
    state.fencingToken = 0;

    strategy = strategies.get(name);
    ctx.state = {};   // estado privado de la estrategia, en limpio

    events.resetCounters();
    events.emit({ kind: "algorithm", algo: name });
    log("INFO", `Algoritmo de eleccion: ${name}`);

    if (propagate) algoLocked = true;

    try {
        strategy.init(ctx);
    } catch (err) {
        log("ERROR", `init de ${name} fallo: ${err.message}`);
    }

    if (propagate) {
        peers.forEach(peer => {
            transport
                .post(peer.url, "/election/algorithm", { algo: name, propagate: false }, timing.rpcTimeout)
                .catch(() => log("WARN", `No pude propagar el algoritmo a ${peer.url}`));
        });
    }

    return name;
}

/* ------------------------------------------------------------ contexto -- */

function buildContext() {
    return {
        self: { id: state.id, url: state.url },
        state: {},
        timing,

        peers: () => [...peers.values()],
        alivePeers,
        allNodes,
        peerById,
        clusterSize,
        quorum,
        alive: id => {
            if (String(id) === String(state.id)) return true;
            const peer = peerById(id);
            return Boolean(peer && peer.alive);
        },

        // Anillo logico: sucesor vivo sobre los ids ordenados. Saltarse a los
        // muertos es lo que permite que el anillo siga girando cuando alguien cae.
        ring: () => {
            const nodes = allNodes().filter(node => node.self || node.alive);
            const index = nodes.findIndex(node => node.self);

            return {
                nodes,
                successor: () => (nodes.length < 2 ? null : nodes[(index + 1) % nodes.length]),
                predecessor: () => (nodes.length < 2 ? null : nodes[(index - 1 + nodes.length) % nodes.length])
            };
        },

        send,
        broadcast,

        becomeLeader,
        becomeFollower,
        becomeCandidate,
        stepDown,

        get role() { return state.role; },
        get leader() { return state.leader; },
        get term() { return state.term; },
        setTerm: value => { state.term = value; },
        setFencingToken: value => { state.fencingToken = value; },
        get fencingToken() { return state.fencingToken; },

        now: faults.now,
        randomTimeout: (min, max) => min + Math.floor(Math.random() * (max - min)),
        dataVersion: () => dataVersionFn(),

        timer: (name, ms, fn) => {
            const previous = timers.get(name);
            if (previous) clearTimeout(previous);

            timers.set(name, setTimeout(() => {
                timers.delete(name);
                try { fn(); } catch (err) { log("ERROR", `Timer ${name} fallo: ${err.message}`); }
            }, ms));
        },
        clearTimer: name => {
            const handle = timers.get(name);
            if (handle) clearTimeout(handle);
            timers.delete(name);
        },
        hasTimer: name => timers.has(name),

        log: (kind, extra) => events.emit({ kind, node: state.id, ...(extra || {}) }),
        info: message => log("INFO", `[${state.algo}] ${message}`)
    };
}

/* ------------------------------------------------------------- publico -- */

function snapshot() {
    return {
        id: state.id,
        url: state.url,
        algo: state.algo,
        role: state.role,
        leader: state.leader,
        leaderUrl: state.leaderUrl,
        term: state.term,
        fencingToken: state.fencingToken,
        quorum: quorum(),
        clusterSize: clusterSize(),
        timing: timing.preset,
        uptime: Date.now() - state.startedAt,
        faults: faults.snapshot(),
        counters: events.counters,
        workers: workersFn(),
        strategyState: strategy && strategy.describe ? strategy.describe(ctx) : {},
        peers: [...peers.values()].map(peer => ({
            id: peer.id,
            url: peer.url,
            alive: peer.alive,
            lastSeen: peer.lastSeen
        }))
    };
}

function init(config, hooks) {
    state.id = config.id;
    state.url = config.publicUrl;
    timing = timingPresets.get(config.timing);

    if (hooks && hooks.dataVersion) dataVersionFn = hooks.dataVersion;
    if (hooks && hooks.workers) workersFn = hooks.workers;

    ctx = buildContext();
    ctx.timing = timing;

    config.peers.forEach(addPeer);
    setAlgorithm(config.algorithm, false);

    return snapshot();
}

function start() {
    stop();

    tickHandle = setInterval(tick, timing.tick);
    pingHandle = setInterval(pingRound, timing.heartbeat);

    pingRound();
    log("INFO", `Motor de eleccion arrancado (${state.algo}, preset ${timing.preset}, ${clusterSize()} nodos, quorum ${quorum()})`);
}

function stop() {
    if (tickHandle) clearInterval(tickHandle);
    if (pingHandle) clearInterval(pingHandle);

    tickHandle = null;
    pingHandle = null;

    clearTimers();
}

module.exports = {
    init,
    start,
    stop,
    state,
    snapshot,
    handleMessage,
    handlePing,
    setAlgorithm,
    addPeer,
    removePeer,
    peers,
    quorum,
    clusterSize,
    isLeader: () => state.role === "leader",
    leaderUrl: () => state.leaderUrl,
    peerUrls: () => [...peers.keys()],
    cachedPeers: () => [...peers.values()].map(peer => ({
        url: peer.url,
        id: peer.id,
        alive: peer.alive,
        lastSeen: peer.lastSeen,
        snapshot: peer.snapshot || null
    }))
};
