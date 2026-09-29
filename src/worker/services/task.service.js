const axios = require("axios");

// Tiempo de lag configurable via variable de entorno (en ms).
// Permite simular que las tareas toman tiempo real de procesamiento.
const LAG_MS = Number(process.env.TASK_LAG_MS || 0);

// ---------------------------------------------------------------- capacidades

// Grupo G9 - GRIMALDO CHAUCANÉS SEBASTIAN (CAP 4: stats_compute)
//           - REYES GARCÍA OSCAR EDUARDO  (CAP 2: http_fetch)
// + capacidad propia: sort_numbers

const CAPABILITIES = ["stats_compute", "http_fetch"];

// ---------------------------------------------------------------- estado

const active = new Map();    // taskId -> { taskId, type, startedAt }
const completed = [];        // últimas N tareas terminadas
const MAX_COMPLETED = 50;

// ---------------------------------------------------------------- ejecución

async function execute(taskId, type, payload) {
    switch (type) {

        // CAP 4: Calcula promedio, mínimo y máximo de una lista de números.
        case "stats_compute": {
            const nums = payload.numbers;
            if (!Array.isArray(nums) || nums.length === 0) {
                throw new Error("'numbers' debe ser un array no vacío");
            }
            const mean = nums.reduce((s, n) => s + n, 0) / nums.length;
            const min = Math.min(...nums);
            const max = Math.max(...nums);
            return { mean: parseFloat(mean.toFixed(4)), min, max };
        }

        // CAP 2: Hace fetch a la URL y retorna el status.
        case "http_fetch": {
            const { url } = payload;
            if (!url) throw new Error("'url' es requerido");

            const start = Date.now();
            const res = await axios.get(url, { timeout: 5000 });
            const ms = Date.now() - start;

            return { status: res.status, ms };
        }

        default:
            throw new Error(`Capacidad desconocida: ${type}`);
    }
}

// ---------------------------------------------------------------- API pública

/**
 * Acepta una tarea, la registra como activa, espera el lag configurado,
 * la ejecuta y guarda el resultado en el historial.
 * Devuelve el objeto result para que el caller pueda hacer el POST /task/receive.
 */
async function runTask({ taskId, type, payload, log }) {
    if (!CAPABILITIES.includes(type)) {
        const err = new Error(`Este worker no soporta la capacidad: ${type}`);
        err.code = "UNSUPPORTED";
        throw err;
    }

    // Registrar como activa
    active.set(taskId, { taskId, type, startedAt: Date.now() });
    log("INFO", `Tarea recibida: ${taskId} (${type}), lag: ${LAG_MS}ms`);

    // Lag simulado
    if (LAG_MS > 0) {
        await new Promise(resolve => setTimeout(resolve, LAG_MS));
    }

    let entry;

    try {
        const result = await execute(taskId, type, payload || {});

        entry = {
            taskId,
            type,
            status: "ok",
            result,
            duration: Date.now() - active.get(taskId).startedAt,
            finishedAt: Date.now()
        };

        log("INFO", `Tarea completada: ${taskId} → ok`);

    } catch (err) {
        entry = {
            taskId,
            type,
            status: "error",
            error: err.message,
            duration: Date.now() - (active.get(taskId) ? active.get(taskId).startedAt : Date.now()),
            finishedAt: Date.now()
        };

        log("WARN", `Tarea fallida: ${taskId} → ${err.message}`);
    }

    active.delete(taskId);

    completed.unshift(entry);
    if (completed.length > MAX_COMPLETED) completed.pop();

    return entry;
}

/**
 * Carga actual del worker: proporción de tareas activas sobre el máximo
 * esperado (cap a 1.0). Es el valor que viaja en el pulso.
 */
function load() {
    // Asumimos que un worker "normal" maneja hasta 3 tareas simultáneas.
    return Math.min(1, active.size / 3);
}

module.exports = {
    CAPABILITIES,
    LAG_MS,
    runTask,
    load,
    activeList: () => [...active.values()],
    completedList: () => completed
};
