require("dotenv").config();

const app = require("./app");
const startCleanup = require("./services/cleanup");
const election = require("./services/election");
const log = require("./utils/logger");

const PORT = process.argv[2] || process.env.PORT || 3000;
const ID = process.argv[3];
const PEERS = process.argv[4] ? process.argv[4].split(",").filter(Boolean) : [];
const PUBLIC_URL = process.argv[5] || `http://localhost:${PORT}`;

if (!ID) {
    log("ERROR", "Usage: node src/coordinator/server.js <PORT> <ID> [PEERS] [PUBLIC_URL]");
    log("ERROR", "  PORT:       Port number");
    log("ERROR", "  ID:         Numeric coordinator ID (lower = higher priority)");
    log("ERROR", "  PEERS:      Comma-separated URLs of other coordinators");
    log("ERROR", "  PUBLIC_URL: (Optional) Public URL like ngrok, defaults to localhost");
    process.exit(1);
}

app.listen(PORT, () => {
    log("INFO", `Coordinator [ID=${ID}] running on http://localhost:${PORT} (Public: ${PUBLIC_URL})`);

    election.init({
        id: Number(ID),
        url: PUBLIC_URL,
        peers: PEERS
    });
});

startCleanup();