const axios = require("axios");

const createApp = require("./app");
const createLogger = require("./utils/logger");
const pulse = require("./services/pulse.service");
const messageService = require("./services/message.service");
const journal = require("./services/journal.service");

const PORT = process.argv[2];
const NAME = process.argv[3];

if (!PORT || !NAME) {
    console.error("PORT and NAME required");
    process.exit(1);
}

let parent = process.argv[4];

const PUBLIC_URL = (process.env.WORKER_PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const PULSE_INTERVAL = Number(process.env.PULSE_INTERVAL || 2000);

const log = createLogger(NAME);
const app = createApp({ port: PORT, name: NAME });

let hunting = false;
let retryHandle = null;

let lastPulseAt = 0;
let status = "arrancando";

// Cada respuesta del coordinador trae la lista de sus companeros. Asi es como
// el worker acaba conociendo a todo el cluster sin tener ni una url a mano.
function rememberPeers(view) {
    if (!view) return;

    // Ojo: forEach pasa (elemento, indice), asi que hay que envolverlo o el
    // indice acabaria colandose como si fuera el nombre del coordinador.
    [...(view.peers || []), view.leader, parent].filter(Boolean).forEach(url => journal.remember(url));

    if (view.leader) journal.markLeader(view.leader, view.leaderId);
}

/* ------------------------------------------------------------- registro -- */
function startPulsing() {
    pulse.startPulse({
        name: NAME,
        middlewareUrl: parent,
        log,
        interval: PULSE_INTERVAL,

        onView: view => {
            const first = !lastPulseAt;

            lastPulseAt = Date.now();
            status = "conectado";

            rememberPeers(view);

            if (first) journal.write("pulso", `Pulso aceptado por ${journal.name(parent)}. Estoy en linea.`);
        },

        onRedirect: url => {
            status = "redirigido";
            journal.mark(parent, "follower", "me redirigio");
            journal.write("redirect", `${journal.name(parent)} me responde 409: ya no manda el, ahora manda ${journal.name(url)}`);

            connectTo(url).catch(() => huntForLeader().catch(scheduleRetry));
        },

        onLost: reason => {
            status = "buscando";

            if (reason === "unreachable") {
                journal.mark(parent, "down", "no responde");
                journal.write("caida", `${journal.name(parent)} ha dejado de responder. Me quedo sin coordinador.`);
            } else if (reason === "unregistered") {
                journal.write("caida", `${journal.name(parent)} ya no me tiene registrado (se reinicio).`);
            } else {
                journal.write("caida", `${journal.name(parent)} no sabe quien es el lider.`);
            }

            huntForLeader().catch(scheduleRetry);
        }
    });
}

// Registrarse en un coordinador. Si ese coordinador no es el lider, contesta con un 409 diciendo quien lo es y seguimos el salto 
// (maximo 3, por si dos nodos se apuntan el uno al otro durante una eleccion).
async function connectTo(url, hops = 0) {
    const target = String(url).replace(/\/+$/, "");

    try {
        const data = await pulse.register({ name: NAME, url: PUBLIC_URL, middlewareUrl: target });

        pulse.stopPulse();
        if (retryHandle) clearTimeout(retryHandle);

        parent = target;
        lastPulseAt = 0;
        status = "conectado";

        rememberPeers(data);
        journal.markLeader(target);
        journal.write("registro", `Registrado en ${journal.name(target)}. Ahora es mi coordinador.`);

        startPulsing();

        log("INFO", `Registrado en ${parent}`);
        return parent;

    } catch (err) {
        if (err.peers && err.peers.length) rememberPeers({ peers: err.peers });

        if (err.redirectTo && hops < 3) {
            journal.mark(target, "follower", "no es el lider");
            journal.write("salto", `${journal.name(target)} no es el lider, me manda a ${journal.name(err.redirectTo)}`);

            log("INFO", `${target} no es el lider, salto a ${err.redirectTo}`);
            return connectTo(err.redirectTo, hops + 1);
        }

        throw err;
    }
}

/* ------------------------------------------------- busqueda del lider -- */
// Camino lento: el coordinador murio sin decir nada. Recorro los peers que habia ido cacheando y le pregunto a cada uno quien manda ahora.
async function huntForLeader() {
    if (hunting) return null;

    hunting = true;
    status = "buscando";

    // Los que ya he descartado en ESTA ronda. Sin esto, si el resto del
    // cluster todavia cree que manda el nodo caido, me mandan a el una y otra
    // vez y pierdo la ronda entera insistiendo con un muerto.
    const descartados = new Set();

    const candidates = [...new Set([...journal.urls(), parent].filter(Boolean))];

    journal.write("busqueda", `Nadie me manda. Voy a preguntar a los ${candidates.length} coordinadores que conozco.`);
    log("WARN", `Buscando al nuevo lider entre ${candidates.length} coordinadores conocidos`);

    try {
        for (const url of candidates) {
            if (descartados.has(url)) continue;

            let state;

            try {
                const res = await axios.get(`${url}/election/state`, { timeout: 2500, headers: pulse.HEADERS });
                state = res.data;
            } catch {
                descartados.add(url);
                journal.mark(url, "down", "no responde");
                journal.write("pregunta", `Pregunto a ${journal.name(url)}... no responde.`);
                continue;   // ese tampoco responde, siguiente
            }

            if (!state) continue;

            // Aprovecho para ampliar mi lista con los peers que conoce el.
            if (state.peers) rememberPeers({ peers: state.peers.map(peer => peer.url) });
            journal.remember(url, state.id);

            // Un nodo congelado sigue contestando con la foto de antes de pausarse: dice ser lider pero no atiende a nadie. No me sirve.
            if (state.faults && state.faults.paused) {
                descartados.add(url);
                journal.mark(url, "down", "congelado", state.id);
                journal.write("pregunta", `Pregunto a ${state.id || url}... dice ser lider, pero esta congelado. No me fio.`);
                continue;
            }

            // Este se cree el lider: me registro con el.
            if (state.role === "leader") {
                journal.write("pregunta", `Pregunto a ${state.id || url}... dice que manda el (term ${state.term}). Voy.`);

                try {
                    await connectTo(url);
                    return url;
                } catch {
                    descartados.add(url);
                    journal.write("pregunta", `${state.id || url} decia ser lider pero me ha rechazado. Sigo.`);
                    continue;   // se creia lider pero me rechazo; siguiente
                }
            }

            // No es el lider pero sabe quien es: voy directo alli.
            if (state.leaderUrl && !descartados.has(state.leaderUrl)) {
                journal.mark(url, "follower", null, state.id);
                journal.write("pregunta", `Pregunto a ${state.id || url}... no manda el, dice que manda ${state.leader}. Voy alli.`);

                try {
                    await connectTo(state.leaderUrl);
                    return state.leaderUrl;
                } catch {
                    // Ese lider ya no vale; sigo preguntando a los demas.
                    descartados.add(state.leaderUrl);
                    journal.write("pregunta", `${state.leader} tampoco me acepta. Lo descarto.`);
                }
            } else {
                journal.mark(url, "follower", "sin lider", state.id);
                journal.write("pregunta", `Pregunto a ${state.id || url}... tampoco sabe quien manda. Hay eleccion en curso.`);
            }
        }

        // Nadie sabe quien manda: hay eleccion en curso. Reintento en breve.
        status = "sin lider";
        journal.write("espera", "Nadie sabe quien manda todavia. Reintento en 2s.");

        log("WARN", "Todavia no hay lider; reintento en 2s");
        scheduleRetry();
        return null;

    } finally {
        hunting = false;
    }
}

function scheduleRetry() {
    if (retryHandle) clearTimeout(retryHandle);
    retryHandle = setTimeout(() => { huntForLeader().catch(() => scheduleRetry()); }, 2000);
}

/* -------------------------------------------------------------- arranque -- */
app.listen(PORT, async () => {
    log("INFO", `Server started on port ${PORT} (${PUBLIC_URL})`);

    journal.write("arranque", `Arranco. Me han dicho que mi coordinador es ${parent}.`);

    try {
        await connectTo(parent);
    } catch {
        // El registro inicial fallo. Antes el nodo se quedaba zombi: vivo, sin padre y sin volver a intentarlo jamas. Ahora insiste.
        status = "buscando";
        journal.write("caida", `No he podido registrarme en ${journal.name(parent)}. Voy a buscar a otro.`);

        log("ERROR", `No pude registrarme en ${parent}, sigo intentandolo`);
        huntForLeader().catch(scheduleRetry);
    }
});

app.get("/parent", (req, res) => {
    res.json({ parent, knownPeers: journal.urls(), publicUrl: PUBLIC_URL });
});

// Todo lo que este worker sabe y como se ha enterado. Lo consume su propia UI,
// que corre en la misma maquina: no cuesta ni una peticion por el tunel.
app.get("/status", (req, res) => {
    res.json({
        name: NAME,
        port: PORT,
        publicUrl: PUBLIC_URL,
        parent,
        status,
        hunting,
        lastPulseAt,
        sincePulse: lastPulseAt ? Date.now() - lastPulseAt : null,
        pulseInterval: PULSE_INTERVAL,
        coordinators: journal.list(),
        journal: journal.history()
    });
});

// Cambiar de padre en caliente
app.post("/parent", async (req, res) => {
    const { url } = req.body;

    if (!url) return res.status(400).json({ error: "URL required" });

    const previous = parent;

    try {
        await connectTo(url);
        res.json({ message: `Now registered with ${parent}`, parent, previous });

    } catch (err) {
        // Seguimos con el padre anterior: connectTo no llego a cambiar nada
        if (err.response) {
            log("ERROR", `${url} rejected us (${err.response.status})`);
            return res.status(err.response.status).json(err.response.data);
        }

        log("ERROR", `Could not reach ${url}`);
        res.status(502).json({ error: `Could not reach ${url}` });
    }
});

// El front le manda el mensaje a SU mini server, y este lo reenvia al coordinador
app.post("/send-message", async (req, res) => {
    const { message } = req.body;

    if (!message) return res.status(400).json({ error: "Message required" });

    try {
        const entry = await messageService.sendMessage({
            name: NAME,
            message,
            middlewareUrl: parent,
            log
        });

        res.status(201).json(entry);

    } catch (err) {
        // El coordinador dejo de ser lider entre el pulso y este mensaje. Nos reenganchamos al nuevo y reintentamos una vez.
        if (err.redirectTo) {
            try {
                await connectTo(err.redirectTo);

                const entry = await messageService.sendMessage({
                    name: NAME,
                    message,
                    middlewareUrl: parent,
                    log
                });

                return res.status(201).json(entry);

            } catch {
                log("ERROR", "No pude entregar el mensaje ni tras redirigirme");
                return res.status(503).json({ error: "No hay lider disponible" });
            }
        }

        if (err.response) {
            log("ERROR", `Coordinator rejected the message (${err.response.status})`);
            return res.status(err.response.status).json(err.response.data);
        }

        log("ERROR", "Could not reach the coordinator");
        res.status(502).json({ error: "Coordinator unreachable" });
    }
});

app.post("/shutdown", (req, res) => {
    pulse.stopPulse(log);

    res.json({ message: `${NAME} shutting down...` });

    setTimeout(() => {
        process.exit(0);
    }, 500);
});
