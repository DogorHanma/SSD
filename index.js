// Punto de entrada del examen.
// Uso: node index.js {PUERTO} {URL_NGROK}
// Ej:  node index.js 3000 https://geranium-unnamed-suffix.ngrok-free.dev
//
// Si ya tienes PORT y PUBLIC_URL en el .env, puedes omitir los argumentos
// y arrancar simplemente con:  node index.js

const port      = process.argv[2];
const publicUrl = process.argv[3];

// Los argumentos de consola tienen prioridad sobre el .env,
// pero si no se pasan, dotenv los leerá del archivo.
if (port)      process.env.PORT       = port;
if (publicUrl) process.env.PUBLIC_URL = publicUrl;

require("./src/coordinator/server.js");
