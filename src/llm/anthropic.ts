// Implementación del adaptador para Anthropic (Claude) usando fetch, sin SDK.
import type { DefinicionHerramienta, Mensaje, ProveedorLLM, RespuestaLLM } from "./adapter"

const URL_API = "https://api.anthropic.com/v1/messages"
const TIEMPO_LIMITE_MS = 60_000

type BloqueRespuesta = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown }
type RespuestaApi = { content: BloqueRespuesta[]; usage: { input_tokens: number; output_tokens: number } }

export function crearAnthropic(modelo: string): ProveedorLLM {
  return {
    nombre: "anthropic",
    modelo,
    async enviar(sistema: string, mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaLLM> {
      const clave = process.env.ANTHROPIC_API_KEY // la clave solo vive en el backend
      if (!clave) throw new Error("Falta configurar ANTHROPIC_API_KEY en el servidor.")

      let respuesta: Response
      try {
        respuesta = await fetch(URL_API, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": clave, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: modelo,
            max_tokens: 2048,
            system: sistema,
            messages: mensajes.map(aFormatoAnthropic),
            tools: herramientas.map((h) => ({ name: h.nombre, description: h.descripcion, input_schema: h.esquema })),
          }),
          signal: AbortSignal.timeout(TIEMPO_LIMITE_MS),
        })
      } catch (e) {
        const timeout = e instanceof Error && e.name === "TimeoutError"
        throw new Error(timeout ? "El modelo no respondió a tiempo (60 s). Intenta de nuevo." : "No se pudo conectar con el proveedor del modelo.")
      }
      if (!respuesta.ok) throw new Error(`El proveedor del modelo respondió con error ${respuesta.status}.`)

      const datos = (await respuesta.json()) as RespuestaApi
      const texto = datos.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n")
      const llamadas = datos.content.flatMap((b) => (b.type === "tool_use" ? [{ id: b.id, nombre: b.name, args: b.input }] : []))
      return { texto, llamadas, tokens: datos.usage.input_tokens + datos.usage.output_tokens }
    },
  }
}

/** Traduce nuestro formato neutro de mensajes al formato de la API de Anthropic. */
function aFormatoAnthropic(m: Mensaje) {
  if (m.rol === "usuario") return { role: "user", content: m.texto }
  if (m.rol === "asistente") {
    return {
      role: "assistant",
      content: [
        ...(m.texto ? [{ type: "text", text: m.texto }] : []),
        ...m.llamadas.map((l) => ({ type: "tool_use", id: l.id, name: l.nombre, input: l.args })),
      ],
    }
  }
  return {
    role: "user",
    content: m.resultados.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.contenido, is_error: r.esError })),
  }
}
