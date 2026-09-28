# SISTEMAS DISTRIBUÍDOS - EXAMEN 20%

**UB Universidad de Boyacá**
*Acreditación Nacional en Alta Calidad-C.N.A*
*Reacreditación Internacional Plena-RIEV*

## SISTEMA DISTRIBUÍDO COORDINADOR-TRABAJADOR

**OBJETIVO:** Con el sistema que se ha venido desarrollando en clase de Coordinadores y Trabajadores, implementar una serie de características que correspondan a los temas de heartbeat, workload, leader detection, sync, replication, entre otros.

El sistema debe ser completamente distribuido, por lo que el día del parcial debe funcionar con todos los compañeros, probando diferentes combinaciones de Coordinadores y Trabajadores.

Los ID de cada sistema se harán de la siguiente forma:

* **Workers:** `worker-{nombre}-{código}`

  * *Ej:* `worker-jose-55217003`

* **Coordinators:** `coordinator-{nombre}-{código}`

  * *Ej:* `coordinator-jose-55217003`

La UI web del sistema debe:

* Representar correctamente el estado del sistema, mostrando coordinadores conocidos, backups, status, información del líder, etc.

* Permitir modificar y añadir información (coordinadores, trabajadores, enviar tareas, etc.).

El único comando en la consola es para correr la aplicación tanto para el coordinador como para el trabajador es:

```
node index.js {PUERTO} {URL_NGROK}

```

*Ej: `node index.js 3000 https://nombre-random-ngrok.dev`*

## MENSAJES DE COORDINATOR A COORDINATOR

**Hello:** Se envía cuando un coordinador se presenta a otro (usualmente el primary, pero no siempre).

```
"type": "hello",
"data": {
  "id": "coord-1",
  "url": "http://ngrok-nombre.dev"
}

```

**Welcome:** El coordinador le da la bienvenida al nuevo coordinador y le pasa la lista de todos sus pares conocidos (para replication y sync). Adicionalmente, también envía la información de su líder para que el nuevo se postule como líder o acepte quien es su nuevo líder.

```
"type": "welcome",
"data": {
  "id": "coord-2",
  "knownPeers": [
    { "id": "coord-3", "url": "http://..." },
    { "id": "coord-4", "url": "http://..." }
  ],
  "leader": {
    "id": "coord-1",
    "url": "http://...",
    "priority": 10
  }
}

```

**Ping y Pong:** Los coordinadores se preguntan entre sí si el otro está vivo.

```
"type": "ping",
"data": {
  "message": "ping de tin"
}

```

```
"type": "pong",
"data": {
  "message": "pong de tan"
}

```

*Nota: La comunicación entre coordinadores es diferente a la de coordinador y trabajador: a los coordinadores les interesa saber si alguno de sus compañeros murió; a los coordinadores no le interesa saber si sus trabajadores mueren. Por eso el trabajador manda pulsos que pueden parar en cualquier momento, mientras que los coordinadores se están constantemente verificando.*

**Leader-Announce:** Algún coordinador "postula" un líder enviando un número de prioridad. Entre más alto el número, más posibilidades de que ese líder sea seleccionado.

```
"type": "leader-announce",
"data": {
  "leaderId": "coord-2",
  "leaderUrl": "http://...",
  "priority": 10
}

```

## MENSAJES DE WORKER A COORDINATOR

**Register:** Para registrar un trabajador a un coordinador y que este conozca sus capacidades.

```
"type": "register",
"data": {
  "id": "worker-1",
  "url": "https://ngrok-nombre-worker.dev",
  "capabilities": [
    "math_compute",
    "http_fetch"
  ]
}

```

**Pulse:** Para que el coordinador sepa que el trabajador siga vivo.

```
"type": "pulse",
"data": {
  "id": "worker-1",
  "load": 0.5
}

```

**Task-Result:** Para que el coordinador sepa el resultado de alguna tarea enviada a un trabajador.
*Éxito:*

```
"type": "task-result",
"data": {
  "taskId": "task-123",
  "status": "ok",
  "result": {}
}

```

*Error:*

```
"type": "task-result",
"data": {
  "taskId": "task-123",
  "status": "error",
  "error": "Ocurrió un error por estas razones..."
}

```

## MENSAJES DE COORDINATOR A WORKER

**Task-Assign:** Para poner a un trabajador a trabajar según sus capacidades.

```
"type": "task-assign",
"data": {
  "taskId": "task-123",
  "type": "math_compute",
  "payload": {
    "operation": "add",
    "a": 5,
    "b": 10
  }
}

```

## MENSAJES GENÉRICOS

