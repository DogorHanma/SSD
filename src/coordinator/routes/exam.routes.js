// Rutas del protocolo del examen.
// Endpoints que expone este coordinador para que otros coordinadores le hablen.

const express  = require("express");
const router   = express.Router();
const protocol = require("../services/examProtocol");
const registry = require("../services/registry");
const messages = require("../services/messages");
const engine   = require("../election/engine");

/* --------------------------------------- coordinador <-> coordinador -- */

// Punto de entrada único para todos los mensajes del protocolo del examen.
// Recibe { type, data } y despacha al manejador correcto.
router.post("/coordinator/message", (req, res) => {
    const response = protocol.handleMessage(req.body);
    res.json(response);
});

// Permite añadir un peer manualmente desde la UI y enviarle un hello.
router.post("/coordinator/connect", async (req, res) => {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ error: "url requerida" });

    protocol.addPeer(url);
    const result = await protocol.sendHello(url);

    res.json({ ok: true, result, peers: protocol.getState().peers });
});

// Estado del protocolo del examen (lider conocido, peers, log de comunicacion)
router.get("/coordinator/state", (req, res) => {
    res.json(protocol.getState());
});

// Log de mensajes intercambiados (visible en la UI)
router.get("/coordinator/log", (req, res) => {
    res.json(protocol.getCommLog());
});

// Forzar postulacion como lider
router.post("/coordinator/announce", async (req, res) => {
    await protocol.broadcastLeaderAnnounce();
    res.json({ ok: true, state: protocol.getState() });
});

/* --------------------------------------- coordinador -> worker (tareas) -- */

// Vista completa para la UI: coordinadores + workers + tareas + estado eleccion
router.get("/dashboard", (req, res) => {
    const examState  = protocol.getState();
    const engineSnap = engine.snapshot();
    const workers    = registry.getAll();

    res.json({
        self: {
            id:       examState.id,
            url:      examState.url,
            priority: examState.priority,
            role:     engineSnap.role,
            leader:   examState.leader,
            electionLeader: engineSnap.leader
        },
        peers:   examState.peers,
        workers: workers.map(w => ({
            ...w,
            messages: messages.get(w.name)
        })),
        commLog: protocol.getCommLog().slice(0, 30)
    });
});

module.exports = router;
