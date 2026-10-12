# Solución del Reto 01: Registro como Proveedor

## 1. El problema

Cada vez que un cliente nos pide registrarnos como proveedor (entre 8 y 12 veces al mes), alguien del área administrativa copia a mano datos que ya tenemos en el repositorio interno. Eso es retrabajo, abre la puerta a errores en datos delicados como el NIT o la cuenta bancaria, y deja el proceso en manos de una sola persona. Lo sufre la analista que hace el trabajo y lo sufre la empresa, que termina facturando más tarde.

## 2. Arquitectura

El flujo es sencillo. El chat (`web/index.html`) le envía cada mensaje al servidor por `POST /api/chat`. El servidor (`src/server.ts`) maneja las sesiones y le pasa el mensaje al ciclo del agente (`src/agente.ts`). El agente habla con el modelo a través de los adaptadores de `src/llm/` y ejecuta las herramientas de `src/tools/proveedor.ts`. Las herramientas leen de `fixtures/` y escriben en `out/`.

```
Navegador (web/index.html)
      │  POST /api/chat
      ▼
Servidor (src/server.ts) ──► Ciclo del agente (src/agente.ts) ──► Modelo (src/llm/: Gemini, Groq o Anthropic)
                                    │
                                    ▼
                         Herramientas (src/tools/proveedor.ts)
                          │                          │
                          ▼                          ▼
                  lee fixtures/               escribe out/<caso>/
```

Separé el proyecto en tres partes según lo que cambia más seguido:

- `agent/prompt.md` define el comportamiento: cómo habla el agente y en qué orden trabaja.
- `src/knowledge/` guarda el conocimiento del proceso y las reglas por país (`reglas.json`).
- `src/tools/` es la ejecución: cómo se leen y escriben los archivos.

Así, si mañana entra un país nuevo, basta con editar `reglas.json`. No hay que tocar el servidor.

## 3. Ciclo del agente

Todo pasa en `procesarMensaje`, dentro de `src/agente.ts`:

1. Se agrega el mensaje del usuario a la sesión.
2. Se llama al modelo con el prompt, el conocimiento, el historial y las cinco herramientas. El esquema JSON de cada herramienta sale de los mismos esquemas zod con `z.toJSONSchema`, para no mantener dos definiciones.
3. Si el modelo pide una herramienta, el servidor valida los argumentos con zod, la ejecuta y le devuelve el resultado. Esto se repite.
4. Cuando el modelo contesta sin pedir herramientas, esa es la respuesta del turno.

Para que el costo no se dispare puse tres topes: 25 vueltas por turno (`MAX_ITERACIONES`), 200 000 tokens por sesión (`MAX_TOKENS_SESION`) y 60 segundos por llamada al modelo. Si se llega al tope de vueltas, el agente cuenta lo que alcanzó a hacer y pide que el usuario escriba "continúa".

La confirmación humana antes de enviar (RN4 y CA3) tiene dos candados. El primero está en el prompt: cuando el agente necesita confirmación, termina su mensaje con la marca `[CONFIRMAR]`. El servidor la detecta, la quita del texto y responde `needsConfirmation: true`, y el chat muestra el mensaje en amarillo con los botones para confirmar o no. El segundo candado está en el código. Aunque el modelo llame a `proveedor_simular_envio` con `confirmado: true`, el servidor solo lo deja pasar si en el turno anterior se pidió confirmación y el usuario respondió que sí. No quise que la seguridad dependiera únicamente de que el modelo obedezca.

Sobre los errores (CA5): si el modelo falla, ya sea por falta de clave, por tiempo agotado o por un error HTTP, el turno se deshace, el chat muestra un mensaje claro y la sesión sigue funcionando. Las herramientas nunca lanzan excepciones, porque `ejecutar()` convierte cualquier error en `{ ok: false, error }`. Cada llamada, incluso las rechazadas, queda registrada en `out/log.jsonl` y en el log del caso.

## 4. Elección del modelo

El chat deja elegir el proveedor en cada mensaje. Configuré dos opciones gratuitas, Google Gemini con `gemini-3.1-flash-lite` y Groq con `openai/gpt-oss-120b`, y dejé Anthropic como alternativa de pago. Los modelos se cambian con `GEMINI_MODEL`, `GROQ_MODEL` y `ANTHROPIC_MODEL`.