**Error:** Cuando ocurre un error, enviamos un mensaje que nos permita diagnosticar el problema rápidamente.

```
"type": "error",
"data": {
  "message": "Ocurrió un error al enviar pulsos..."
}

```

**Redirect:** Cuando un trabajador está enviando pulsos o intentando registrarse a un coordinador que no es el líder. De esta forma, el trabajador puede reconectarse al coordinador líder con facilidad en caso failover.

```
"type": "redirect",
"data": {
  "leaderId": "coord-2",
  "leaderUrl": "http://...",
  "priority": 10
}

```

## REGLAS DEL SISTEMA

### 1. Descubrimiento de Coordinadores (Discovery)

Todo coordinador debe poder conectarse a otros coordinadores conocidos. Cuando lo hace, debe enviar un mensaje de "hello" y el otro debe responder con "welcome".
El mensaje de "welcome" define la lista de peers (pares) conocidos y el estado actual del líder. Cada coordinador debe almacenar y actualizar su lista de peers dinámicamente.

### 2. Sincronización de Red (Sync)

Al recibir un "welcome", el coordinador debe agregar los peers recibidos a su lista e intentar conectarse a ellos a través de un "hello".
La red debe converger a un grafo conectado (eventualmente todos los coordinadores se conocen con todos).

### 3. Ping-Pong entre Coordinadores (Heartbeat Simétrico)

Cada coordinador debe enviar mensajes de "ping" periódicamente a sus peers y cada peer debe responder con "pong".
Si un coordinador no responde después de `N` intentos o `T` tiempo, se considera caído y se elimina de la lista de peers. La definición de tiempos se declara más adelante para que el sistema funcione con un tiempo de respuesta similar.

### 4. Elección de líder (Leader Election)

El sistema mantiene un único líder (primary) y todos los demás coordinadores son backups.
Un coordinador puede enviar un mensaje "leader-announce" cuando:

* Arranca

* Se une a la red

* Detecta que el líder actual no responde

Al recibir un "leader-announce", cada coordinador debe aceptar el nuevo líder si la prioridad del nuevo líder es mayor a la actual. No pueden haber empates. Si el líder es aceptado, se actualiza el estado local del líder actual y envía un "leader-announce" a todos sus peers.

### 5. Fallo del Líder (Failover)

Si el líder se cae (ver punto 3 para detectar fallos de caída), entonces todos los coordinadores envían un nuevo "leader-announce" postulándose a sí mismo como candidato.

### 6. Registro de Trabajador (Register)

Cada trabajador debe registrarse ante un coordinador usando "register". El coordinador debe almacenar la id del trabajador, su URL y sus capacidades. Un trabajador solo puede registrarse en el coordinador líder. Los coordinadores no deben recibir pulsos ni registros si no son líderes.
Si un coordinador que no es líder recibe "register" o "pulse" debe responder con un mensaje que contenga la info del líder actual.

### 7. Pulso de los Trabajadores (Heartbeat Asimétrico)

Cada trabajador debe enviar mensajes de "pulse" periódicamente cada `T` tiempo.
El coordinador debe actualizar el estado del trabajador y registrar su carga. Si un trabajador deja de enviar pulsos después de `N` intentos o `T` tiempo, se considera caído y se elimina del sistema.

### 8. Asignación y Ejecución de Tareas (Workload)

El coordinador (preferiblemente el líder) es responsable de asignar tareas. Solo se deben asignar tareas a trabajadores que tengan la capacidad requerida.
Luego, el coordinador envía "task-assign" al trabajador. El trabajador debe ejecutar la tarea y responder con "task-result". El resultado puede ser "ok" y traer un resultado o "error" y traer la información del error.

### 9. Fallo del Coordinador (Failover de Workers)

Cada trabajador debe tener una lista de coordinadores. El trabajador siempre trata de conectarse con el coordinador líder. Si el coordinador no responde, intenta con el siguiente en la lista hasta encontrar al nuevo líder (normalmente a través de un "redirect"). Si no encuentra ningún líder, no debe caerse, pero debe permanecer a la espera de un líder.

## TIEMPOS DEL SISTEMA

* **Ping retries:** 3

* **Ping interval:** 2s

* **Ping timeout:** 5s

* **Pulse retries:** 3

* **Pulse interval:** 3s

* **Pulse timeout:** 8s

## CAPACIDADES DE LOS TRABAJADORES

Cada trabajador debe implementar dos capacidades previamente asignadas y proponer una nueva que no sea tan compleja. Esto implica que cada trabajador debe contar con, por lo menos, tres capacidades.

### 1. math_compute

Calculadora básica que toma una operación y dos operandos.

