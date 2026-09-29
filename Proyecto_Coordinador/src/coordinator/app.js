const path = require("path");
const express = require("express");
const config = require("./config");
const routes = require("./routes/server.routes");
const electionRoutes = require("./routes/election.routes");
const debugRoutes = require("./routes/debug.routes");
const taskRoutes = require("./routes/task.routes");

const app = express();

app.set("trust proxy", config.trustProxy);
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// El protocolo de eleccion va antes que las rutas del coordinador: 
// Son conversaciones entre iguales y no deben pasar por el filtro de "solo el lider atiende".
if (config.electionEnabled) {
    app.use("/", electionRoutes);
    app.use("/", debugRoutes);
}

app.use("/", routes);
app.use("/", taskRoutes);

module.exports = app;
