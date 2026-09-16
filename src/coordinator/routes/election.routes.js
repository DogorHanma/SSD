const express = require("express");
const router = express.Router();
const election = require("../services/election");

// Ping — heartbeat between coordinators
router.post("/election/ping", (req, res) => {
    const st = election.getState();
    res.json({ alive: true, id: st.id, role: st.role });
});

// State — who is this node, who is the leader
router.get("/election/state", (req, res) => {
    res.json(election.getState());
});

// Message — ELECTION / ANSWER / COORDINATOR
router.post("/election/message", (req, res) => {
    const { type, fromId, fromUrl } = req.body;

    if (!type || fromId == null || !fromUrl) {
        return res.status(400).json({ error: "type, fromId, and fromUrl required" });
    }

    switch (type) {
        case "ELECTION": {
            const result = election.handleElection(Number(fromId), fromUrl);
            return res.json(result);
        }
        case "ANSWER": {
            election.handleAnswer(Number(fromId));
            return res.json({ ok: true });
        }
        case "COORDINATOR": {
            election.handleCoordinator(Number(fromId), fromUrl);
            return res.json({ ok: true });
        }
        default:
            return res.status(400).json({ error: `Unknown message type: ${type}` });
    }
});

module.exports = router;
