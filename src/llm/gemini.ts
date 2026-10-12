// Implementación del adaptador para Google Gemini (API nativa) usando fetch, sin SDK.
import type { DefinicionHerramienta, LlamadaHerramienta, Mensaje, ProveedorLLM, RespuestaLLM } from "./adapter"

const URL_BASE = "https://generativelanguage.googleapis.com/v1beta/models"
const TIEMPO_LIMITE_MS = 60_000
const ERRORES_TEMPORALES = new Set([500, 502, 503, 504])
const ESPERAS_REINTENTO_MS = [2_000, 5_000, 10_000] // hasta 3 reintentos, unos 17 s en total
const ESPERA_MAXIMA_CUOTA_MS = 65_000 // el plan gratuito limita llamadas por minuto
const MAX_REINTENTOS_CUOTA = 2
const PREFIJO_ID_PROPIO = "gen-" // ids que inventamos cuando Gemini no los entrega; no se devuelven a la API

type Parte = {
  text?: string
  thought?: boolean
  functionCall?: { id?: string; name: string; args?: unknown }
  functionResponse?: { id?: string; name: string; response: unknown }
  thoughtSignature?: string
}
type RespuestaApi = {
  candidates?: { content?: { parts?: Parte[] }; finishReason?: string }[]
  promptFeedback?: { blockReason?: string }
  usageMetadata?: { totalTokenCount?: number }
}

export function crearGemini(modelo: string): ProveedorLLM {
  return {
    nombre: "gemini",
    modelo,
    async enviar(sistema: string, mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaLLM> {
      const clave = process.env.GEMINI_API_KEY // la clave solo vive en el backend
      if (!clave) throw new Error("Falta configurar GEMINI_API_KEY en el servidor.")

      const cuerpo = JSON.stringify({
        systemInstruction: { parts: [{ text: sistema }] },
        contents: aFormatoGemini(mensajes),
        tools: [{ functionDeclarations: herramientas.map((h) => ({ name: h.nombre, description: h.descripcion, parametersJsonSchema: h.esquema })) }],
        generationConfig: { maxOutputTokens: 4096 },
      })

      // Reintentos: la sobrecarga (500-504) se espera con tiempos crecientes; el límite por minuto (429)
      // se espera lo que Google indique. Una cuota diaria agotada no trae espera y no se reintenta.
      let respuesta: Response
      let reintentosSobrecarga = 0
      let reintentosCuota = 0
      for (;;) {
        try {
          respuesta = await fetch(`${URL_BASE}/${encodeURIComponent(modelo)}:generateContent`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-goog-api-key": clave },
            body: cuerpo,
            signal: AbortSignal.timeout(TIEMPO_LIMITE_MS),
          })
        } catch (e) {
          const timeout = e instanceof Error && e.name === "TimeoutError"
          throw new Error(timeout ? "El modelo no respondió a tiempo (60 s). Intenta de nuevo." : "No se pudo conectar con el proveedor del modelo.")
        }
        if (respuesta.ok) break

        const error = await leerError(respuesta)
        let espera: number | undefined
        if (ERRORES_TEMPORALES.has(respuesta.status) && reintentosSobrecarga < ESPERAS_REINTENTO_MS.length) {
          espera = ESPERAS_REINTENTO_MS[reintentosSobrecarga++]
        } else if (respuesta.status === 429 && error.esperaMs !== undefined && error.esperaMs <= ESPERA_MAXIMA_CUOTA_MS && reintentosCuota < MAX_REINTENTOS_CUOTA) {
          reintentosCuota++
          espera = error.esperaMs + 1_000
        }
        // Google explica el motivo en error.message (por ejemplo, un modelo retirado); se agrega sin exponer la clave.
        if (espera === undefined) throw new Error(`${mensajeDeError(respuesta.status, modelo)}${error.mensaje ? ` Detalle de Gemini: ${error.mensaje}` : ""}`)
        console.warn(`Gemini respondió ${respuesta.status}; nuevo intento en ${Math.round(espera / 1000)} s.`)
        await Bun.sleep(espera)
      }

      const datos = (await respuesta.json()) as RespuestaApi
      const candidato = datos.candidates?.[0]
      if (!candidato?.content) {
        const motivo = datos.promptFeedback?.blockReason ?? candidato?.finishReason ?? "sin contenido"
        throw new Error(`El modelo no devolvió respuesta (${motivo}).`)
      }
      const partes = candidato.content.parts ?? []
      const texto = partes.flatMap((p) => (p.text && !p.thought ? [p.text] : [])).join("\n")
      const llamadas: LlamadaHerramienta[] = partes.flatMap((p, i) =>
        p.functionCall ? [{ id: p.functionCall.id ?? `${PREFIJO_ID_PROPIO}${Date.now()}-${i}`, nombre: p.functionCall.name, args: p.functionCall.args ?? {} }] : [],
      )
      // Las partes originales se guardan tal cual: Gemini exige recibir de vuelta sus firmas de razonamiento.
      return { texto, llamadas, tokens: datos.usageMetadata?.totalTokenCount ?? 0, extra: { proveedor: "gemini", partes } }
    },
  }
}

