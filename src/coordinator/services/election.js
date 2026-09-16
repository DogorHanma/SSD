const axios = require("axios");
const log = require("../utils/logger");

// Skip ngrok browser warning on all requests
axios.defaults.headers.common["ngrok-skip-browser-warning"] = "true";

// ── State ────────────────────────────────────────────────────
let state = {
    id: null,
    url: null,
    peers: [],          // [{ id, url, alive }]
    role: "follower",   // "leader" | "follower" | "candidate"
    leader: null,       // ID/name of current leader
    leaderUrl: null,    // URL of current leader
};

let electionInProgress = false;
let receivedAnswer = false;
let pingInterval = null;
let electionTimer = null;
let coordinatorTimer = null;
let reaffirmInterval = null;

// ── Timings ──────────────────────────────────────────────────
const PING_INTERVAL_MS = 2000;
const ELECTION_TIMEOUT_MS = 3000;
const COORDINATOR_TIMEOUT_MS = 6000;
const REAFFIRM_INTERVAL_MS = 4000;
const STARTUP_DELAY_MS = 3000;
const MISSED_PING_THRESHOLD = 3; // after 3 missed pings (6s) → dead

// Track missed pings per peer
let missedPings = {};

// ── Init ─────────────────────────────────────────────────────
function init({ id, url, peers }) {
    state.id = Number(id);
    state.url = url;

    // Initialize peers from CLI args as objects (we don't know their IDs yet)
    state.peers = peers.filter(p => p !== url).map(peerUrl => ({
        id: null,
        url: peerUrl,
        alive: true
    }));

    log("INFO", `Election init: ID=${state.id}, URL=${state.url}`);
    log("INFO", `Peers: ${state.peers.map(p => p.url).join(", ") || "none"}`);

    if (state.peers.length === 0) {
        becomeLeader();
        return;
    }

    // Start pinging all peers immediately
    startPingAllPeers();

    // Give peers time to start, then trigger first election
    setTimeout(() => startElection(), STARTUP_DELAY_MS);
}

// ── Peer Discovery & Ping ───────────────────────────────────
function startPingAllPeers() {
    stopPingAllPeers();

    pingInterval = setInterval(() => {
        pingAllPeers();
    }, PING_INTERVAL_MS);
}

function stopPingAllPeers() {
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
    }
}

async function pingAllPeers() {
    const myPeerUrls = state.peers.map(p => p.url);

    for (const peer of state.peers) {
        try {
            const res = await axios.post(`${peer.url}/election/ping`, {
                from: { id: state.id, url: state.url },
                peers: myPeerUrls
            }, { timeout: 2000 });

            const data = res.data;

            // Update peer identity
            if (data.id != null) {
                peer.id = data.id;
            }

            // Mark as alive
            if (!peer.alive) {
                log("INFO", `Peer ${peer.id || peer.url} is back ALIVE`);
            }
            peer.alive = true;
            missedPings[peer.url] = 0;

            // Discover new peers from their response
            if (data.peers && Array.isArray(data.peers)) {
                discoverPeers(data.peers);
            }

        } catch {
            missedPings[peer.url] = (missedPings[peer.url] || 0) + 1;

            if (missedPings[peer.url] >= MISSED_PING_THRESHOLD && peer.alive) {
                peer.alive = false;
                log("WARN", `Peer ${peer.id || peer.url} is DOWN (missed ${missedPings[peer.url]} pings)`);

                // If the dead peer was the leader, start election
                if (state.leaderUrl === peer.url) {
                    log("ERROR", `Leader ${peer.id || peer.url} is DOWN → starting election`);
                    state.leader = null;
                    state.leaderUrl = null;
                    state.role = "follower";
                    startElection();
                }
            }
        }
    }
}

/**
 * Discover new peers from a peer list (URLs or objects).
 * This is how seed-based discovery works.
 */
function discoverPeers(peerData) {
    for (const item of peerData) {
        let url, id;

        if (typeof item === "string") {
            url = item;
            id = null;
        } else if (item && item.url) {
            url = item.url;
            id = item.id != null ? item.id : null;
        } else {
            continue;
        }

        // Don't add ourselves
        if (url === state.url) continue;

        // Don't add duplicates
        const exists = state.peers.find(p => p.url === url);
        if (exists) {
            // Update ID if we didn't know it
            if (id != null && exists.id == null) {
                exists.id = id;
            }
            continue;
        }

        // New peer discovered!
        log("INFO", `Discovered new peer: ${id || url}`);
        state.peers.push({ id, url, alive: true });
        missedPings[url] = 0;
    }
}

// ── Handle incoming ping ────────────────────────────────────
function handlePing(fromData, incomingPeers) {
    // Register the sender if we don't know them
    if (fromData && fromData.url) {
        discoverPeers([fromData]);
    }

    // Discover peers from the sender's list
    if (incomingPeers && Array.isArray(incomingPeers)) {
        // Convert URL strings to objects for discovery
        const peerObjects = incomingPeers.map(url =>
            typeof url === "string" ? { url, id: null } : url
        );
        discoverPeers(peerObjects);
    }

    // Return our full state
    return getState();
}

