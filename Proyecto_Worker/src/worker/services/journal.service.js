// Lo que este worker sabe del mundo, y como se ha ido enterando.
//
// Existe para la clase: el alumno abre la UI de SU worker y ve, desde el lado
// del cliente, como se cae su coordinador y como se busca la vida el solo. Es
// la otra mitad de la historia que cuenta el panel del coordinador.

const MAX = 60;

let entries = [];
let seq = 0;

// url -> { url, role, note, seenAt }
// role: "leader" | "follower" | "down" | null (aun no se)
const coordinators = new Map();

function write(kind, text) {
    const last = entries[entries.length - 1];

    // Mientras hay eleccion en curso, el worker repite la misma ronda de
    // preguntas cada 2 segundos. Si se escribe todo, las lineas interesantes
    // quedan sepultadas. Se agrupa lo repetido con un contador.
    if (last && last.text === text) {
        last.repeated = (last.repeated || 1) + 1;
        last.at = Date.now();
        return;
    }

    entries.push({ seq: ++seq, at: Date.now(), kind, text });
    if (entries.length > MAX) entries.shift();
}

function clean(url) {
    return String(url || "").replace(/\/+$/, "");
}

function remember(url, id) {
    const key = clean(url);
    if (!key) return null;

    if (!coordinators.has(key)) {
        coordinators.set(key, { url: key, id: id || null, role: null, note: null, seenAt: 0 });
        write("descubro", `Me entero de que existe ${id || key}`);
    }

    const coordinator = coordinators.get(key);
    if (id) coordinator.id = id;

    return coordinator;
}

// Como llamar a un coordinador en los mensajes. Su nombre si ya me lo han
// dicho; si no, la url. Con tuneles las urls son ilegibles, asi que en cuanto
// se sabe el nombre se usa el nombre.
function name(url) {
    const coordinator = coordinators.get(clean(url));
    return (coordinator && coordinator.id) || clean(url);
}

// Lo que el worker CREE saber de un coordinador. Nunca es la verdad actual:
// es lo ultimo que le dijeron. Esa distincion es media asignatura.
function mark(url, role, note, id) {
    const coordinator = remember(url, id);
    if (!coordinator) return;

    coordinator.role = role;
    coordinator.note = note || null;
    coordinator.seenAt = Date.now();
}

// Solo puede haber un lider en la foto del worker: al marcar uno nuevo,
// el anterior deja de serlo.
function markLeader(url, id) {
    const key = clean(url);

    coordinators.forEach(coordinator => {
        if (coordinator.url !== key && coordinator.role === "leader") coordinator.role = null;
    });

    mark(key, "leader", null, id);
}

function urls() {
    return [...coordinators.keys()];
}

function list() {
    return [...coordinators.values()];
}

function history() {
    return entries;
}

module.exports = { write, remember, name, mark, markLeader, urls, list, history };
