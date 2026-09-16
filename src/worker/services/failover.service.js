const axios = require("axios");

/**
 * Failover service for the worker.
 * Handles finding a new coordinator when the current one fails.
 * 
 * Two paths:
 *   - Fast path: coordinator is alive but not leader (409) → redirect to leader
 *   - Slow path: coordinator is dead → iterate through known peers
 */

let knownPeers = [];       // URLs of coordinators from last successful pulse
let failoverInProgress = false;
let failoverTimeout = null;

/**
 * Update the known peers list (called on every successful pulse).
 */
function updatePeers(peers) {
    if (Array.isArray(peers) && peers.length > 0) {
        knownPeers = [...peers];
    }
}

function getPeers() {
    return knownPeers;
}

/**
 * Fast path: we got a 409 with a leader URL.
 * Register directly with the new leader.
 */
async function fastFailover({ leaderUrl, name, port, log, onConnected }) {
    if (failoverInProgress) return;
    failoverInProgress = true;

    log("WARN", `409 received → leader is at ${leaderUrl}. Redirecting...`);

    try {
        await axios.post(`${leaderUrl}/register`, {
            name,
            url: `http://localhost:${port}`
        }, { timeout: 5000 });

        log("INFO", `✓ Registered with new leader: ${leaderUrl}`);
        failoverInProgress = false;
        cancelPendingRetry();
        onConnected(leaderUrl);
    } catch (err) {
        log("ERROR", `Fast failover to ${leaderUrl} failed: ${err.message}`);
        failoverInProgress = false;
        // Fall through to slow failover
        slowFailover({ name, port, log, onConnected });
    }
}

/**
 * Slow path: coordinator is dead, iterate through known peers.
 * For each peer, GET /election/state and decide:
 *   - no response       → skip, continue
 *   - is the leader     → register there. DONE.
 *   - knows the leader  → go directly to that one
 *   - nobody knows      → election in progress, retry in 2s
 */
async function slowFailover({ name, port, log, onConnected, deadUrl }) {
    if (failoverInProgress) return;
    failoverInProgress = true;

    log("WARN", `Coordinator is dead. Searching through ${knownPeers.length} known peers...`);

    const discarded = new Set();
    if (deadUrl) {
        discarded.add(deadUrl);
    }

    const result = await searchPeers({ name, port, log, onConnected, discarded });

    if (!result) {
        // Nobody knows → retry in 2s
        log("WARN", "No leader found yet (election in progress?). Retrying in 2s...");
        failoverInProgress = false;
        schedulePendingRetry({ name, port, log, onConnected, deadUrl });
    }
}

async function searchPeers({ name, port, log, onConnected, discarded }) {
    for (const peerUrl of knownPeers) {
        // Don't try peers we already discarded this round
        if (discarded.has(peerUrl)) {
            log("INFO", `Skipping discarded peer: ${peerUrl}`);
            continue;
        }

        try {
            const res = await axios.get(`${peerUrl}/election/state`, { timeout: 3000 });
            const st = res.data;

            if (st.role === "leader") {
                // This peer IS the leader → register here
                log("INFO", `${peerUrl} says it IS the leader. Registering...`);
                try {
                    await axios.post(`${peerUrl}/register`, {
                        name,
                        url: `http://localhost:${port}`
                    }, { timeout: 5000 });

                    log("INFO", `✓ Registered with new leader: ${peerUrl}`);
                    failoverInProgress = false;
                    cancelPendingRetry();
                    onConnected(peerUrl);
                    return true;
                } catch (regErr) {
                    // Maybe it lost leadership between state check and register
                    if (regErr.response && regErr.response.status === 409 && regErr.response.data.leader) {
                        // Redirected again
                        const redirectUrl = regErr.response.data.leader;
                        log("INFO", `${peerUrl} redirected to ${redirectUrl}`);
                        if (!discarded.has(redirectUrl)) {
                            return await tryRegisterAt({ url: redirectUrl, name, port, log, onConnected, discarded });
                        }
                    }
                    log("WARN", `Registration at ${peerUrl} failed: ${regErr.message}`);
                }
            } else if (st.leaderUrl) {
                // This peer knows who the leader is → go directly there
                const leaderUrl = st.leaderUrl;
                log("INFO", `${peerUrl} says leader is at ${leaderUrl}. Going there...`);

                // Don't go to a discarded peer
                if (discarded.has(leaderUrl)) {
                    log("INFO", `But ${leaderUrl} was already discarded. Skipping.`);
                    continue;
                }

                const ok = await tryRegisterAt({ url: leaderUrl, name, port, log, onConnected, discarded });
                if (ok) return true;
            } else {
                // Nobody knows → election in progress
                log("INFO", `${peerUrl} doesn't know the leader yet (election in progress)`);
            }

        } catch {
            // Peer doesn't respond → discard and continue
            log("INFO", `${peerUrl} not responding. Discarding.`);
            discarded.add(peerUrl);
        }
    }

    return false;
}

async function tryRegisterAt({ url, name, port, log, onConnected, discarded }) {
    try {
        await axios.post(`${url}/register`, {
            name,
            url: `http://localhost:${port}`
        }, { timeout: 5000 });

        log("INFO", `✓ Registered with leader: ${url}`);
        failoverInProgress = false;
        cancelPendingRetry();
        onConnected(url);
        return true;
    } catch (err) {
        if (err.response && err.response.status === 409 && err.response.data.leader) {
            const redirectUrl = err.response.data.leader;
            if (!discarded.has(redirectUrl)) {
                log("INFO", `Redirected to ${redirectUrl}`);
                return await tryRegisterAt({ url: redirectUrl, name, port, log, onConnected, discarded });
            }
        }
        log("WARN", `Could not register at ${url}: ${err.message}`);
        discarded.add(url);
        return false;
    }
}

function schedulePendingRetry({ name, port, log, onConnected, deadUrl }) {
    cancelPendingRetry();
    failoverTimeout = setTimeout(() => {
        failoverInProgress = false;
        slowFailover({ name, port, log, onConnected, deadUrl });
    }, 2000);
}

function cancelPendingRetry() {
    if (failoverTimeout) {
        clearTimeout(failoverTimeout);
        failoverTimeout = null;
    }
}

function isInProgress() {
    return failoverInProgress;
}

function reset() {
    failoverInProgress = false;
    cancelPendingRetry();
}

module.exports = {
    updatePeers,
    getPeers,
    fastFailover,
    slowFailover,
    isInProgress,
    cancelPendingRetry,
    reset
};
