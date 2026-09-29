const axios = require("axios");

const HEADERS = { "ngrok-skip-browser-warning": "true" };

async function sendMessage({ name, message, middlewareUrl, log }) {

    try {
        const res = await axios.post(
            `${middlewareUrl}/send-message/${name}`,
            { message },
            { timeout: 3000, headers: HEADERS }
        );

        log("INFO", `Message sent to coordinator: ${message}`);

        return res.data;

    } catch (err) {
        const response = err.response;

        // El coordinador dejo de ser lider. Se marca como redirigible para que quien llame se reenganche y reintente, en vez de dar el mensaje por perdido.
        if (response && (response.status === 409 || response.status === 503)) {
            const data = response.data || {};

            const redirect = new Error(data.error || "Redirigido");
            redirect.redirectTo = data.leader || null;
            redirect.peers = data.peers || [];

            throw redirect;
        }

        throw err;
    }
}

module.exports = {
    sendMessage
};
