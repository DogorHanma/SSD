const express = require("express");
const router = express.Router();

const engine = require("../election/engine");
const strategies = require("../election/strategies");
const events = require("../election/events");
const config = require("../config");

/* -------------------------------------------------------------- protocolo -- */

// Mensaje del protocolo de eleccion. Contesta siempre rapido: las respuestas
// del algoritmo viajan como mensajes nuevos, no como cuerpo de esta respuesta.
router.post("/election/message", (req, res) => {
    const result = engine.handleMessage(req.body);

    if (!result.ok) return res.status(503).json(result);
    res.json(result);
});

// Ping del detector de fallos. Sirve para tres cosas a la vez: probar que
// estoy vivo, decir quien soy, y contarnos los peers que conocemos cada uno.
router.post("/election/ping", (req, res) => {
    const snapshot = engine.handlePing(req.body);

    if (!snapshot) return res.status(503).json({ error: "unreachable" });
    res.json(snapshot);
});

/* ----------------------------------------------------------------- estado -- */

router.get("/election/state", (req, res) => {
    const snap = engine.snapshot();

    // Eliminar informacion innecesaria para la respuesta publica
    delete snap.term;
    delete snap.fencingToken;
    delete snap.quorum;
    delete snap.clusterSize;
    delete snap.timing;
    delete snap.uptime;
    delete snap.faults;
    delete snap.counters;
    delete snap.workers;
    delete snap.strategyState;

    res.json(snap);
});

router.get("/election/algorithms", (req, res) => {
    res.json({ active: engine.state.algo, available: strategies.list() });
});

router.post("/election/algorithm", (req, res) => {
    const { algo, propagate } = req.body;

    if (!algo) return res.status(400).json({ error: "algo required" });
    if (!strategies.has(algo)) {
        return res.status(400).json({ error: `Unknown algorithm: ${algo}`, available: strategies.list().map(s => s.name) });
    }

    // propagate por defecto true: al conmutar desde el panel queremos que
    // TODO el cluster cambie a la vez, o los nodos hablarian idiomas distintos.
    engine.setAlgorithm(algo, propagate !== false);

    res.json({ message: `Algoritmo activo: ${algo}`, state: engine.snapshot() });
});

router.post("/election/trigger", (req, res) => {
    engine.stepDown();
    res.json({ message: "Eleccion forzada", state: engine.snapshot() });
});

/* ------------------------------------------------------------------ peers -- */

router.get("/election/peers", (req, res) => {
    res.json(engine.snapshot().peers);
});

router.post("/election/peers", (req, res) => {
    const { url } = req.body;

    if (!url) return res.status(400).json({ error: "URL required" });

    const peer = engine.addPeer(url);
    if (!peer) return res.status(400).json({ error: "URL invalida o es la mia" });

    res.json({ message: `Peer añadido: ${peer.url}`, peers: engine.snapshot().peers });
});

router.delete("/election/peers", (req, res) => {
    const { url } = req.body;

    if (!url) return res.status(400).json({ error: "URL required" });
    if (!engine.removePeer(url)) return res.status(404).json({ error: "Peer no encontrado" });

    res.json({ message: `Peer eliminado: ${url}` });
});

/* ---------------------------------------------------------------- cluster -- */

// Vista agregada: la foto global del cluster. Es el detector de split-brain:
// si aqui salen dos lideres a la vez, el algoritmo no es seguro.
//
// NO sale a la red. Antes preguntaba a cada peer por HTTP en cada llamada, asi
// que un panel refrescando cada segundo generaba N peticiones/segundo POR CADA
// pestana abierta, y a traves de tuneles eso se come la cuota en minutos.
// Ahora se sirve de lo que ya trajo el ultimo ping del detector de fallos:
// los datos son como mucho un heartbeat mas viejos, y no cuesta ni una peticion.
router.get("/cluster", (req, res) => {
    const mine = engine.snapshot();

    const remotes = engine.cachedPeers().map(peer => {
        if (!peer.alive || !peer.snapshot) {
            return {
                url: peer.url,
                id: peer.id,
                reachable: false,
                role: null,
                leader: null,
                term: null,
                staleFor: peer.lastSeen ? Date.now() - peer.lastSeen : null
            };
        }

        return { ...peer.snapshot, reachable: true, staleFor: Date.now() - peer.lastSeen };
    });

    const nodes = [{ ...mine, reachable: true, self: true, staleFor: 0 }, ...remotes];

    // Un nodo congelado sigue contestando con la foto de lo que creia antes de
    // pausarse. Esa opinion no es un desacuerdo real (no puede actuar sobre
    // ella), asi que no cuenta para decidir si el cluster converge.
    const active = nodes.filter(node => node.reachable && !(node.faults && node.faults.paused));

    // Un nodo puede creerse lider mientras el resto ya no lo reconoce. Lo que
    // importa es cuantos se PROCLAMAN lider a la vez.
    const leaders = active.filter(node => node.role === "leader");
    const distinctLeaders = [...new Set(active.filter(n => n.leader).map(n => String(n.leader)))];

    res.json({
        algorithm: mine.algo,
        quorum: mine.quorum,
        clusterSize: mine.clusterSize,
        leaders: leaders.map(node => ({ id: node.id, term: node.term, fencingToken: node.fencingToken })),
        splitBrain: leaders.length > 1,
        converged: leaders.length === 1 && distinctLeaders.length === 1,
        agreedLeader: distinctLeaders.length === 1 ? distinctLeaders[0] : null,
        nodes
    });
});

/* ------------------------------------------------------------------ feed -- */

router.get("/events", (req, res) => {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
    });

    res.write(`data: ${JSON.stringify({ kind: "hello", node: config.id })}\n\n`);
    events.history().slice(-60).forEach(entry => res.write(`data: ${JSON.stringify(entry)}\n\n`));

    const unsubscribe = events.subscribe(res);

    // Sin esto, un proxy con timeout corto (ngrok incluido) corta el stream.
    const keepAlive = setInterval(() => res.write(": ping\n\n"), 15000);

    req.on("close", () => {
        clearInterval(keepAlive);
        unsubscribe();
    });
});

router.get("/election/events", (req, res) => {
    res.json({ counters: events.counters, events: events.history() });
});

module.exports = router;
