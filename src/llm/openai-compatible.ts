// Adaptador para APIs con el formato de OpenAI (chat/completions), usando fetch, sin SDK.
// Sirve para Groq y, cambiando la URL, para otros servicios compatibles (Ollama, OpenRouter...).
import type { DefinicionHerramienta, LlamadaHerramienta, Mensaje, ProveedorLLM, RespuestaLLM } from "./adapter"

const TIEMPO_LIMITE_MS = 60_000
const ERRORES_TEMPORALES = new Set([500, 502, 503, 504])
const ESPERAS_REINTENTO_MS = [2_000, 5_000, 10_000] // sobrecarga: hasta 3 reintentos
const ESPERA_MAXIMA_CUOTA_MS = 65_000 // límite por minuto: se espera lo que indique el servicio
const MAX_REINTENTOS_CUOTA = 2
const MAX_REINTENTOS_LLAMADA_MAL_FORMADA = 1 // a veces el modelo escribe mal una llamada a herramienta

type Opciones = { nombre: string; etiqueta: string; url: string; variableClave: string; modelo: string }
type LlamadaApi = { id: string; type: "function"; function: { name: string; arguments: string } }
type RespuestaApi = {
  choices?: { message?: { content?: string | null; tool_calls?: LlamadaApi[] } }[]
  usage?: { total_tokens?: number }
}

export function crearCompatibleOpenAI(op: Opciones): ProveedorLLM {
  return {
    nombre: op.nombre,
    modelo: op.modelo,
    async enviar(sistema: string, mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaLLM> {
      const clave = process.env[op.variableClave] // la clave solo vive en el backend
      if (!clave) throw new Error(`Falta configurar ${op.variableClave} en el servidor.`)

      const cuerpo = JSON.stringify({
        model: op.modelo,
        max_tokens: 4096,
        messages: [{ role: "system", content: sistema } as MensajeApi, ...mensajes.flatMap(aFormatoOpenAI)],
        tools: herramientas.map((h) => ({ type: "function", function: { name: h.nombre, description: h.descripcion, parameters: h.esquema } })),
      })

      let respuesta: Response
      let reintentosSobrecarga = 0
      let reintentosCuota = 0
      let reintentosMalFormada = 0
      for (;;) {
        try {
          respuesta = await fetch(op.url, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${clave}` },
            body: cuerpo,
            signal: AbortSignal.timeout(TIEMPO_LIMITE_MS),
          })
        } catch (e) {
          const timeout = e instanceof Error && e.name === "TimeoutError"
          throw new Error(timeout ? "El modelo no respondió a tiempo (60 s). Intenta de nuevo." : `No se pudo conectar con ${op.etiqueta}.`)
        }
        if (respuesta.ok) break

        const error = await leerError(respuesta)
        let espera: number | undefined
        if (ERRORES_TEMPORALES.has(respuesta.status) && reintentosSobrecarga < ESPERAS_REINTENTO_MS.length) {
          espera = ESPERAS_REINTENTO_MS[reintentosSobrecarga++]
        } else if (respuesta.status === 429 && error.esperaMs !== undefined && error.esperaMs <= ESPERA_MAXIMA_CUOTA_MS && reintentosCuota < MAX_REINTENTOS_CUOTA) {
          reintentosCuota++
          espera = error.esperaMs + 1_000
        } else if (respuesta.status === 400 && error.codigo === "tool_use_failed" && reintentosMalFormada < MAX_REINTENTOS_LLAMADA_MAL_FORMADA) {
          reintentosMalFormada++
          espera = 0
        }
        if (espera === undefined) {
          throw new Error(`${mensajeDeError(respuesta.status, op)}${error.mensaje ? ` Detalle de ${op.etiqueta}: ${error.mensaje}` : ""}`)
        }
        console.warn(`${op.etiqueta} respondió ${respuesta.status}; nuevo intento en ${Math.round(espera / 1000)} s.`)
        await Bun.sleep(espera)
      }

      const datos = (await respuesta.json()) as RespuestaApi
      const mensaje = datos.choices?.[0]?.message
      if (!mensaje) throw new Error(`${op.etiqueta} no devolvió respuesta.`)
      const llamadas: LlamadaHerramienta[] = (mensaje.tool_calls ?? []).map((l) => ({ id: l.id, nombre: l.function.name, args: comoArgumentos(l.function.arguments) }))
      return { texto: mensaje.content ?? "", llamadas, tokens: datos.usage?.total_tokens ?? 0 }
    },
  }
}

type MensajeApi = { role: string; content: string | null; tool_calls?: LlamadaApi[]; tool_call_id?: string }

/** Traduce nuestro formato neutro de mensajes al formato de OpenAI. */
function aFormatoOpenAI(m: Mensaje): MensajeApi[] {
  if (m.rol === "usuario") return [{ role: "user", content: m.texto }]
  if (m.rol === "asistente") {
    if (m.llamadas.length === 0) return [{ role: "assistant", content: m.texto || "(sin texto)" }]
    return [
      {
        role: "assistant",
        content: m.texto || null,
        tool_calls: m.llamadas.map((l) => ({ id: l.id, type: "function" as const, function: { name: l.nombre, arguments: JSON.stringify(l.args ?? {}) } })),
      },
    ]
  }
  return m.resultados.map((r) => ({ role: "tool", tool_call_id: r.id, content: r.contenido }))
}

/** Los argumentos llegan como texto JSON; si vienen dañados, zod los rechazará después con un mensaje claro. */
function comoArgumentos(texto: string): unknown {
  try {
    return JSON.parse(texto || "{}")
  } catch {
    return { argumentos_invalidos: texto }
  }
}

/** Lee el mensaje de error y, si lo trae, cuánto esperar antes de reintentar. */
async function leerError(respuesta: Response): Promise<{ mensaje: string; codigo?: string; esperaMs?: number }> {
  const datos = (await respuesta.json().catch(() => ({}))) as { error?: { message?: string; code?: string } }
  const mensaje = datos.error?.message ?? ""
  const cabecera = respuesta.headers.get("retry-after")
  const segundos = cabecera !== null ? Number.parseFloat(cabecera) : Number.parseFloat(mensaje.match(/try again in ([\d.]+)s/i)?.[1] ?? "")
  return { mensaje, codigo: datos.error?.code, esperaMs: Number.isFinite(segundos) ? Math.ceil(segundos * 1000) : undefined }
}

function mensajeDeError(status: number, op: Opciones): string {
  if (status === 401 || status === 403) return `La clave de ${op.etiqueta} no es válida (revisa ${op.variableClave}).`
  if (status === 404) return `El modelo "${op.modelo}" no está disponible en ${op.etiqueta}.`
  if (status === 413) return `La conversación es demasiado larga para el plan gratuito de ${op.etiqueta}. Abre una sesión nueva.`
  if (status === 429) return `Se agotó la cuota gratuita de ${op.etiqueta}, incluso después de esperar. Intenta más tarde.`
  if (ERRORES_TEMPORALES.has(status)) return `${op.etiqueta} está saturado en este momento (error ${status}), incluso después de reintentar.`
  return `${op.etiqueta} respondió con error ${status}.`
}
