const express = require("express");
const router = express.Router();

const faults = require("../election/faults");
const events = require("../election/events");
const engine = require("../election/engine");
const log = require("../utils/logger");

// Inyeccion de fallos para la demo. Nada de esto mata el proceso: el nodo
// sigue vivo y se le puede seguir preguntando por su estado, que es justo lo
// que hace falta para ver la diferencia entre "caido" y "incomunicado".

// Congela el nodo: deja de enviar y de responder al protocolo. Simula un
// crash o un GC eterno, pero sin perder el estado, para poder reanudarlo.
router.post("/debug/pause", (req, res) => {
    faults.state.paused = true;

    log("WARN", "PAUSA: este nodo deja de participar en la eleccion");
    events.emit({ kind: "fault", fault: "pause" });

    res.json({ message: "Nodo pausado", faults: faults.snapshot() });
});

router.post("/debug/resume", (req, res) => {
    faults.state.paused = false;

    log("INFO", "REANUDADO: el nodo vuelve a la eleccion");
    events.emit({ kind: "fault", fault: "resume" });

    res.json({ message: "Nodo reanudado", faults: faults.snapshot() });
});

// Particion de red: corta la comunicacion con los ids indicados, en ambos
// sentidos. El nodo sigue perfectamente vivo, solo que aislado de esos peers.
router.post("/debug/partition", (req, res) => {
    const { block } = req.body;

    if (!Array.isArray(block)) return res.status(400).json({ error: "block debe ser un array de ids" });

    faults.partition(block);

    log("WARN", `PARTICION: incomunicado de [${block.join(", ")}]`);
    events.emit({ kind: "fault", fault: "partition", blocked: block });

    res.json({ message: `Particionado de ${block.join(", ")}`, faults: faults.snapshot() });
});

router.post("/debug/heal", (req, res) => {
    faults.heal();

    log("INFO", "RED SANADA: se restablecen todas las comunicaciones");
    events.emit({ kind: "fault", fault: "heal" });

    res.json({ message: "Red sanada", faults: faults.snapshot() });
});

router.post("/debug/latency", (req, res) => {
    const { ms, jitter } = req.body;

    faults.state.latency = Math.max(0, Number(ms) || 0);
    faults.state.jitter = Math.max(0, Number(jitter) || 0);

    events.emit({ kind: "fault", fault: "latency", ms: faults.state.latency });

    res.json({ message: `Latencia ${faults.state.latency}ms (+${faults.state.jitter})`, faults: faults.snapshot() });
});

router.post("/debug/drop", (req, res) => {
    const { probability } = req.body;

    faults.state.drop = Math.min(1, Math.max(0, Number(probability) || 0));

    events.emit({ kind: "fault", fault: "drop", probability: faults.state.drop });

    res.json({ message: `Perdida de mensajes al ${faults.state.drop * 100}%`, faults: faults.snapshot() });
});

// Desfase de reloj. Con un valor NEGATIVO el nodo cree que es antes de lo que
// es, y por tanto que su lease sigue vigente cuando ya caduco: asi se fabrica
// el lider zombi que justifica el fencing token.
router.post("/debug/clock-skew", (req, res) => {
    const { ms } = req.body;

    faults.state.clockSkew = Number(ms) || 0;

    log("WARN", `RELOJ DESFASADO ${faults.state.clockSkew}ms`);
    events.emit({ kind: "fault", fault: "clock-skew", ms: faults.state.clockSkew });

    res.json({ message: `Reloj desfasado ${faults.state.clockSkew}ms`, faults: faults.snapshot() });
});

router.get("/debug/state", (req, res) => {
    res.json({ faults: faults.snapshot(), election: engine.snapshot() });
});

// Reenvia una orden a otro nodo del cluster. El panel controla a TODOS los
// coordinadores, pero se sirve desde uno solo: sin este relay habria que
// abrir CORS en todos, y con ngrok (https contra http) ni con esas.
//
// Solo acepta urls de peers ya conocidos: es un relay para la demo, no un
// proxy abierto con el que pegarle a cualquier sitio.
router.post("/relay", async (req, res) => {
    const { url, path, body } = req.body;

    if (!url || !path) return res.status(400).json({ error: "url y path requeridos" });

    const target = String(url).replace(/\/+$/, "");
    const allowed = [...engine.peerUrls(), engine.state.url];

    if (!allowed.includes(target)) {
        return res.status(403).json({ error: "Ese nodo no es un peer conocido", allowed });
    }

    try {
        const axios = require("axios");
        const response = await axios.post(`${target}${path}`, body || {}, {
            timeout: 5000,
            headers: { "ngrok-skip-browser-warning": "true" }
        });

        res.json(response.data);

    } catch (err) {
        const status = err.response ? err.response.status : 502;
        res.status(status).json(err.response ? err.response.data : { error: `No pude alcanzar ${target}` });
    }
});

router.post("/debug/reset-counters", (req, res) => {
    events.resetCounters();
    res.json({ message: "Contadores a cero", counters: events.counters });
});

module.exports = router;
