const { isGreater } = require("../ids");

// BULLY (Garcia-Molina, 1982) -- familia extremum, malla completa.
//
// "El maton manda": gana siempre el ID mas alto que siga vivo. Cuando alguien
// nota que el lider cayo, reta a todos los que tienen ID mayor que el suyo.
// Si ninguno contesta, se proclama coordinador.
//
// NO usa quorum: le basta con el silencio de los mayores. Por eso, bajo
// particion, cada lado elige su propio lider -> split-brain garantizado.
// Coste: O(n^2) mensajes en el peor caso, y se nota en el contador del panel.

// Devuelve el peer vivo con ID mas alto que el mio, o null.
function highestAlivePeer(ctx) {
    const higher = ctx.alivePeers().filter(
        peer => isGreater(peer.id, ctx.self.id)
    );
    if (higher.length === 0) return null;
    return higher.reduce((best, peer) => isGreater(peer.id, best.id) ? peer : best);
}

function startElection(ctx) {
    const now = Date.now();

    // Antirrebote: sin esto, cada tick de 250 ms lanzaria otra eleccion.
    if (ctx.state.electing && now - ctx.state.startedAt < ctx.timing.electionMax) return;

    ctx.state.electing = true;
    ctx.state.startedAt = now;
    ctx.state.gotAnswer = false;

    ctx.becomeCandidate();

    const higher = ctx.allNodes().filter(node => !node.self && node.alive && isGreater(node.id, ctx.self.id));

    ctx.log("election-start", { higher: higher.map(node => node.id) });

    // Nadie por encima de mi vivo: soy el mayor, me proclamo.
    if (higher.length === 0) return win(ctx);

    higher.forEach(node => ctx.send(node.id, "ELECTION", {}));

    // Si ninguno de los mayores contesta a tiempo, reviso otra vez.
    ctx.timer("answer", ctx.timing.electionMin, () => {
        if (ctx.state.gotAnswer) return;

        // Re-verificar: si sigue habiendo alguien mayor vivo (por pings),
        // aceptarlo como lider directamente en vez de auto-proclamarme.
        // Esto evita el ciclo infinito cuando el peer mayor no responde
        // a ELECTION (ej: implementacion diferente) pero SI responde pings.
        const best = highestAlivePeer(ctx);
        if (best) {
            ctx.state.electing = false;
            ctx.clearTimer("answer");
            ctx.clearTimer("coordinator");
            ctx.becomeFollower(best.id);
            ctx.info(`Sin respuesta a ELECTION pero ${best.id} sigue vivo, lo acepto como lider`);
            return;
        }

        win(ctx);
    });
}

function win(ctx) {
    ctx.state.electing = false;

    ctx.clearTimer("answer");
    ctx.clearTimer("coordinator");

    ctx.becomeLeader();
    ctx.broadcast("COORDINATOR", { leader: ctx.self.id });
    ctx.log("election-won", { by: ctx.self.id });
}

