require("dotenv").config();

const PORT = Number(process.env.PORT || process.argv[2] || 3000);

// Cada nodo tiene que saber su PROPIA url publica.
const PUBLIC_URL = (process.env.PUBLIC_URL || process.argv[5] || `http://localhost:${PORT}`).replace(/\/+$/, "");

// Peers de arranque (semillas).
const PEERS_ARG = process.argv[4] ? process.argv[4].split(",") : [];
const PEERS_ENV = String(process.env.PEERS || "").split(",");
const PEERS = [...PEERS_ARG, ...PEERS_ENV]
    .map(url => url.trim().replace(/\/+$/, ""))
    .filter(Boolean);

const config = {
    id: process.env.NODE_ID || process.argv[3] || `node-${PORT}`,
    port: PORT,
    publicUrl: PUBLIC_URL,
    peers: PEERS,
    algorithm: process.env.ELECTION_ALGO || "bully",
    timing: process.env.ELECTION_TIMING === "lan" ? "lan" : "wan",
    trustProxy: Number(process.env.TRUST_PROXY || 0),
    electionEnabled: process.env.ELECTION !== "off"
};

module.exports = config;