// ── Bully Election ──────────────────────────────────────────
function startElection() {
    if (electionInProgress) return;

    electionInProgress = true;
    receivedAnswer = false;
    state.role = "candidate";

    log("INFO", `Starting election (ID=${state.id})...`);

    // Send ELECTION to all peers with higher ID (in bully, higher ID wins)
    const higherPeers = state.peers.filter(p => p.alive && p.id != null && p.id > state.id);

    if (higherPeers.length === 0) {
        // No higher peers known or alive → we win immediately
        electionInProgress = false;
        becomeLeader();
        return;
    }

    higherPeers.forEach(peer => {
        axios.post(`${peer.url}/election/message`, {
            type: "ELECTION",
            from: { id: state.id, url: state.url },
            payload: {}
        }, { timeout: ELECTION_TIMEOUT_MS }).catch(() => {});
    });

    // Wait for ANSWERs
    clearTimeout(electionTimer);
    electionTimer = setTimeout(() => {
        electionInProgress = false;

        if (!receivedAnswer) {
            // Nobody with higher priority answered → we win
            becomeLeader();
        } else {
            // Someone answered; wait for their COORDINATOR announcement
            waitForCoordinator();
        }
    }, ELECTION_TIMEOUT_MS);
}

function waitForCoordinator() {
    clearTimeout(coordinatorTimer);
    coordinatorTimer = setTimeout(() => {
        log("WARN", "No COORDINATOR received in time, restarting election...");
        electionInProgress = false;
        startElection();
    }, COORDINATOR_TIMEOUT_MS);
}

// ── Message Handlers ─────────────────────────────────────────

/**
 * Received ELECTION from another node.
 * In bully: higher ID wins. If we have higher ID, we ANSWER and start our own.
 */
function handleElection(fromId, fromUrl) {
    if (state.id > fromId) {
        log("INFO", `ELECTION from ID=${fromId} → I have higher ID → ANSWER`);

        // Send ANSWER back
        axios.post(`${fromUrl}/election/message`, {
            type: "ANSWER",
            from: { id: state.id, url: state.url },
            payload: {}
        }, { timeout: 2000 }).catch(() => {});

        // Start our own election (if not already running)
        if (!electionInProgress) {
            startElection();
        }

        return { ok: true };
    }

    log("INFO", `ELECTION from ID=${fromId} → They have higher ID → ignored`);
    return { ok: true };
}

/**
 * Received ANSWER: a higher-ID node is alive → back down.
 */
function handleAnswer(fromId) {
    log("INFO", `ANSWER from ID=${fromId} → backing down`);
    receivedAnswer = true;

    clearTimeout(electionTimer);
    electionInProgress = false;

    waitForCoordinator();
}

/**
 * Received COORDINATOR: accept the new leader.
 * BUT if the sender has a LOWER ID than us → reject and start election (bully rule).
 */
function handleCoordinator(fromId, fromUrl) {
    if (fromId < state.id) {
        log("WARN", `COORDINATOR from ID=${fromId} but I have higher ID=${state.id} → rejecting, starting election`);
        startElection();
        return;
    }

    log("INFO", `COORDINATOR from ID=${fromId} → new leader: ${fromUrl}`);

    clearTimeout(electionTimer);
    clearTimeout(coordinatorTimer);
    electionInProgress = false;
    receivedAnswer = false;

    state.role = "follower";
    state.leader = fromId;
    state.leaderUrl = fromUrl;

    // Stop reaffirm if we were leader
    stopReaffirm();
}

// ── Leader Announcement ──────────────────────────────────────
async function becomeLeader() {
    state.role = "leader";
    state.leader = state.id;
    state.leaderUrl = state.url;

    log("INFO", `★ I am the new LEADER (ID=${state.id}) ★`);

    // Notify all alive peers
    const promises = state.peers
        .filter(p => p.alive)
        .map(peer =>
            axios.post(`${peer.url}/election/message`, {
                type: "COORDINATOR",
                from: { id: state.id, url: state.url },
                payload: {}
            }, { timeout: 3000 }).catch(() => null)
        );

    await Promise.all(promises);

    // Start periodic reaffirmation
    startReaffirm();
}

// ── Leader Reaffirmation ─────────────────────────────────────
function startReaffirm() {
    stopReaffirm();

    reaffirmInterval = setInterval(async () => {
        if (state.role !== "leader") {
            stopReaffirm();
            return;
        }

        const promises = state.peers
            .filter(p => p.alive)
            .map(peer =>
                axios.post(`${peer.url}/election/message`, {
                    type: "COORDINATOR",
                    from: { id: state.id, url: state.url },
                    payload: {}
                }, { timeout: 2000 }).catch(() => null)
            );

        await Promise.all(promises);
    }, REAFFIRM_INTERVAL_MS);
}

function stopReaffirm() {
    if (reaffirmInterval) {
        clearInterval(reaffirmInterval);
        reaffirmInterval = null;
    }
}

// ── Query ────────────────────────────────────────────────────
function getState() {
    return {
        id: state.id,
        url: state.url,
        role: state.role,
        leader: state.leader,
        leaderUrl: state.leaderUrl,
        peers: state.peers.map(p => ({
            id: p.id,
            url: p.url,
            alive: p.alive
        }))
    };
}

function isLeader() {
    return state.role === "leader";
}

function getLeaderUrl() {
    return state.leaderUrl;
}

function getPeerUrls() {
    return state.peers.map(p => p.url);
}

module.exports = {
    init,
    startElection,
    handleElection,
    handleAnswer,
    handleCoordinator,
    handlePing,
    getState,
    isLeader,
    getLeaderUrl,
    getPeerUrls
};
