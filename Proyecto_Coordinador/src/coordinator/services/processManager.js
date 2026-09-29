const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const config = require("../config");
const log = require("../utils/logger");

let serverProcesses = {};
let nextPort = Number(process.env.WORKER_PORT_BASE || 4000);

function createServer(name) {
    const port = nextPort++;

    const workerPath = path.resolve(__dirname, "../../worker/index.js");

    // El worker tiene que registrarse en la URL publica de este coordinador
    const middlewareUrl = process.env.MIDDLEWARE_URL || config.publicUrl;

    const child = spawn("node", [workerPath, port, name, middlewareUrl], {
        env: { ...process.env, WORKER_PUBLIC_URL: process.env.WORKER_PUBLIC_URL || `http://localhost:${port}` }
    });

    if (!fs.existsSync("logs")) {
        fs.mkdirSync("logs");
    }

    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    const logStream = fs.createWriteStream(`logs/${safeName}.log`, { flags: "a" });

    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);

    child.on("close", (code) => {
        log("INFO", `Server [${name}] exited with code ${code}`);
    });

    serverProcesses[name] = { process: child, port };

    log("INFO", `Started [${name}] on http://localhost:${port}`);

    return { port };
}

function killServer(name) {
    if (!serverProcesses[name]) return false;

    serverProcesses[name].process.kill();
    delete serverProcesses[name];

    log("INFO", `Killed [${name}]`);

    return true;
}

function getProcesses() {
    return serverProcesses;
}

module.exports = {
    createServer,
    killServer,
    getProcesses
};
