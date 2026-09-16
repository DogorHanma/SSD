const axios = require("axios");

const HEADERS = { "ngrok-skip-browser-warning": "true" };

let pulseInterval = null;

function asRedirect(err) {
    const response = err.response;
    if (!response) return null;

    const data = response.data || {};

    // 409 -> hay lider y no soy yo.  503 -> eleccion en curso, aun no hay lider.
    if (response.status !== 409 && response.status !== 503) return null;

    const redirect = new Error(data.error || "Redirigido a otro coordinador");
    redirect.redirectTo = data.leader || null;
    redirect.peers = data.peers || [];
    redirect.retry = Boolean(data.retry);

    return redirect;
}

async function register({ name, url, middlewareUrl }) {
    try {
        const res = await axios.post(
            `${middlewareUrl}/register`,
            { name, url },
            { timeout: 5000, headers: HEADERS }
        );

        return res.data;

    } catch (err) {
        const redirect = asRedirect(err);
        if (redirect) throw redirect;
        throw err;
    }
}

// El pulso es el detector de fallos del worker.
function startPulse({ name, middlewareUrl, log, interval, onView, onRedirect, onLost }) {
    stopPulse();

    const every = interval || 2000;

    pulseInterval = setInterval(async () => {
        try {
            const res = await axios.post(`${middlewareUrl}/pulse/${name}`, {}, { timeout: 5000, headers: HEADERS });

            // Cada pulso correcto trae la vista del cluster de propina. Asi el worker siempre sabe a quien preguntar si el lider desaparece.
            if (onView) onView(res.data || {});

        } catch (err) {
            const redirect = asRedirect(err);

            if (redirect) {
                if (redirect.peers.length && onView) onView({ peers: redirect.peers });

                // El coordinador vive y me dice quien manda.
                if (redirect.redirectTo && onRedirect) {
                    log("WARN", `El coordinador ya no es el lider, me mandan a ${redirect.redirectTo}`);
                    onRedirect(redirect.redirectTo);
                    return;
                }

                // Me contesta, pero no sabe quien manda (esta fuera de servicio o hay eleccion en curso). Me toca buscarlo por mi cuenta.
                log("WARN", "El coordinador no sabe quien es el lider, buscando");
                if (onLost) onLost("no-leader");
                return;
            }

            // El servidor devolvio 404: el registro se perdio (reinicio del coordinador). Hay que volver a registrarse, no seguir pulsando.
            if (err.response && err.response.status === 404) {
                log("WARN", "El coordinador no me conoce, registrando");
                if (onLost) onLost("unregistered");
                return;
            }

            // Camino lento: silencio total. El coordinador esta muerto y no hay nadie que me diga a donde ir; toca buscar al nuevo lider.
            log("ERROR", "Sin pulso: el coordinador no responde");
            if (onLost) onLost("unreachable");
        }
    }, every);
}

function stopPulse(log) {
    if (!pulseInterval) return;

    clearInterval(pulseInterval);
    pulseInterval = null;

    if (log) log("WARN", "Stopped sending pulse");
}

module.exports = {
    register,
    startPulse,
    stopPulse,
    HEADERS
};