module.exports = {
    name: "bully",
    family: "extremum",
    topology: "full-mesh",
    usesQuorum: false,
    summary: "Gana el ID mas alto vivo. Sin quorum: se parte bajo particion.",

    init(ctx) {
        ctx.state.electing = false;
        ctx.state.startedAt = 0;
        ctx.state.gotAnswer = false;

        // Margen para que el detector de fallos descubra a los peers antes
        // de lanzar la primera eleccion; si no, cada nodo se cree solo.
        ctx.state.settleUntil = Date.now() + ctx.timing.suspect;
    },

    onTick(ctx) {
        const now = Date.now();

        if (now < ctx.state.settleUntil) return;

        if (ctx.role === "leader") {
            // --- Anti split-brain: si hay alguien mayor vivo, cedo a el ---
            // Directamente me hago follower, sin lanzar eleccion.
            const best = highestAlivePeer(ctx);
            if (best) {
                ctx.info(`Nodo mayor detectado (${best.id}), me hago follower`);
                ctx.state.electing = false;
                ctx.becomeFollower(best.id);
                return;
            }

            // Reafirmacion periodica del mando.
            if (now - (ctx.state.lastAnnounce || 0) < ctx.timing.heartbeat * 3) return;

            ctx.state.lastAnnounce = now;
            ctx.broadcast("COORDINATOR", { leader: ctx.self.id });
            return;
        }

        // Si ya tengo lider vivo, no hago nada.
        const leaderAlive = ctx.leader && ctx.alive(ctx.leader);
        if (leaderAlive) return;

        // --- Candidato: si hay un peer mayor vivo y la eleccion ya expiro,
        //     aceptarlo como lider directamente (no esperar COORDINATOR). ---
        if (ctx.role === "candidate" && ctx.state.electing) {
            const elapsed = now - ctx.state.startedAt;
            const best = highestAlivePeer(ctx);

            // Hay alguien mayor vivo: darle tiempo para que se proclame.
            if (best && elapsed < ctx.timing.electionMax) return;

            // Eleccion expirada y hay alguien mayor vivo: aceptarlo ya.
            if (best && elapsed >= ctx.timing.electionMax) {
                ctx.state.electing = false;
                ctx.clearTimer("answer");
                ctx.clearTimer("coordinator");
                ctx.becomeFollower(best.id);
                ctx.info(`Eleccion expirada, acepto a ${best.id} como lider`);
                return;
            }

            // Eleccion expirada y nadie mayor vivo: reintentar.
            if (elapsed >= ctx.timing.electionMax) {
                ctx.state.electing = false;
            }
        }

        startElection(ctx);
    },

    onMessage(ctx, message) {
        const from = message.from.id;

        if (message.type === "ELECTION") {
            // Le contesto para que sepa que hay alguien mayor vivo, y me
            // lanzo yo tambien: la eleccion se propaga hacia arriba.
            ctx.send(from, "ANSWER", {});
            if (!ctx.state.electing) startElection(ctx);
            return;
        }

        if (message.type === "ANSWER") {
            ctx.state.gotAnswer = true;
            ctx.clearTimer("answer");

            // Hay alguien mayor vivo: le doy tiempo a que se proclame.
            ctx.timer("coordinator", ctx.timing.electionMax, () => {
                // Si ya tengo lider, no hago nada.
                if (ctx.leader) return;

                // Re-check: si hay alguien mayor vivo, aceptarlo.
                const best = highestAlivePeer(ctx);
                if (best) {
                    ctx.state.electing = false;
                    ctx.becomeFollower(best.id);
                    ctx.info(`Timeout COORDINATOR, acepto a ${best.id} como lider`);
                    return;
                }

                ctx.state.electing = false;
                startElection(ctx);
            });
            return;
        }

        if (message.type === "COORDINATOR") {
            const leader = message.payload.leader || from;

            // Ya tengo un lider vivo y mejor que el que se anuncia: paso.
            if (ctx.leader && ctx.alive(ctx.leader) && isGreater(ctx.leader, leader)) return;

            // Si el que se proclama es menor que yo, no lo acepto: le disputo.
            if (isGreater(ctx.self.id, leader)) {
                ctx.state.electing = false;
                startElection(ctx);
                return;
            }

            ctx.state.electing = false;
            ctx.clearTimer("answer");
            ctx.clearTimer("coordinator");
            ctx.becomeFollower(leader);
        }
    },

    onPeerSuspected(ctx, peerId) {
        if (!peerId) return;
        if (ctx.leader && String(peerId) === String(ctx.leader)) startElection(ctx);
    },

    onPeerRecovered(ctx, peerId) {
        if (!peerId) return;
        // Si se recupera un peer con ID mayor y yo soy lider, ceder.
        if (ctx.role === "leader" && isGreater(peerId, ctx.self.id)) {
            ctx.info(`Peer mayor ${peerId} recuperado, cedo liderazgo`);
            ctx.state.electing = false;
            ctx.becomeFollower(peerId);
        }
    },

    describe(ctx) {
        return { electing: Boolean(ctx.state.electing) };
    }
};
