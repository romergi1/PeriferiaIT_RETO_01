// Servidor HTTP: sirve el chat (web/index.html) y expone la API del agente.
import { join, resolve, sep } from "node:path"
import { z } from "zod"
import { crearAnthropic } from "./llm/anthropic"
import { crearGemini } from "./llm/gemini"
import { crearCompatibleOpenAI } from "./llm/openai-compatible"
import type { ProveedorLLM } from "./llm/adapter"
import { type Sesion, crearSesion, procesarMensaje } from "./agente"

const RAIZ = join(import.meta.dir, "..")
const PUERTO = Number(process.env.PORT || 7477)

// Proveedores de modelo. Solo se ofrecen en el chat los que tienen su clave configurada.
const catalogo: { id: string; etiqueta: string; variableClave: string; crear: () => ProveedorLLM }[] = [
  { id: "gemini", etiqueta: "Gemini", variableClave: "GEMINI_API_KEY", crear: () => crearGemini(process.env.GEMINI_MODEL || "gemini-3.1-flash-lite") },
  {
    id: "groq",
    etiqueta: "Groq",
    variableClave: "GROQ_API_KEY",
    crear: () =>
      crearCompatibleOpenAI({
        nombre: "groq",
        etiqueta: "Groq",
        url: "https://api.groq.com/openai/v1/chat/completions",
        variableClave: "GROQ_API_KEY",
        modelo: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
      }),
  },
  { id: "anthropic", etiqueta: "Anthropic", variableClave: "ANTHROPIC_API_KEY", crear: () => crearAnthropic(process.env.ANTHROPIC_MODEL || "claude-haiku-4-5") },
]
const proveedores = new Map(catalogo.filter((p) => process.env[p.variableClave]).map((p) => [p.id, { etiqueta: p.etiqueta, llm: p.crear() }]))
// Si no hay ninguna clave, se deja Gemini para que el chat muestre el aviso de clave faltante.
if (proveedores.size === 0) proveedores.set("gemini", { etiqueta: "Gemini", llm: crearGemini(process.env.GEMINI_MODEL || "gemini-3.1-flash-lite") })
const PROVEEDOR_POR_DEFECTO = proveedores.has(process.env.LLM_PROVIDER ?? "") ? process.env.LLM_PROVIDER! : [...proveedores.keys()][0]!
const porDefecto = proveedores.get(PROVEEDOR_POR_DEFECTO)!.llm
const sesiones = new Map<string, Sesion>() // sesiones en memoria (no se requiere base de datos)

const CuerpoChat = z.object({
  sessionId: z.string().min(1).max(100),
  message: z.string().min(1).max(4000),
  provider: z.string().max(30).optional(), // proveedor elegido en el chat; si se omite, el por defecto
})
const json = (datos: unknown, status = 200) => Response.json(datos, { status })

Bun.serve({
  port: PUERTO,
  idleTimeout: 255, // máximo de Bun: un turno puede incluir esperas por la cuota gratuita de Gemini
  async fetch(req) {
    const url = new URL(req.url)
    const ruta = url.pathname

    if (req.method === "GET" && ruta === "/") return new Response(Bun.file(join(RAIZ, "web", "index.html")))

    if (req.method === "GET" && ruta === "/api/health") {
      const lista = [...proveedores].map(([id, p]) => ({ id, etiqueta: p.etiqueta, model: p.llm.modelo }))
      return json({ ok: true, provider: porDefecto.nombre, model: porDefecto.modelo, providers: lista })
    }

    if (req.method === "POST" && ruta === "/api/chat") {
      const cuerpo = CuerpoChat.safeParse(await req.json().catch(() => null))
      if (!cuerpo.success) return json({ error: "Se espera { sessionId, message, provider? }" }, 400)
      const { sessionId, message, provider = PROVEEDOR_POR_DEFECTO } = cuerpo.data
      const elegido = proveedores.get(provider)
      if (!elegido) return json({ error: `Proveedor no disponible: ${provider}. Disponibles: ${[...proveedores.keys()].join(", ")}.` }, 400)
      const sesion = sesiones.get(sessionId) ?? crearSesion(sessionId)
      sesiones.set(sessionId, sesion)
      const respuesta = await procesarMensaje(sesion, message, elegido.llm, RAIZ)
      return json({ ...respuesta, provider, model: elegido.llm.modelo })
    }

    const sesionPedida = ruta.match(/^\/api\/sessions\/([\w-]+)$/)
    if (req.method === "GET" && sesionPedida) {
      const sesion = sesiones.get(sesionPedida[1] ?? "")
      return sesion ? json({ id: sesion.id, tokens: sesion.tokens, historial: sesion.historial }) : json({ error: "Sesión no encontrada" }, 404)
    }

    // Descarga de archivos generados (formularios, paquetes). Solo dentro de out/.
    if (req.method === "GET" && ruta.startsWith("/out/")) {
      const archivo = resolve(RAIZ, "." + decodeURIComponent(ruta))
      if (archivo.startsWith(join(RAIZ, "out") + sep) && (await Bun.file(archivo).exists())) return new Response(Bun.file(archivo))
    }

    return json({ error: "No encontrado" }, 404)
  },
})

const resumen = [...proveedores].map(([id, p]) => `${id} (${p.llm.modelo})`).join(", ")
console.log(`Agente listo en http://localhost:${PUERTO}. Proveedores: ${resumen}. Por defecto: ${PROVEEDOR_POR_DEFECTO}`)
