// Punto de entrada para iniciar un Worker independiente
// Uso: node worker.js {PUERTO} {URL_PUBLICA_WORKER}
// Ej:  node worker.js 4000 https://mi-worker.ngrok.dev

const port = process.argv[2] || process.env.PORT;
const publicUrl = process.argv[3] || process.env.WORKER_PUBLIC_URL;

// Usamos dotenv si existe para cargar variables
require('dotenv').config();

const nombre = process.env.WORKER_NOMBRE || "juan";
const codigo = process.env.WORKER_CODIGO || "123456";
const coordinatorUrl = process.env.COORDINATOR_URL || "";

if (!port) {
    console.error("❌ Faltan argumentos.");
    console.error("Uso: node worker.js <PUERTO> [URL_PUBLICA_WORKER]");
    console.error("Ejemplo: node worker.js 4000 https://mi-worker.ngrok.app");
    process.exit(1);
}

// Configurar el entorno para que src/worker/index.js lo lea
process.env.PORT = port;
if (publicUrl) {
    process.env.WORKER_PUBLIC_URL = publicUrl;
} else {
    console.warn("⚠️ No especificaste URL pública del worker. Se usará localhost.");
}

process.env.WORKER_NAME = `worker-${nombre}-${codigo}`;
process.env.COORDINATOR_URL = coordinatorUrl;

require('./src/worker/index.js');
