# Endpoints de Elección (Algoritmo Bully)

Para que todos los coordinadores se puedan comunicar y la elección funcione, necesitamos que **todos implementen estos 3 endpoints exactamente con esta estructura**. 

Toda la comunicación entre coordinadores ocurre a través de peticiones `POST` enviando y recibiendo `JSON`.

---

## 1. Ping / Intercambio de Peers
**Endpoint:** `POST /election/ping`

Se envía periódicamente (cada 2 segundos) a todos los peers conocidos. Sirve como "heartbeat" para saber quién está vivo y para descubrir nuevos peers automáticamente.

**Request Body (Lo que se recibe):**
```json
{
  "from": {
    "id": 1,
    "url": "https://tu-ngrok.ngrok-free.dev"
  },
  "peers": [
    "https://peer1-ngrok.ngrok-free.dev",
    "https://peer2-ngrok.ngrok-free.dev"
  ]
}
```

**Response Body (Lo que debes responder):**
Debes responder con tu estado completo actual (exactamente lo mismo que devuelve tu GET `/election/state`).
```json
{
  "id": 2,
  "url": "https://otro-ngrok.ngrok-free.dev",
  "role": "follower",
  "leader": 3,
  "leaderUrl": "https://lider-ngrok.ngrok-free.dev",
  "peers": [
    { "id": 1, "url": "https://tu-ngrok.ngrok-free.dev", "alive": true },
    { "id": 3, "url": "https://lider-ngrok.ngrok-free.dev", "alive": true }
  ]
}
```
*Roles válidos para `role`:* `"leader"`, `"follower"`, `"candidate"`.

---

## 2. Mensajes del Algoritmo Bully
**Endpoint:** `POST /election/message`

Este es el único endpoint donde ocurre la elección de líder Bully. Por aquí viajan los mensajes de `ELECTION`, `ANSWER` y `COORDINATOR`.

**Request Body (Lo que se recibe):**
```json
{
  "type": "ELECTION",
  "from": {
    "id": 1,
    "url": "https://tu-ngrok.ngrok-free.dev"
  },
  "payload": {}
}
```
*Tipos de mensajes posibles (`type`):*
- `"ELECTION"`: Iniciando una elección.
- `"ANSWER"`: Respondiendo a una elección (diciendo "estoy vivo y tengo ID más alto").
- `"COORDINATOR"`: Proclamándose como el nuevo líder.

**Response Body (Lo que debes responder):**
Siempre se debe responder `HTTP 200 OK` con un simple:
```json
{
  "ok": true
}
```
> **Ojo a la lógica de respuestas Bully:** Si tu nodo recibe un `ELECTION` de alguien con ID menor y tú necesitas contestar con un `ANSWER`, **no debes meter el ANSWER en la respuesta HTTP directamente**. Debes responder `{ "ok": true }` a la petición HTTP y luego **hacer una NUEVA petición HTTP POST** al `/election/message` del nodo que te habló, mandándole el `type: "ANSWER"`. Las respuestas del algoritmo Bully viajan como mensajes nuevos, no como respuestas de la petición HTTP.

---

## 3. Consultar Estado (Para el front y los Workers)
**Endpoint:** `GET /election/state`

Devuelve la vista actual de cómo tu coordinador ve la red. Es el mismo JSON que devuelve el `/election/ping`. Sirve para que el worker sepa quién es el líder si tu coordinador se cae (Failover fase 5).

**Response Body:**
```json
{
  "id": 1,
  "url": "https://tu-ngrok.ngrok-free.dev",
  "role": "leader",
  "leader": 1,
  "leaderUrl": "https://tu-ngrok.ngrok-free.dev",
  "peers": [
    { "id": 2, "url": "https://peer-ngrok.ngrok-free.dev", "alive": true }
  ]
}
```
