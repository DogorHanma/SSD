const express = require("express");
const router = express.Router();

const processManager = require("../services/processManager");
const registry = require("../services/registry");
const messages = require("../services/messages");
const election = require("../services/election");

function clientId(req) {
    return String(req.ip || "").replace(/^::ffff:/, "");
}

/**
 * Middleware: only the leader can handle writes.
 * - If I'm the leader → continue
 * - If I know who the leader is → 409 with leader URL and peers
 * - If no leader yet → 503 with retry and peers
 */
function leaderOnly(req, res, next) {
    const st = election.getState();

    if (election.isLeader()) {
        return next();
    }

    const peerUrls = st.peers.map(p => p.url);

    if (st.leaderUrl) {
        return res.status(409).json({
            leader: st.leaderUrl,
            peers: peerUrls
        });
    }

    return res.status(503).json({
        retry: true,
        peers: peerUrls
    });
}

// Health
router.get("/", (req, res) => {});

// Create
router.post("/create-server", (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "Name required" });

    const { port } = processManager.createServer(name);
    res.json({ message: `${name} created on port ${port}` });
});

// Register — LEADER ONLY
router.post("/register", leaderOnly, (req, res) => {
    const { name, url } = req.body;
    if (!name || !url)
        return res.status(400).json({ error: "Name and URL required" });

    const owner = clientId(req);
    const claimed = registry.claimedBy(name);

    // Un nombre pertenece a la maquina que lo reclamo primero
    if (claimed && claimed !== owner) return res.status(409).json({ error: `Name "${name}" is already taken by another machine. Pick a different one.` });

    registry.register(name, url, owner);
    res.json({ message: "Server registered successfully" });
});

// Pulse — LEADER ONLY, returns cluster view
router.post("/pulse/:name", leaderOnly, (req, res) => {
    const ok = registry.pulse(req.params.name);
    if (!ok) return res.status(404).json({ error: "Server not found" });

    const st = election.getState();
    res.json({
        message: "Pulse received",
        leader: st.leaderUrl,
        peers: st.peers.map(p => p.url)
    });
});

// Kill
router.post("/kill-server/:name", (req, res) => {
    const killed = processManager.killServer(req.params.name);
    if (!killed) return res.status(404).json({ error: "Server not found" });

    registry.remove(req.params.name);
    res.json({ message: `${req.params.name} killed` });
});

// List — any coordinator can serve reads
router.get("/servers", (req, res) => {
    res.json(registry.getAll());
});

// Overview — any coordinator can serve reads
router.get("/overview", (req, res) => {
    res.json(registry.getAll().map(server => ({
        ...server,
        messages: messages.get(server.name)
    })));
});

// Receive a message from a mini server — LEADER ONLY
router.post("/send-message/:name", leaderOnly, (req, res) => {
    const { name } = req.params;
    const { message } = req.body;

    if (!message) return res.status(400).json({ error: "Message required" });
    if (!registry.exists(name)) return res.status(404).json({ error: "Server not found" });
    if (registry.claimedBy(name) !== clientId(req)) return res.status(403).json({ error: `Only ${name}'s own machine can send messages as ${name}` });

    const entry = messages.add(name, message);
    res.status(201).json(entry);
});

// Read the messages of a mini server — any coordinator can serve reads
router.get("/send-message/:name", (req, res) => {
    res.json(messages.get(req.params.name));
});

module.exports = router;
