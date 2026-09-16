const axios = require("axios");
const failover = require("./failover.service");

let pulseInterval = null;

async function register({ name, port, middlewareUrl }) {
    await axios.post(`${middlewareUrl}/register`, {
        name,
        url: `http://localhost:${port}`
    }, { timeout: 5000 });
}

function startPulse({ name, port, middlewareUrl, log, onNeedFailover }) {
    stopPulse();

    pulseInterval = setInterval(async () => {
        // Don't pulse while failover is in progress
        if (failover.isInProgress()) return;

        try {
            const res = await axios.post(`${middlewareUrl}/pulse/${name}`, {}, { timeout: 5000 });

            // Successful pulse — save peers from cluster view
            if (res.data && res.data.peers) {
                failover.updatePeers(res.data.peers);
            }
            if (res.data && res.data.leader) {
                log("INFO", `Pulse OK (leader: ${res.data.leader})`);
            } else {
                log("INFO", "Pulse sent");
            }

        } catch (err) {
            if (err.response) {
                const status = err.response.status;

                if (status === 409 && err.response.data && err.response.data.leader) {
                    // Fast path: coordinator is alive but not leader
                    const leaderUrl = err.response.data.leader;

                    // Also save peers from the 409 response
                    if (err.response.data.peers) {
                        failover.updatePeers(err.response.data.peers);
                    }

                    log("WARN", `409 → Not the leader. Leader is at ${leaderUrl}`);

                    if (onNeedFailover) {
                        onNeedFailover("fast", leaderUrl);
                    }
                    return;
                }

                if (status === 503 && err.response.data && err.response.data.retry) {
                    // No leader yet, save peers and retry
                    if (err.response.data.peers) {
                        failover.updatePeers(err.response.data.peers);
                    }
                    log("WARN", "503 → No leader yet. Will retry...");
                    return;
                }

                log("ERROR", `Pulse failed (HTTP ${status})`);
            } else {
                // Coordinator is dead — slow path
                log("ERROR", `Coordinator ${middlewareUrl} unreachable`);

                if (onNeedFailover) {
                    onNeedFailover("slow", middlewareUrl);
                }
            }
        }
    }, 5000);
}

function stopPulse(log) {
    if (!pulseInterval) return;

    clearInterval(pulseInterval);
    pulseInterval = null;

    if (log) log("WARN", "Stopped sending pulse");
}

module.exports = {
    register,
    startPulse,
    stopPulse
};
