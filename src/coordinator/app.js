const path = require("path");
const express = require("express");
const routes = require("./routes/server.routes");
const electionRoutes = require("./routes/election.routes");

const app = express();

app.set("trust proxy", Number(process.env.TRUST_PROXY || 0));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use("/", routes);
app.use("/", electionRoutes);

module.exports = app;