const express = require("express");
const router = express.Router();

const processManager = require("../services/processManager");
const registry = require("../services/registry");
const messages = require("../services/messages");
const engine = require("../election/engine");
const config = require("../config");
const faults = require("../election/faults");

function clientId(req) {
    return String(req.ip || "").replace(/^::ffff:/, "");
}

// La vista del cluster que se le adjunta al worker en cada respuesta. Gracias
// a esto el worker no necesita configuracion: aprende solo a quien preguntar
// cuando su coordinador desaparezca.
function clusterView() {
    if (!config.electionEnabled) return {};

    return {
        leader: engine.leaderUrl(),
        leaderId: engine.state.leader,
        peers: engine.peerUrls()
    };
}

// Las ESCRITURAS solo las atiende el lider. Si llega a otro nodo, se le dice
// al cliente quien manda ahora y este se redirige (asi encuentran al lider
// los clientes de Raft). Las LECTURAS las sirve cualquiera.
function rejectIfNotLeader(req, res) {
    if (!config.electionEnabled) return false;

    // Nodo congelado: no puede participar en la eleccion, asi que tampoco
    // puede atender clientes. Si siguiera respondiendo, un lider "muerto"
    // retendria a sus workers para siempre y el failover no se veria nunca.
    // Ojo: no le decimos quien es el lider, porque su idea de quien manda se
    // quedo congelada tambien y mandaria al worker de vuelta a un fantasma.
    if (faults.state.paused) {
        res.status(503).json({
            error: "Nodo fuera de servicio",
            retry: true,
            peers: engine.peerUrls()
        });
        return true;
    }

    if (engine.isLeader()) return false;

    const leader = engine.leaderUrl();

    // Todavia no hay lider: eleccion en curso. No es un error del cliente,
    // es que el sistema aun no sabe quien manda. Que reintente.
    if (!leader) {
        res.status(503).json({
            error: "Eleccion en curso, todavia no hay lider",
            retry: true,
            ...clusterView()
        });
        return true;
    }

    res.status(409).json({
        error: "No soy el lider",
        ...clusterView()
    });
    return true;
}

// Health
router.get("/health", (req, res) => {
    res.json({ ok: true, id: config.id, role: engine.state.role, leader: engine.state.leader });
});

// Create
router.post("/create-server", (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "Name required" });

    const { port } = processManager.createServer(name);
    res.json({ message: `${name} created on port ${port}` });
});

// Register
router.post("/register", (req, res) => {
    const { name, url } = req.body;
    if (!name || !url)
        return res.status(400).json({ error: "Name and URL required" });

    if (rejectIfNotLeader(req, res)) return;

    const owner = clientId(req);
    const claimed = registry.claimedBy(name);

    // Un nombre pertenece a la maquina que lo reclamo primero
    if (claimed && claimed !== owner) return res.status(409).json({ error: `Name "${name}" is already taken by another machine. Pick a different one.` });

    registry.register(name, url, owner);
    res.json({ message: "Server registered successfully", ...clusterView() });
});

// Pulse
router.post("/pulse/:name", (req, res) => {
    if (rejectIfNotLeader(req, res)) return;

    const ok = registry.pulse(req.params.name);
    if (!ok) return res.status(404).json({ error: "Server not found", ...clusterView() });

    res.json({ message: "Pulse received", ...clusterView() });
});

// Kill
router.post("/kill-server/:name", (req, res) => {
    const killed = processManager.killServer(req.params.name);
    if (!killed) return res.status(404).json({ error: "Server not found" });

    registry.remove(req.params.name);
    res.json({ message: `${req.params.name} killed` });
});

// List
router.get("/servers", (req, res) => {
    res.json(registry.getAll());
});

// Overview
router.get("/overview", (req, res) => {
    res.json(registry.getAll().map(server => ({
        ...server,
        messages: messages.get(server.name)
    })));
});

// Receive a message from a mini server
router.post("/send-message/:name", (req, res) => {
    const { name } = req.params;
    const { message } = req.body;

    if (!message) return res.status(400).json({ error: "Message required" });
    if (rejectIfNotLeader(req, res)) return;
    if (!registry.exists(name)) return res.status(404).json({ error: "Server not found" });
    if (registry.claimedBy(name) !== clientId(req)) return res.status(403).json({ error: `Only ${name}'s own machine can send messages as ${name}` });

    const entry = messages.add(name, message);
    res.status(201).json(entry);
});

// Read the messages of a mini server
router.get("/send-message/:name", (req, res) => {
    res.json(messages.get(req.params.name));
});

module.exports = router;