Todos los proveedores implementan la misma interfaz (`src/llm/adapter.ts`), así que el ciclo del agente no se entera de cuál está usando. Para Groq escribí un adaptador genérico con el formato de OpenAI (`src/llm/openai-compatible.ts`), que también serviría para Ollama u OpenRouter. Como el historial se guarda en un formato neutro, se puede cambiar de proveedor a mitad de una conversación. Gemini exige unas firmas en las llamadas a herramientas que otros modelos no generan, así que para esos turnos uso la firma comodín que documenta Google.

En el plan gratuito la cuota es por proyecto y por modelo, con límites por minuto y por día. Cuando el servicio responde que se pasó el límite por minuto, el adaptador espera el tiempo que indica y reintenta. Si el servicio está saturado (errores 500 a 504), reintenta hasta tres veces con esperas crecientes.

¿Por qué un modelo pequeño? Porque lo difícil (mapear campos, validar vigencias, generar archivos) es determinista y está en las herramientas. El modelo solo decide en qué orden llamarlas y redacta el resumen.

Un caso completo usa unas 5 llamadas al modelo. Medí el repositorio: el prompt con el conocimiento ocupa unos 1 300 tokens, las definiciones de herramientas unos 830 y los resultados unos 870. Como el historial se reenvía en cada llamada, el total por caso ronda los 15 000 tokens de entrada y 1 000 de salida.

| Modelo | Precio por millón de tokens (entrada / salida) | Costo por caso | 12 casos al mes |
|---|---|---|---|
| Gemini 3.1 Flash-Lite, plan gratuito | Gratis dentro de los límites | 0 | 0 |
| GPT-OSS 120B en Groq, plan gratuito | Gratis dentro de los límites | 0 | 0 |
| Claude Haiku 4.5 | USD 1 / 5 | unos USD 0,02 | unos USD 0,24 |
| Claude Sonnet 5.5 | USD 2 / 10 | unos USD 0,04 | unos USD 0,48 |

Los precios de Anthropic son los publicados en platform.claude.com/docs/en/about-claude/pricing. El consumo real de cada sesión se puede ver en `GET /api/sessions/:id`, en el campo `tokens`.

## 5. Portal web (diseño, no implementado)

Por ahora, cuando el formato es `portal`, el agente avisa que no lo soporta y genera `valores-portal.md` con los valores listos para copiar. Los campos que necesitan confirmación llevan una nota.

Para una siguiente fase propongo un navegador asistido. El agente abriría el portal con Playwright en un navegador visible, en el equipo de la analista. Ella inicia sesión y el agente llena cada campo buscando su etiqueta con el mismo glosario. Al final toma una captura de pantalla para que ella revise.

Descarté un RPA comercial porque las licencias son caras y se rompe cuando el portal cambia de diseño. También descarté una extensión de navegador: es más simple, pero habría que mantener una por navegador.

Hay cosas que siempre haría la persona: el CAPTCHA, la autenticación de dos factores y el clic final en "Enviar". Si el portal cambia y el agente no encuentra una etiqueta, ese campo queda pendiente y no se adivina. Las credenciales que el cliente le manda al representante legal se guardan en el gestor de contraseñas de la empresa (Azure Key Vault o 1Password, por ejemplo) y las digita la persona. Nunca van en el repositorio, en el prompt, en los logs ni en el historial del modelo.

Reparto de tareas propuesto:

| Paso | Lo hace |
|---|---|
| Abrir el portal | Agente |
| Usuario, contraseña, MFA y CAPTCHA | Persona |
| Llenar los campos desde el maestro | Agente |
| Revisar la captura y los campos pendientes | Persona |
| Cargar soportes | El agente propone y la persona aprueba |
| Clic en "Enviar" | Persona |

## 6. Decisiones

1. **El mapeo de campos es determinista.** Uso el glosario: si la etiqueta coincide exacta, la confianza es 1.0, y si coincide ignorando tildes y mayúsculas, 0.9. Descarté pedirle al modelo que relacionara etiquetas parecidas, porque puede equivocarse o inventar. Si un cliente usa una etiqueta nueva, queda como faltante y basta con agregar el sinónimo en `glosario-campos.json`.
2. **`generar_formulario` recibe solo el nombre del caso.** El contrato sugería pasarle también el mapeo, pero preferí que leyera el que quedó guardado en `out/<caso>/mapeo.json`. Así el modelo nunca transporta valores y no los puede alterar (CA2). Es un desvío del contrato hecho a propósito.
3. **La confirmación también se verifica en el servidor.** Un prompt se puede ignorar o manipular. El código no.
4. **Llamo a las APIs con `fetch`, sin SDK.** Son menos dependencias y cada adaptador se lee en un archivo. A cambio, tuve que escribir yo los reintentos.
5. **El front es un solo HTML, sin framework.** No hay paso de compilación y todo el front se entiende leyendo un archivo. React con Vite habría sido excesivo para esto.
6. **La fecha de referencia es un argumento opcional de `armar_paquete`.** Así la demo siempre da el mismo resultado y se puede evaluar como si fuera el 3 de septiembre de 2026.
7. **Un paquete bloqueado se puede enviar si la persona lo confirma.** `ENVIO-SIMULADO.md` deja registrada la advertencia. No lo prohibí porque el PRD deja la decisión final al humano: el agente informa el riesgo, pero no decide.