```
"type": "math_compute",
"payload": {
  "operation": "add | sub | mul | div",
  "a": 10,
  "b": 5
}
// Resultado:
// "result": 15

```

### 2. http_fetch

Hace fetch a la URL solicitada y retorna el estado de la petición y un cuerpo si lo hay.

```
"type": "http_fetch",
"payload": {
  "url": "https://..."
}
// Resultado:
// "status": 200,
// "body": { ... }

```

### 3. search_text

Busca en una cadena de texto y retorna cuantas veces encuentra el "query".

```
"type": "search_text",
"payload": {
  "text": "hola mundo hola",
  "query": "hola"
}
// Resultado:
// "count": 2

```

### 4. stats_compute

Obtiene el promedio, el mínimo y el máximo de una lista de números.

```
"type": "stats_compute",
"payload": {
  "numbers": [1, 2, 3, 4, 5]
}
// Resultado:
// "mean": 3,
// "min": 1,
// "max": 5

```

### 5. vector_distance

Obtiene la distancia entre dos vectores de dos dimensiones.

```
"type": "vector_distance",
"payload": {
  "a": [0,0],
  "b": [3,4]
}
// Resultado:
// "distance": 5

```

### 6. http_latency

Obtiene la latencia de una URL determinada. Se entrega en milisegundos.

```
"type": "http_latency",
"payload": {
  "url": "https://..."
}
// Resultado:
// "ms": 36

```

## CHECKLIST FINAL

Usa la siguiente lista para garantizar el correcto funcionamiento del sistema. Debe cumplir con los siguientes puntos para considerarse completo:

### Coordinators (Core distribuido)

* \[ \] Puede iniciar y conectarse a otros coordinadores usando hello

* \[ \] Responde correctamente con welcome

* \[ \] Mantiene una lista actualizada de peers (sin duplicados)

* \[ \] Intenta conectarse automáticamente a nuevos peers recibidos

### Heartbeat entre Coordinadores

* \[ \] Envía ping periódicamente a todos los peers

* \[ \] Responde con pong correctamente

* \[ \] Detecta coordinadores caídos según timeout definido

* \[ \] Elimina coordinadores caídos de su lista

### Leader election

* \[ \] Envía leader-announce sólo en los casos definidos

* \[ \] Acepta un nuevo líder sólo si tiene mayor prioridad

* \[ \] Propaga (forward) el leader-announce a sus peers

* \[ \] Mantiene actualizado el estado de líder (id + url + prioridad)

* \[ \] Solo existe un líder estable en la red

### Failover de Coordinadores

* \[ \] Detecta caída del líder usando ping/pong

* \[ \] Se postula como líder al detectar fallo

* \[ \] El sistema converge a un nuevo líder automáticamente

### Workers

* \[ \] Se registran usando register

* \[ \] Solo se registran con el coordinador líder

* \[ \] Manejan correctamente redirect hacia el líder

* \[ \] Mantienen una lista de coordinadores (failover)

### Heartbeat de Workers

* \[ \] Envían pulse periódicamente

* \[ \] Incluyen información de carga (load)

* \[ \] El coordinador actualiza estado del worker

* \[ \] Workers inactivos son removidos tras timeout

### Workload

* \[ \] El líder asigna tareas con task-assign

* \[ \] Solo asigna tareas a workers con capacidades compatibles

* \[ \] Selecciona workers disponibles (idealmente menor carga)

### Ejecución de tareas

* \[ \] El worker ejecuta la tarea correctamente

* \[ \] Responde con task-result

* \[ \] Maneja correctamente casos de éxito (ok)

* \[ \] Maneja correctamente errores (error)

### Failover de Workers

* \[ \] Detecta caída del coordinador actual

* \[ \] Intenta reconectarse a otros coordinadores

* \[ \] Usa redirect para encontrar al líder

* \[ \] Nunca se bloquea si no hay líder disponible

### Comunicación

* \[ \] Todos los mensajes usan formato `{ type, data }`

* \[ \] Manejo básico de errores (error message)

### UI Web

* \[ \] Muestra lista de coordinadores conocidos

* \[ \] Muestra quién es el líder actual

* \[ \] Muestra estado de workers (activo/inactivo, load)

* \[ \] Permite enviar tareas manualmente

* \[ \] Permite agregar coordinadores o workers

### Pruebas en red

* \[ \] Funciona con múltiples coordinadores (mínimo 2-3)

* \[ \] Funciona con múltiples workers

* \[ \] Soporta caída de coordinador líder en vivo

* \[ \] Soporta reconexión automática de workers

* \[ \] El sistema sigue operando después de fallos