/** Lee el mensaje de error de Google y, si lo trae, cuánto esperar antes de reintentar (RetryInfo). */
async function leerError(respuesta: Response): Promise<{ mensaje: string; esperaMs?: number }> {
  type ErrorApi = { error?: { message?: string; details?: { "@type"?: string; retryDelay?: string }[] } }
  const datos = (await respuesta.json().catch(() => ({}))) as ErrorApi
  const mensaje = datos.error?.message ?? ""
  const retraso =
    datos.error?.details?.find((d) => d["@type"]?.endsWith("RetryInfo"))?.retryDelay ?? mensaje.match(/retry in ([\d.]+)s/i)?.[1]
  const segundos = retraso === undefined ? Number.NaN : Number.parseFloat(retraso)
  return { mensaje, esperaMs: Number.isFinite(segundos) ? Math.ceil(segundos * 1000) : undefined }
}

function mensajeDeError(status: number, modelo: string): string {
  if (status === 400) return "Gemini rechazó la solicitud (error 400). Revisa el modelo y la clave."
  if (status === 401 || status === 403) return "La clave de Gemini no es válida o no tiene permiso (revisa GEMINI_API_KEY)."
  if (status === 404) return `El modelo "${modelo}" no está disponible en Gemini. Cambia GEMINI_MODEL.`
  if (status === 429) return "Se agotó la cuota gratuita de Gemini, incluso después de esperar. Si es el límite diario, se renueva mañana; si no, intenta en un minuto."
  if (ERRORES_TEMPORALES.has(status)) return `Gemini está saturado en este momento (error ${status}), incluso después de ${ESPERAS_REINTENTO_MS.length} reintentos. Intenta de nuevo en unos minutos.`
  return `El proveedor del modelo respondió con error ${status}.`
}

/** Traduce nuestro formato neutro de mensajes al formato de la API de Gemini. */
function aFormatoGemini(mensajes: Mensaje[]) {
  const nombrePorId = new Map<string, string>()
  const idsDeGemini = new Set<string>() // solo se reenvían a Gemini los ids que él mismo generó
  return mensajes.map((m) => {
    if (m.rol === "usuario") return { role: "user", parts: [{ text: m.texto }] }
    if (m.rol === "asistente") {
      for (const l of m.llamadas) nombrePorId.set(l.id, l.nombre)
      const propias = partesDeGemini(m.extra)
      if (propias) {
        for (const p of propias) if (p.functionCall?.id) idsDeGemini.add(p.functionCall.id)
        return { role: "model", parts: propias.length ? propias : [{ text: "(sin texto)" }] }
      }
      // Turno escrito por otro proveedor (por ejemplo, Groq): no trae firmas de Gemini. Se usa la
      // firma comodín que documenta Google para historial que no generó Gemini.
      const partes = [
        ...(m.texto ? [{ text: m.texto }] : []),
        ...m.llamadas.map((l) => ({ functionCall: { name: l.nombre, args: l.args }, thoughtSignature: FIRMA_COMODIN })),
      ]
      return { role: "model", parts: partes.length ? partes : [{ text: "(sin texto)" }] }
    }
    return {
      role: "user",
      parts: m.resultados.map((r) => ({
        functionResponse: { ...(idsDeGemini.has(r.id) ? { id: r.id } : {}), name: nombrePorId.get(r.id) ?? "desconocida", response: comoObjeto(r.contenido) },
      })),
    }
  })
}

const FIRMA_COMODIN = "skip_thought_signature_validator"

/** Devuelve las partes originales si el turno lo generó Gemini; si no, undefined. */
function partesDeGemini(extra: unknown): Parte[] | undefined {
  const e = extra as { proveedor?: string; partes?: unknown } | undefined
  return e?.proveedor === "gemini" && Array.isArray(e.partes) ? (e.partes as Parte[]) : undefined
}

/** Gemini exige que la respuesta de una función sea un objeto JSON. */
function comoObjeto(contenido: string): Record<string, unknown> {
  try {
    const valor = JSON.parse(contenido)
    return typeof valor === "object" && valor !== null && !Array.isArray(valor) ? valor : { resultado: valor }
  } catch {
    return { resultado: contenido }
  }
}