## 7. Supuestos

- La "fecha de ejecución" de RN3 es `fecha_referencia` cuando se indica. Si no, es la fecha de hoy en Colombia.
- Un soporte sin `vigencia_hasta`, como el RUT, se considera vigente.
- Si un soporte exigido no está en el índice o su archivo no existe, se marca como ausente.
- Si todavía no se generó el formulario, el paquete se arma igual pero queda bloqueado por ese motivo.
- "Correo electrónico" se llena con el correo del contacto comercial, como dice el glosario.
- En el Excel, un campo faltante queda con la celda vacía. Nunca se escribe un valor de relleno.
- Como no tenemos el .xlsx original del cliente, se crea un libro con las hojas y celdas que indica la plantilla.
- Un formato desconocido se trata igual que el portal y genera `valores-para-copiar.md`.
- El cuerpo del correo del cliente no se le pasa al modelo, para reducir el riesgo de inyección de instrucciones.

## 8. Cobertura

| Historia | Estado | Falta para producción |
|---|---|---|
| HU-1 Leer la solicitud | Hecha | Leer el correo real (Graph API o IMAP) y los adjuntos. |
| HU-2 Mapear campos | Hecha | Que alguien sea dueño del maestro y lo mantenga al día. |
| HU-3 Excel (P0) | Hecha | Escribir sobre el .xlsx original del cliente para conservar su formato. |
| HU-3 PDF (P1) | Hecha, se genera un PDF propio | Rellenar el formulario PDF del cliente cuando lo envíe. |
| HU-3 Portal (P2) | Hecha con `valores-portal.md` | El navegador asistido de la sección 5. |
| HU-4 Paquete para firma | Hecha | Integración con firma electrónica. |
| HU-5 Manejo de errores | Hecha | Pruebas automáticas con plantillas dañadas reales. |
| Bonus: módulo reutilizable | No hecho | |

## 9. Uso de IA

Usé Claude (Anthropic) desde Claude Code en VS Code. Con él comparé los tres retos para escoger uno, generé la base del código (herramientas, ciclo del agente, adaptadores y front) y el primer borrador de este documento y del README.

También lo usé para revisar la entrega contra el PRD, buscar claves en el código y en el historial de git, agregar el `.dockerignore` para que el `.env` no quedara en la imagen de Docker, subir el proyecto a GitHub y desplegarlo en Render.

Lo que verifiqué: corrí `demo.ts` dos veces y la salida fue la misma, probé el chat en local y en el link público con los casos del reto (también el bloqueo del envío sin confirmación) y revisé que el `.env` no estuviera en el repositorio.

De lo que se propuso descarté tres cosas: mapear los campos con el modelo, porque puede inventar un valor; hacer el front en React, porque para una sola pantalla no hacía falta; y usar los SDK de cada proveedor, para no sumar dependencias. Las razones están en la sección 6.

## 10. Riesgos para producción

- **Que el modelo "complete" un campo con un valor creíble.** Los valores solo salen de las herramientas y el formulario se arma desde el mapeo guardado, no desde lo que diga el modelo.
- **Que el repositorio maestro se desactualice.** Hay que nombrar a un responsable del dato y avisar cuando un soporte esté por vencer.
- **Que alguien gaste la clave usando el link público.** Ya hay topes por turno y por sesión. En producción haría falta autenticación corporativa (SSO) y un límite global de uso.
- **Que `/out/` deje ver formularios con datos bancarios.** En producción se necesita autenticación y un almacenamiento privado, como SharePoint o un blob con permisos.
- **Que las plantillas reales vengan peor que los fixtures.** La validación con zod da mensajes claros, y cada caso nuevo sirve para ampliar el glosario.
- **Que el correo del cliente traiga instrucciones maliciosas.** El cuerpo del correo no llega al modelo, y cualquier acción externa exige una confirmación que verifica el servidor.
- **Que se pierdan las sesiones al reiniciar.** Hoy viven en memoria y `out/` no persiste en Render. Si se necesita historial, hay que guardarlos en un almacenamiento externo.
