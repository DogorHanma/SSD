const express = require("express");
const router = express.Router();
const axios = require("axios");

const processManager = require("../services/processManager");
const registry = require("../services/registry");
const messages = require("../services/messages");
const engine = require("../election/engine");
const config = require("../config");
const faults = require("../election/faults");
const log = require("../utils/logger");

function clientId(req) {
    return String(req.ip || "").replace(/^::ffff:/, "");
}

// La vista del cluster que se le adjunta al worker en cada respuesta. Gracias
// a esto el worker no necesita configuracion: aprende solo a quien preguntar
// cuando su coordinador desaparezca.
function clusterView() {
    if (!config.electionEnabled) return {};

    return {
        leader: engine.leaderUrl(),
        leaderId: engine.state.leader,
        peers: engine.peerUrls()
    };
}

// Las ESCRITURAS solo las atiende el lider. Si llega a otro nodo, se le dice
// al cliente quien manda ahora y este se redirige (asi encuentran al lider
// los clientes de Raft). Las LECTURAS las sirve cualquiera.
function rejectIfNotLeader(req, res) {
    if (!config.electionEnabled) return false;

    // Nodo congelado: no puede participar en la eleccion, asi que tampoco
    // puede atender clientes. Si siguiera respondiendo, un lider "muerto"
    // retendria a sus workers para siempre y el failover no se veria nunca.
    if (faults.state.paused) {
        res.status(503).json({
            error: "Nodo fuera de servicio",
            retry: true,
            peers: engine.peerUrls()
        });
        return true;
    }

    if (engine.isLeader()) return false;

    const leader = engine.leaderUrl();

    // Todavia no hay lider: eleccion en curso. No es un error del cliente,
    // es que el sistema aun no sabe quien manda. Que reintente.
    if (!leader) {
        res.status(503).json({
            error: "Eleccion en curso, todavia no hay lider",
            retry: true,
            ...clusterView()
        });
        return true;
    }

    // Le decimos al cliente quien es el lider actual para que se redirija (el worker "cambia de padre")
    res.status(409).json({
        error: "No soy el lider",
        ...clusterView()
    });
    return true;
}

// Health
router.get("/health", (req, res) => {
    res.json({ ok: true, id: config.id, role: engine.state.role, leader: engine.state.leader });
});

// Create
router.post("/create-server", (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "Name required" });

    const { port } = processManager.createServer(name);
    res.json({ message: `${name} created on port ${port}` });
});

// Register
router.post("/register", (req, res) => {
    const { name, url } = req.body;
    if (!name || !url)
        return res.status(400).json({ error: "Name and URL required" });

    if (rejectIfNotLeader(req, res)) return;

    const owner = clientId(req);
    const claimed = registry.claimedBy(name);

    // Un nombre pertenece a la maquina que lo reclamo primero
    if (claimed && claimed !== owner) return res.status(409).json({ error: `Name "${name}" is already taken by another machine. Pick a different one.` });

    registry.register(name, url, owner);
    res.json({ message: "Server registered successfully", ...clusterView() });
});

// Pulse
router.post("/pulse/:name", (req, res) => {
    if (rejectIfNotLeader(req, res)) return;

    const ok = registry.pulse(req.params.name);
    if (!ok) return res.status(404).json({ error: "Server not found", ...clusterView() });

    res.json({ message: "Pulse received", ...clusterView() });
});

// Kill
router.post("/kill-server/:name", (req, res) => {
    const killed = processManager.killServer(req.params.name);
    if (!killed) return res.status(404).json({ error: "Server not found" });

    registry.remove(req.params.name);
    res.json({ message: `${req.params.name} killed` });
});

// List
router.get("/servers", (req, res) => {
    res.json(registry.getAll());
});

// Overview
router.get("/overview", (req, res) => {
    res.json(registry.getAll().map(server => ({
        ...server,
        messages: messages.get(server.name)
    })));
});

// Receive a message from a mini server
router.post("/send-message/:name", (req, res) => {
    const { name } = req.params;
    const { message } = req.body;

    if (!message) return res.status(400).json({ error: "Message required" });
    if (rejectIfNotLeader(req, res)) return;
    if (!registry.exists(name)) return res.status(404).json({ error: "Server not found" });
    if (registry.claimedBy(name) !== clientId(req)) return res.status(403).json({ error: `Only ${name}'s own machine can send messages as ${name}` });

    const entry = messages.add(name, message);
    res.status(201).json(entry);
});

