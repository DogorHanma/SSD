const createApp = require("./app");
const createLogger = require("./utils/logger");
const pulse = require("./services/pulse.service");
const messageService = require("./services/message.service");
const failover = require("./services/failover.service");

const PORT = process.argv[2];
const NAME = process.argv[3];

if (!PORT || !NAME) {
    console.error("PORT and NAME required");
    process.exit(1);
}

let parent = process.argv[4];

const log = createLogger(NAME);
const app = createApp({ port: PORT, name: NAME });

/**
 * Called when failover successfully connects to a new coordinator.
 * Updates parent and restarts the pulse.
 */
function onConnected(newUrl) {
    log("INFO", `★ Switched to new coordinator: ${newUrl}`);
    parent = newUrl;
    pulse.stopPulse();
    pulse.startPulse({
        name: NAME,
        port: PORT,
        middlewareUrl: parent,
        log,
        onNeedFailover: handleFailover
    });
}

/**
 * Handle failover events from the pulse service.
 * @param {string} type - "fast" (409 redirect) or "slow" (dead coordinator)
 * @param {string} urlOrLeader - leader URL (fast) or dead coordinator URL (slow)
 */
function handleFailover(type, urlOrLeader) {
    if (failover.isInProgress()) return;

    if (type === "fast") {
        // Fast path: we know who the leader is
        failover.fastFailover({
            leaderUrl: urlOrLeader,
            name: NAME,
            port: PORT,
            log,
            onConnected
        });
    } else {
        // Slow path: coordinator is dead, search through peers
        failover.slowFailover({
            name: NAME,
            port: PORT,
            log,
            onConnected,
            deadUrl: urlOrLeader
        });
    }
}

async function connectTo(url) {
    await pulse.register({ name: NAME, port: PORT, middlewareUrl: url });

    pulse.stopPulse();
    parent = url;
    pulse.startPulse({
        name: NAME,
        port: PORT,
        middlewareUrl: parent,
        log,
        onNeedFailover: handleFailover
    });

    log("INFO", `Registered with ${parent}`);
}

app.listen(PORT, async () => {

    log("INFO", `Server started on port ${PORT}`);

    try {
        await connectTo(parent);
    } catch (err) {
        // If initial registration fails (e.g. coordinator is a follower → 409)
        if (err.response && err.response.status === 409 && err.response.data.leader) {
            log("WARN", `Initial coordinator is not leader. Redirecting to ${err.response.data.leader}`);
            if (err.response.data.peers) {
                failover.updatePeers(err.response.data.peers);
            }
            handleFailover("fast", err.response.data.leader);
        } else {
            log("ERROR", `Could not register with ${parent}`);
        }
    }

});

app.get("/parent", (req, res) => {
    res.json({ parent, peers: failover.getPeers() });
});

// Cambiar de padre en caliente
app.post("/parent", async (req, res) => {
    const { url } = req.body;

    if (!url) return res.status(400).json({ error: "URL required" });

    const previous = parent;

    try {
        await connectTo(url);
        res.json({ message: `Now registered with ${parent}`, parent, previous });

    } catch (err) {
        // Seguimos con el padre anterior: connectTo no llego a cambiar nada
        if (err.response) {
            log("ERROR", `${url} rejected us (${err.response.status})`);
            return res.status(err.response.status).json(err.response.data);
        }

        log("ERROR", `Could not reach ${url}`);
        res.status(502).json({ error: `Could not reach ${url}` });
    }
});

// El front le manda el mensaje a SU mini server, y este lo reenvia al coordinador
app.post("/send-message", async (req, res) => {
    const { message } = req.body;

    if (!message) return res.status(400).json({ error: "Message required" });

    try {
        const entry = await messageService.sendMessage({
            name: NAME,
            message,
            middlewareUrl: parent,
            log
        });

        res.status(201).json(entry);

    } catch (err) {
        if (err.response) {
            log("ERROR", `Coordinator rejected the message (${err.response.status})`);
            return res.status(err.response.status).json(err.response.data);
        }

        log("ERROR", "Could not reach the coordinator");
        res.status(502).json({ error: "Coordinator unreachable" });
    }
});

app.post("/shutdown", (req, res) => {
    pulse.stopPulse(log);
    failover.reset();

    res.json({ message: `${NAME} shutting down...` });

    setTimeout(() => {
        process.exit(0);
    }, 500);
});
