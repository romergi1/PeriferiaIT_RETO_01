// Interfaz propia del proveedor de modelo. El ciclo del agente solo conoce estos tipos,
// así que cambiar de proveedor (OpenAI, Gemini, Azure...) es escribir otra implementación.

export type LlamadaHerramienta = { id: string; nombre: string; args: unknown }

export type Mensaje =
  | { rol: "usuario"; texto: string }
  // `extra` guarda contenido propio del proveedor que debe reenviarse tal cual (por ejemplo, las firmas de Gemini).
  | { rol: "asistente"; texto: string; llamadas: LlamadaHerramienta[]; extra?: unknown }
  | { rol: "herramienta"; resultados: { id: string; contenido: string; esError: boolean }[] }

export type DefinicionHerramienta = { nombre: string; descripcion: string; esquema: Record<string, unknown> }

export type RespuestaLLM = { texto: string; llamadas: LlamadaHerramienta[]; tokens: number; extra?: unknown }

export interface ProveedorLLM {
  nombre: string
  modelo: string
  enviar(sistema: string, mensajes: Mensaje[], herramientas: DefinicionHerramienta[]): Promise<RespuestaLLM>
}
