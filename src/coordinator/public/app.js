const input = document.getElementById("nameInput");
const button = document.getElementById("createBtn");
const list = document.getElementById("serverList");
const reloadBtn = document.getElementById("reloadBtn");
const lastUpdate = document.getElementById("lastUpdate");

button.addEventListener("click", createServer);
reloadBtn.addEventListener("click", loadServers);

function escapeHtml(text) {
    return String(text)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;");
}

// ── Election State ──────────────────────────────────────────
async function renderElectionState() {
    try {
        const res = await fetch("/election/state");
        const st = await res.json();

        // My identity
        document.getElementById("myId").textContent = `ID: ${st.id}`;
        document.getElementById("myUrl").textContent = st.url || "—";

        // Role badge
        const roleBadge = document.getElementById("roleBadge");
        const roleIcon = document.getElementById("roleIcon");
        const roleText = document.getElementById("roleText");

        roleBadge.className = "role-badge";

        if (st.role === "leader") {
            roleBadge.classList.add("role-leader");
            roleIcon.textContent = "👑";
            roleText.textContent = "★ SOY EL LÍDER ★";
        } else if (st.role === "candidate") {
            roleBadge.classList.add("role-candidate");
            roleIcon.textContent = "🗳️";
            roleText.textContent = "ELIGIENDO...";
        } else {
            roleBadge.classList.add("role-follower");
            roleIcon.textContent = "👤";
            roleText.textContent = "FOLLOWER";
        }

        // Leader info
        const leaderName = document.getElementById("leaderName");
        const leaderUrl = document.getElementById("leaderUrl");

        if (st.leader != null) {
            const isMe = st.leader === st.id;
            leaderName.textContent = isMe ? `ID ${st.leader} (yo)` : `ID ${st.leader}`;
            leaderUrl.textContent = st.leaderUrl || "—";
        } else {
            leaderName.textContent = "Sin líder";
            leaderUrl.textContent = "Elección en curso...";
        }

        // Peers
        const peerList = document.getElementById("peerList");
        document.getElementById("peerCount").textContent = st.peers ? st.peers.length : 0;

        if (st.peers && st.peers.length > 0) {
            peerList.innerHTML = st.peers.map(peer => {
                const aliveClass = peer.alive ? "peer-alive" : "peer-dead";
                const statusDot = peer.alive ? "online" : "offline";
                const statusText = peer.alive ? "online" : "no responde";
                const isLeader = st.leaderUrl === peer.url;
                const leaderTag = isLeader ? '<span class="peer-leader-tag">LÍDER</span>' : '';

                return `
                    <li class="peer-item ${aliveClass}">
                        <div class="peer-main">
                            <span class="dot ${statusDot}"></span>
                            <span class="peer-id">${peer.id != null ? `ID: ${peer.id}` : "ID: ?"}</span>
                            ${leaderTag}
                        </div>
                        <div class="peer-meta">
                            <span class="peer-url">${escapeHtml(peer.url)}</span>
                            <span class="peer-status-text">${statusText}</span>
                        </div>
                    </li>
                `;
            }).join("");
        } else {
            peerList.innerHTML = '<li class="peer-item peer-empty">Sin peers conocidos</li>';
        }

    } catch (err) {
        console.error("Error fetching election state:", err);
    }
}

// Auto-refresh election state every 2s
setInterval(renderElectionState, 2000);
renderElectionState();

// ── Server Management ───────────────────────────────────────
async function createServer() {
    const name = input.value.trim();
    if (!name) return;

    await fetch("/create-server", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
    });

    input.value = "";
    loadServers();
}

async function loadServers() {
    reloadBtn.disabled = true;
    reloadBtn.innerText = "Loading...";

    try {
        await renderServers();
        lastUpdate.innerText = `actualizado ${new Date().toLocaleTimeString()}`;
    } catch {
        lastUpdate.innerText = "no se pudo actualizar";
    }

    reloadBtn.disabled = false;
    reloadBtn.innerText = "Reload";
}

async function renderServers() {
    const res = await fetch("/overview");
    const servers = await res.json();

    list.innerHTML = "";

    servers.forEach(server => {
        const items = server.messages.length
            ? server.messages.map(entry => `
                <li class="message">
                    <span>${escapeHtml(entry.message)}</span>
                    <time>${new Date(entry.at).toLocaleTimeString()}</time>
                </li>
            `).join("")
            : `<li class="message empty">Sin mensajes</li>`;

        const li = document.createElement("li");

        const state = server.online ? "online" : "offline";
        const url = server.url || "";

        li.innerHTML = `
            <div class="server-head">
                <strong>
                    <span class="dot ${state}" title="${state}"></span>
                    ${escapeHtml(server.name)}
                </strong>
                <span class="meta">${server.messages.length} msg</span>
            </div>
            <div class="server-addr">
                <a href="${encodeURI(url)}" target="_blank">${escapeHtml(url || "sin url")}</a>
                <span class="ip">${escapeHtml(server.owner || "?")}</span>
            </div>
            <ul class="messages">${items}</ul>
        `;

        list.appendChild(li);
    });
}

loadServers();
