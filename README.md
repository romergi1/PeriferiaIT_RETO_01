# Reto 01: agente de registro como proveedor

Es un agente de chat que lee una solicitud de registro como proveedor, llena los campos con los datos del repositorio maestro, genera el formulario (Excel, PDF o valores para un portal) y arma el paquete para firma. No envía nada sin que una persona lo confirme.

- Link de prueba: https://periferiait-reto-01.onrender.com/
- Clave de acceso: no tiene, el link es público.

## Cómo correrlo en local

Necesitas [Bun](https://bun.sh) 1.2 o superior.

```bash
cp .env.example .env        # luego escribe GEMINI_API_KEY, GROQ_API_KEY o las dos (son gratis)
bun install && bun run dev  # queda en http://localhost:7477
```

Bun lee el `.env` solo. En el chat hay un selector de modelo con los proveedores que tengan clave, y cada respuesta dice qué modelo contestó. Se puede cambiar de proveedor en medio de una conversación.

## Demo sin modelo

No necesita clave:

```bash
bun install && bun run demo.ts
```

Procesa los cuatro casos llamando directo a las herramientas, con la fecha fija 2026-09-03. Muestra los campos llenos, faltantes y por confirmar, la ruta del formulario y el estado del paquete. También prueba un caso que no existe y el bloqueo del envío cuando no hay confirmación. Borra `out/` al empezar, así que siempre da el mismo resultado.

## Variables de entorno

| Variable | ¿Obligatoria? | Para qué sirve |
|---|---|---|
| `GEMINI_API_KEY` | Hace falta al menos una clave para el chat | Clave de Google Gemini. Es gratis en aistudio.google.com. |
| `GROQ_API_KEY` | Hace falta al menos una clave para el chat | Clave de Groq. Es gratis en console.groq.com. |
| `ANTHROPIC_API_KEY` | Hace falta al menos una clave para el chat | Clave de Anthropic, que es de pago. |
| `LLM_PROVIDER` | No | Proveedor que aparece seleccionado al abrir el chat: `gemini`, `groq` o `anthropic`. Si no se indica, se usa el primero que tenga clave. |
| `GEMINI_MODEL` | No | Por defecto `gemini-3.1-flash-lite`. |
| `GROQ_MODEL` | No | Por defecto `openai/gpt-oss-120b`. |
| `ANTHROPIC_MODEL` | No | Por defecto `claude-haiku-5-5`. |
| `MAX_ITERACIONES` | No | Máximo de idas y vueltas entre modelo y herramientas por mensaje. Por defecto 25. |
| `MAX_TOKENS_SESION` | No | Máximo de tokens por sesión. Por defecto 200000. |
| `PORT` | No | Puerto del servidor. Por defecto 7477. |

Las claves solo se usan en el servidor. El navegador nunca las ve.

## API

| Método | Ruta | Qué hace |
|---|---|---|
| `POST` | `/api/chat` | Recibe `{ sessionId, message, provider }`, donde `provider` es opcional. Devuelve `{ reply, toolCalls, needsConfirmation, provider, model }`. |
| `GET` | `/api/sessions/:id` | Devuelve el historial de la sesión y los tokens usados. |
| `GET` | `/api/health` | Devuelve el estado del servidor y los proveedores disponibles, sin claves. |
| `GET` | `/out/...` | Descarga los formularios y paquetes generados. |

## Archivos

```
agent/prompt.md                  instrucciones del agente (system prompt)
src/knowledge/                   conocimiento del proceso y reglas por país (reglas.json)
src/tools/proveedor.ts           las 5 herramientas, expuestas como proveedor_<nombre>
src/tools/utilidades.ts          rutas, lectura de JSON y manejo de errores de las herramientas
src/tools/formularios.ts         escritura de Excel, PDF y valores para portal
src/tools/esquemas.ts            esquemas zod de los archivos de entrada
src/agente.ts                    ciclo del agente
src/llm/adapter.ts               interfaz común de los proveedores de modelo
src/llm/anthropic.ts             adaptador de Anthropic
src/llm/gemini.ts                adaptador de Google Gemini
src/llm/openai-compatible.ts     adaptador para APIs con formato OpenAI (se usa con Groq)
src/server.ts                    servidor HTTP
web/index.html                   el chat
demo.ts                          demo sin modelo
fixtures/                        datos del reto (no se modifican)
out/                             lo que se genera al ejecutar
```

## Despliegue en Render

1. Sube el repositorio a GitHub.
2. En Render crea un Web Service nuevo, elige el repositorio y usa Docker como runtime. Render toma el `Dockerfile` del proyecto.
3. En Environment agrega `GEMINI_API_KEY`, `GROQ_API_KEY` o las dos.
4. Cuando termine, copia la URL pública arriba, en "Link de prueba".

Con el mismo `Dockerfile` también funciona en Railway o Fly.io.

## Un mensaje para probar

```
Procesa el caso "ec-corp-andina". Dime qué campos quedaron llenos, cuáles
faltan, si el paquete está listo para firma y qué soportes debo actualizar.
No envíes nada todavía.
```

Si quieres revisar las vigencias con una fecha fija, agrega algo como "usa fecha de referencia 2026-09-03".
