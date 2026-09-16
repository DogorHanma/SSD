const express = require("express");
const router = express.Router();
const election = require("../services/election");

// Ping — heartbeat between coordinators (every 2s)
// Receives: { from: { id, url }, peers: ["http://..."] }
// Responds with full state (same as /election/state)
router.post("/election/ping", (req, res) => {
    const { from, peers } = req.body;
    const result = election.handlePing(from, peers);
    res.json(result);
});

// State — who is this node, who is the leader
router.get("/election/state", (req, res) => {
    res.json(election.getState());
});

// Message — ELECTION / ANSWER / COORDINATOR
// Receives: { type: "ELECTION", from: { id, url }, payload: {} }
// Always responds: { ok: true }
router.post("/election/message", (req, res) => {
    const { type, from, payload } = req.body;

    // Support both new format { from: { id, url } } and legacy { fromId, fromUrl }
    let fromId, fromUrl;
    if (from && from.id != null) {
        fromId = Number(from.id);
        fromUrl = from.url;
    } else {
        fromId = Number(req.body.fromId);
        fromUrl = req.body.fromUrl;
    }

    if (!type || fromId == null || !fromUrl) {
        return res.status(400).json({ error: "type and from (id, url) required" });
    }

    switch (type) {
        case "ELECTION":
            election.handleElection(fromId, fromUrl);
            return res.json({ ok: true });

        case "ANSWER":
            election.handleAnswer(fromId);
            return res.json({ ok: true });

        case "COORDINATOR":
            election.handleCoordinator(fromId, fromUrl);
            return res.json({ ok: true });

        default:
            return res.status(400).json({ error: `Unknown message type: ${type}` });
    }
});

module.exports = router;
