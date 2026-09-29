// Punto de entrada para iniciar un Worker independiente
// Uso: node worker.js {PUERTO} {NOMBRE} {URL_COORDINADOR} {URL_PUBLICA_WORKER}
// Ej:  node worker.js 4000 A https://coord-compa.ngrok.dev https://mi-worker.ngrok.dev

const port = process.argv[2];
const name = process.argv[3];
const coordinatorUrl = process.argv[4];
const publicUrl = process.argv[5];

if (!port || !name || !coordinatorUrl) {
    console.error("❌ Faltan argumentos.");
    console.error("Uso: node worker.js <PUERTO> <NOMBRE> <URL_COORDINADOR> [URL_PUBLICA_WORKER]");
    console.error("Ejemplo LAN: node worker.js 4000 A http://192.168.1.10:3000 http://192.168.1.12:4000");
    console.error("Ejemplo WAN: node worker.js 4000 A https://coord.ngrok.app https://mi-worker.ngrok.app");
    process.exit(1);
}

// Sobreescribir las variables de entorno para el worker
process.env.PORT = port;
if (publicUrl) {
    process.env.WORKER_PUBLIC_URL = publicUrl;
} else {
    // Si no pasa URL pública, asumimos que es LAN y tratamos de usar la IP local o localhost
    console.warn("⚠️ No especificaste URL pública del worker. Se usará localhost.");
    console.warn("   Si el coordinador está en otra red, NO podrá asignarte tareas.");
}

require('./src/worker/index.js');
