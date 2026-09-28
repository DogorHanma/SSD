const config = require("./config");
const app = require("./app");
const startCleanup = require("./services/cleanup");
const engine = require("./election/engine");
const registry = require("./services/registry");
const messages = require("./services/messages");
const protocol = require("./services/examProtocol");
const log = require("./utils/logger");

app.listen(config.port, () => {
    log("INFO", `Coordinator [${config.id}] escuchando en http://localhost:${config.port}`);
    log("INFO", `URL publica: ${config.publicUrl}`);

    // Inicializar el protocolo del examen
    protocol.init({ id: config.id, url: config.publicUrl });
    protocol.startHeartbeat(2000);

    if (!config.electionEnabled) {
        log("WARN", "Eleccion desactivada (ELECTION=off): coordinador unico, con SPOF");
        return;
    }

    engine.init(config, {
        dataVersion: () => registry.getAll().length + Object.values(messages.getAll()).reduce((total, list) => total + list.length, 0),

        // Los workers registrados aqui viajan en la foto del nodo, para que el
        // panel pueda ensenar a que coordinador esta enganchado cada worker.
        workers: () => registry.getAll().map(server => ({ name: server.name, online: server.online }))
    });

    engine.start();
});

startCleanup();