// Read the messages of a mini server
router.get("/send-message/:name", (req, res) => {
    res.json(messages.get(req.params.name));
});

/* ------------------------------------------------------------------ tareas -- */

// Almacen de tareas en memoria.
// En produccion esto seria una base de datos, pero para la demo en clase basta.
const tasks = new Map(); // taskId -> { taskId, type, workerName, workerUrl, assignedAt, status, result?, error? }

// POST /task/assign
// El coordinador (solo el lider) selecciona al worker mas apropiado según
// las capacidades requeridas y le envia la tarea via POST /task/assign en el worker.
router.post("/task/assign", async (req, res) => {
    if (rejectIfNotLeader(req, res)) return;

    const { type, payload } = req.body || {};
    if (!type) return res.status(400).json({ error: "'type' (capacidad requerida) es obligatorio" });

    // Buscar workers registrados que declaren esa capacidad.
    // Primero consultamos sus capacidades via GET /task/capabilities.
    const allWorkers = registry.getAll().filter(w => w.online);

    let chosen = null;
    let bestLoad = Infinity;

    const HEADERS = { "ngrok-skip-browser-warning": "true" };

    for (const worker of allWorkers) {
        try {
            const r = await axios.get(`${worker.url}/task/capabilities`, { timeout: 3000, headers: HEADERS });
            const caps = r.data.capabilities || [];
            const load = r.data.load || 0;

            if (caps.includes(type) && load < bestLoad) {
                bestLoad = load;
                chosen = { ...worker, load };
            }
        } catch {
            // Worker inalcanzable, se ignora en esta ronda.
        }
    }

    if (!chosen) {
        return res.status(422).json({
            error: `No hay workers disponibles con la capacidad: ${type}`,
            onlineWorkers: allWorkers.length
        });
    }

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    const taskEntry = {
        taskId,
        type,
        payload: payload || {},
        workerName: chosen.name,
        workerUrl: chosen.url,
        assignedAt: Date.now(),
        status: "pending"
    };

    tasks.set(taskId, taskEntry);

    // Enviar la tarea al worker.
    try {
        await axios.post(
            `${chosen.url}/task/assign`,
            { taskId, type, payload: payload || {} },
            { timeout: 5000, headers: HEADERS }
        );

        taskEntry.status = "running";
        log("INFO", `Tarea ${taskId} (${type}) asignada a ${chosen.name} (load ${bestLoad.toFixed(2)})`);

        res.status(202).json({ taskId, worker: chosen.name, workerUrl: chosen.url, status: "running" });

    } catch (err) {
        taskEntry.status = "error";
        taskEntry.error = `No se pudo contactar al worker: ${err.message}`;

        log("ERROR", `No pude enviar la tarea ${taskId} a ${chosen.name}: ${err.message}`);
        res.status(502).json({ error: `Worker inalcanzable: ${err.message}`, taskId });
    }
});

// POST /task/receive
// El worker llama a este endpoint cuando termina de ejecutar una tarea.
// Recibe el mensaje con formato { type: "task-result", data: { taskId, status, result? | error? } }
router.post("/task/receive", (req, res) => {
    const body = req.body || {};

    // Acepta tanto el sobre completo { type, data } como el data directo.
    const data = (body.type === "task-result" ? body.data : body) || {};
    const { taskId, status, result, error } = data;

    if (!taskId || !status) {
        return res.status(400).json({ error: "taskId y status son requeridos" });
    }

    const task = tasks.get(taskId);

    if (task) {
        task.status = status;
        task.finishedAt = Date.now();
        task.duration = task.finishedAt - task.assignedAt;

        if (status === "ok")   task.result = result;
        if (status === "error") task.error = error;

        log("INFO", `Resultado recibido de tarea ${taskId}: ${status}`);
    } else {
        log("WARN", `Resultado de tarea desconocida: ${taskId}`);
    }

    res.json({ ok: true, taskId });
});

// GET /task/results
// Lista el historial de tareas conocidas por este coordinador.
router.get("/task/results", (req, res) => {
    res.json([...tasks.values()].sort((a, b) => b.assignedAt - a.assignedAt));
});

module.exports = router;
