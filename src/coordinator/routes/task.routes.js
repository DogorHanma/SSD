const express = require("express");
const axios = require("axios");
const router = express.Router();

const registry = require("../services/registry");
const engine = require("../election/engine");
const config = require("../config");
const log = require("../utils/logger");

const HEADERS = { "ngrok-skip-browser-warning": "true" };

// Estado de tareas en el coordinador
const tasks = new Map();   // taskId -> { taskId, type, payload, worker, status, result, error, assignedAt, finishedAt }
let taskCounter = 0;

// GET /task/workers — lista de workers online con sus capabilities
router.get("/task/workers", async (req, res) => {
    const workers = registry.getAll().filter(s => s.online);
    const enriched = [];

    for (const w of workers) {
        try {
            const r = await axios.get(`${w.url}/task/capabilities`, { timeout: 3000, headers: HEADERS });
            enriched.push({
                name: w.name,
                url: w.url,
                online: true,
                capabilities: r.data.capabilities || [],
                load: r.data.load || 0,
                taskLagMs: r.data.taskLagMs || 0
            });
        } catch {
            // El worker no soporta tareas o no responde
            enriched.push({
                name: w.name,
                url: w.url,
                online: true,
                capabilities: [],
                load: 0,
                taskLagMs: 0
            });
        }
    }

    res.json(enriched);
});

// POST /task/send — asignar una tarea a un worker
router.post("/task/send", async (req, res) => {
    const { workerName, type, payload } = req.body;

    if (!workerName || !type) {
        return res.status(400).json({ error: "workerName y type son requeridos" });
    }

    const worker = registry.getAll().find(s => s.name === workerName && s.online);
    if (!worker) {
        return res.status(404).json({ error: `Worker '${workerName}' no encontrado o está offline` });
    }

    taskCounter++;
    const taskId = `task-${config.id}-${taskCounter}-${Date.now()}`;

    // Registrar la tarea como pendiente
    const taskEntry = {
        taskId,
        type,
        payload: payload || {},
        worker: workerName,
        workerUrl: worker.url,
        status: "sending",
        assignedAt: Date.now(),
        finishedAt: null,
        result: null,
        error: null
    };

    tasks.set(taskId, taskEntry);

    try {
        await axios.post(`${worker.url}/task/assign`, {
            taskId,
            type,
            payload: payload || {}
        }, { timeout: 5000, headers: HEADERS });

        taskEntry.status = "running";
        log("INFO", `Tarea ${taskId} (${type}) asignada a ${workerName}`);
        res.json({ taskId, status: "assigned", worker: workerName });

    } catch (err) {
        taskEntry.status = "error";
        taskEntry.error = err.message;
        taskEntry.finishedAt = Date.now();

        log("ERROR", `Error asignando tarea ${taskId} a ${workerName}: ${err.message}`);
        res.status(502).json({ error: `No se pudo asignar la tarea al worker: ${err.message}` });
    }
});

// POST /task/receive — el worker reporta el resultado de una tarea
router.post("/task/receive", (req, res) => {
    const { type: msgType, data } = req.body || {};

    if (msgType !== "task-result" || !data || !data.taskId) {
        return res.status(400).json({ error: "Formato inválido" });
    }

    const task = tasks.get(data.taskId);
    if (!task) {
        // Aceptamos de todas formas (el worker hizo su trabajo)
        log("WARN", `Resultado de tarea desconocida: ${data.taskId}`);
        return res.json({ message: "Resultado recibido (tarea no encontrada en este nodo)" });
    }

    task.status = data.status;
    task.result = data.result || null;
    task.error = data.error || null;
    task.finishedAt = Date.now();

    log("INFO", `Resultado de tarea ${data.taskId}: ${data.status}`);
    res.json({ message: "Resultado recibido" });
});

// GET /task/list — historial de tareas
router.get("/task/list", (req, res) => {
    const list = [...tasks.values()].sort((a, b) => b.assignedAt - a.assignedAt);
    res.json(list);
});

module.exports = router;
