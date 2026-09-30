const axios = require("axios");

// Tiempo de lag configurable via variable de entorno (en ms).
// Permite simular que las tareas toman tiempo real de procesamiento.
const LAG_MS = Number(process.env.TASK_LAG_MS || 0);

// ---------------------------------------------------------------- capacidades

// Grupo G9 - GRIMALDO CHAUCANÉS SEBASTIAN (CAP 4: stats_compute)
//           - REYES GARCÍA OSCAR EDUARDO  (CAP 2: http_fetch)
// + capacidad propia: sort_numbers

const CAPABILITIES_LIST = [
    {
        name: "stats_compute",
        description: "Calcula promedio, mínimo y máximo de una lista de números.",
        payload: {
            numbers: [1, 2, 3, 4, 5]
        },
        expectedResult: {
            mean: 3.0000,
            min: 1,
            max: 5
        }
    },
    {
        name: "http_fetch",
        description: "Hace fetch a una URL y retorna el status.",
        payload: {
            url: "https://www.google.com"
        },
        expectedResult: {
            status: 200,
            ms: 125
        }
    },
    {
        name: "sort_numbers",
        description: "Ordena una lista de números de menor a mayor.",
        payload: {
            numbers: [9, 2, 5, 1, 7]
        },
        expectedResult: {
            sorted: [1, 2, 5, 7, 9]
        }
    }
];

const CAPABILITIES = CAPABILITIES_LIST.map(c => c.name);
// ---------------------------------------------------------------- estado

const active = new Map();    // taskId -> { taskId, type, startedAt }
const completed = [];        // últimas N tareas terminadas
const MAX_COMPLETED = 50;

// ---------------------------------------------------------------- ejecución

async function execute(taskId, type, payload) {
    switch (type) {

        // CAP 4: Calcula promedio, mínimo y máximo de una lista de números.
        case "stats_compute": {
            let nums = payload.numbers;
            // Tolerancia a fallos: si el coordinador lo manda como string, lo parseamos
            if (typeof nums === 'string') {
                try { nums = JSON.parse(nums); } catch(e) {}
            }

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

        // Capacidad propia: Ordenar números
        case "sort_numbers": {
            let nums = payload.numbers;
            // Tolerancia a fallos: si el coordinador lo manda como string, lo parseamos
            if (typeof nums === 'string') {
                try { nums = JSON.parse(nums); } catch(e) {}
            }

            if (!Array.isArray(nums)) throw new Error("'numbers' debe ser un array");
            return { sorted: [...nums].sort((a, b) => a - b) };
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
    CAPABILITIES_LIST,
    LAG_MS,
    runTask,
    load,
    activeList: () => [...active.values()],
    completedList: () => completed
};
