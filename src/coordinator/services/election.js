const axios = require("axios");
const log = require("../utils/logger");
const registry = require("./registry");

// ── State ────────────────────────────────────────────────────
let state = {
    id: null,
    url: null,
    peers: [],          // URLs of other coordinators
    role: "follower",   // "leader" | "follower"
    leader: null,       // URL of current leader
    leaderId: null,     // ID of current leader
};

let electionInProgress = false;
let receivedAnswer = false;
let pingInterval = null;
let electionTimer = null;
let coordinatorTimer = null;
let missedPings = 0;

// ── Timings ──────────────────────────────────────────────────
const PING_INTERVAL_MS = 5000;
const ELECTION_TIMEOUT_MS = 3000;
const COORDINATOR_TIMEOUT_MS = 6000;
const MAX_MISSED_PINGS = 2;
const STARTUP_DELAY_MS = 3000;

// ── Init ─────────────────────────────────────────────────────
function init({ id, url, peers }) {
    state.id = Number(id);
    state.url = url;
    state.peers = peers.filter(p => p !== url);

    log("INFO", `Election init: ID=${state.id}, URL=${state.url}`);
    log("INFO", `Peers: ${state.peers.join(", ") || "none"}`);

    if (state.peers.length === 0) {
        // Solo coordinator, become leader immediately
        becomeLeader();
        return;
    }

    // Give peers time to start, then trigger first election
    setTimeout(() => startElection(), STARTUP_DELAY_MS);
}

// ── Bully Election ──────────────────────────────────────────
function startElection() {
    if (electionInProgress) return;

    electionInProgress = true;
    receivedAnswer = false;

    log("INFO", `Starting election (ID=${state.id})...`);

    // Send ELECTION to all peers; only higher-priority ones will ANSWER
    state.peers.forEach(peerUrl => {
        axios.post(`${peerUrl}/election/message`, {
            type: "ELECTION",
            fromId: state.id,
            fromUrl: state.url
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
        startElection();
    }, COORDINATOR_TIMEOUT_MS);
}

// ── Message Handlers ─────────────────────────────────────────

/**
 * Received ELECTION from another node.
 * If we have higher priority (lower ID), we ANSWER and start our own election.
 */
function handleElection(fromId, fromUrl) {
    if (state.id < fromId) {
        log("INFO", `ELECTION from ID=${fromId} → I have higher priority → ANSWER`);

        // Send ANSWER back
        axios.post(`${fromUrl}/election/message`, {
            type: "ANSWER",
            fromId: state.id,
            fromUrl: state.url
        }, { timeout: 2000 }).catch(() => {});

        // Start our own election (if not already running)
        if (!electionInProgress) {
            startElection();
        }

        return { answered: true };
    }

    log("INFO", `ELECTION from ID=${fromId} → They have higher priority → ignored`);
    return { answered: false };
}

/**
 * Received ANSWER: a higher-priority node is alive → back down.
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
 */
function handleCoordinator(fromId, fromUrl) {
    log("INFO", `COORDINATOR from ID=${fromId} → new leader: ${fromUrl}`);

    clearTimeout(electionTimer);
    clearTimeout(coordinatorTimer);
    electionInProgress = false;
    receivedAnswer = false;

    state.role = "follower";
    state.leader = fromUrl;
    state.leaderId = fromId;
    missedPings = 0;

    startPingLeader();
}

// ── Leader Announcement ──────────────────────────────────────
async function becomeLeader() {
    state.role = "leader";
    state.leader = state.url;
    state.leaderId = state.id;

    log("INFO", `★ I am the new LEADER (ID=${state.id}) ★`);

    stopPingLeader();

    // Notify all peers
    const promises = state.peers.map(peerUrl =>
        axios.post(`${peerUrl}/election/message`, {
            type: "COORDINATOR",
            fromId: state.id,
            fromUrl: state.url
        }, { timeout: 3000 }).catch(() => null)
    );

    await Promise.all(promises);

    // Notify registered workers so they switch parent
    notifyWorkers();
}

async function notifyWorkers() {
    const servers = registry.getAll();

    for (const server of servers) {
        if (!server.url) continue;

        try {
            await axios.post(`${server.url}/parent`, {
                url: state.url
            }, { timeout: 3000 });

            log("INFO", `Notified worker [${server.name}] of new leader`);
        } catch {
            log("WARN", `Could not notify worker [${server.name}]`);
        }
    }
}

// ── Ping Leader ──────────────────────────────────────────────
function startPingLeader() {
    stopPingLeader();

    if (state.role === "leader") return;

    missedPings = 0;

    pingInterval = setInterval(async () => {
        if (!state.leader || state.role === "leader") return;

        try {
            await axios.post(`${state.leader}/election/ping`, {
                from: state.id
            }, { timeout: 3000 });

            missedPings = 0;
        } catch {
            missedPings++;
            log("WARN", `Ping to leader failed (${missedPings}/${MAX_MISSED_PINGS})`);

            if (missedPings >= MAX_MISSED_PINGS) {
                log("ERROR", `Leader ID=${state.leaderId} is DOWN → starting election`);
                stopPingLeader();
                state.leader = null;
                state.leaderId = null;
                startElection();
            }
        }
    }, PING_INTERVAL_MS);
}

function stopPingLeader() {
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
    }
}

// ── Query ────────────────────────────────────────────────────
function getState() {
    return {
        id: state.id,
        url: state.url,
        role: state.role,
        leader: state.leader,
        leaderId: state.leaderId,
        peers: state.peers
    };
}

function isLeader() {
    return state.role === "leader";
}

module.exports = {
    init,
    startElection,
    handleElection,
    handleAnswer,
    handleCoordinator,
    getState,
    isLeader
};
