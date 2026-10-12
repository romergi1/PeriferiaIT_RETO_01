// Ciclo del agente: se llama al modelo, se ejecutan las herramientas que pida y se repite hasta que responda.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import * as proveedor from "./tools/proveedor"
import { type Contexto, ErrorClaro, ejecutar, hoy } from "./tools/utilidades"
import type { DefinicionHerramienta, Mensaje, ProveedorLLM } from "./llm/adapter"

const MAX_ITERACIONES = Number(process.env.MAX_ITERACIONES || 25) // CA1
const MAX_TOKENS_SESION = Number(process.env.MAX_TOKENS_SESION || 200_000) // tope de costo por sesión
const MARCA_CONFIRMACION = "[CONFIRMAR]" // el prompt pide al modelo usar esta marca al pedir confirmación
const RESPUESTA_AFIRMATIVA = /\b(s[ií]|confirmo|confirmado|adelante|procede|env[ií]a(lo)?)\b/i
const REQUIEREN_CONFIRMACION = new Set(["proveedor_simular_envio"]) // acciones externas (RN4)

type Herramienta = {
  description: string
  args: Record<string, z.ZodType>
  execute(args: Record<string, unknown>, ctx: Contexto): Promise<string>
}
export type LlamadaVisible = { nombre: string; args: unknown; ok: boolean; resumen: string }
export type RespuestaTurno = { reply: string; toolCalls: LlamadaVisible[]; needsConfirmation: boolean }
type EntradaHistorial = { rol: "usuario"; texto: string } | ({ rol: "agente" } & RespuestaTurno)

export type Sesion = {
  id: string
  mensajes: Mensaje[] // lo que ve el modelo
  historial: EntradaHistorial[] // lo que ve la persona en el chat
  tokens: number
  esperandoConfirmacion: boolean
}

// Registro de herramientas: cada export de tools/proveedor.ts se llama proveedor_<export>.
const herramientas: Record<string, Herramienta> = Object.fromEntries(
  Object.entries(proveedor).map(([nombre, herramienta]) => [`proveedor_${nombre}`, herramienta]),
)

// Definiciones que recibe el modelo: el esquema JSON sale de los mismos esquemas zod.
const definiciones: DefinicionHerramienta[] = Object.entries(herramientas).map(([nombre, h]) => {
  const { $schema: _omitido, ...esquema } = z.toJSONSchema(z.object(h.args))
  return { nombre, descripcion: h.description, esquema }
})

export const crearSesion = (id: string): Sesion => ({ id, mensajes: [], historial: [], tokens: 0, esperandoConfirmacion: false })

/** Prompt de comportamiento + conocimiento del proceso. Se lee en cada turno: editarlos no exige reiniciar. */
function cargarSistema(directorio: string): string {
  const prompt = readFileSync(join(directorio, "agent", "prompt.md"), "utf8")
  const conocimiento = readFileSync(join(directorio, "src", "knowledge", "registro-proveedor.md"), "utf8")
  return `${prompt}\n\nFecha de hoy: ${hoy()}\n\n---\n\n${conocimiento}`
}

/** Procesa un mensaje del usuario y devuelve la respuesta del agente. */
export async function procesarMensaje(sesion: Sesion, texto: string, llm: ProveedorLLM, directorio: string): Promise<RespuestaTurno> {
  const inicio = sesion.mensajes.length
  const estabaEsperando = sesion.esperandoConfirmacion
  // CA3: solo cuenta como confirmación si el agente preguntó en el turno anterior y el usuario respondió que sí.
  const confirmoAhora = estabaEsperando && RESPUESTA_AFIRMATIVA.test(texto)
  sesion.esperandoConfirmacion = false
  sesion.mensajes.push({ rol: "usuario", texto })
  sesion.historial.push({ rol: "usuario", texto })
  const llamadas: LlamadaVisible[] = []
  const ctx: Contexto = { directory: directorio, sessionId: sesion.id }

  try {
    for (let i = 0; i < MAX_ITERACIONES; i++) {
      if (sesion.tokens >= MAX_TOKENS_SESION) {
        return cerrarTurno(sesion, "Se alcanzó el tope de tokens de esta sesión. Abre una sesión nueva para continuar.", llamadas, false)
      }
      const respuesta = await llm.enviar(cargarSistema(directorio), sesion.mensajes, definiciones)
      sesion.tokens += respuesta.tokens
      const textoModelo = respuesta.texto || (respuesta.llamadas.length ? "" : "(El modelo no devolvió texto.)")
      sesion.mensajes.push({ rol: "asistente", texto: textoModelo, llamadas: respuesta.llamadas, extra: respuesta.extra })

      // Sin llamadas a herramientas = respuesta final del turno.
      if (respuesta.llamadas.length === 0) {
        const pideConfirmacion = textoModelo.includes(MARCA_CONFIRMACION)
        sesion.esperandoConfirmacion = pideConfirmacion
        // Algunos modelos escriben la marca entre comillas de código o negrita; se quitan junto con ella.
        const limpio = textoModelo.replace(/[`*]*\[CONFIRMAR\][`*]*[ \t]*/g, "").trim()
        return cerrarTurno(sesion, limpio, llamadas, pideConfirmacion, false)
      }

      const resultados = []
      for (const llamada of respuesta.llamadas) {
        const contenido = await ejecutarHerramienta(llamada.nombre, llamada.args, ctx, confirmoAhora)
        const { ok, resumen } = resumir(contenido)
        llamadas.push({ nombre: llamada.nombre, args: llamada.args, ok, resumen })
        resultados.push({ id: llamada.id, contenido, esError: !ok })
      }
      sesion.mensajes.push({ rol: "herramienta", resultados })
    }
    const hechas = [...new Set(llamadas.map((l) => l.nombre))].join(", ")
    return cerrarTurno(sesion, `Alcancé el tope de ${MAX_ITERACIONES} pasos en este turno. Alcancé a ejecutar: ${hechas}. Pídeme "continúa" para terminar lo que falta.`, llamadas, false)
  } catch (e) {
    // CA5: el error se muestra claro y la sesión sigue viva (se deshace el turno incompleto).
    sesion.mensajes.length = inicio
    sesion.esperandoConfirmacion = estabaEsperando
    const detalle = e instanceof Error ? e.message : String(e)
    return cerrarTurno(sesion, `No pude completar tu solicitud: ${detalle} La sesión sigue activa; puedes intentarlo de nuevo.`, llamadas, false, false)
  }
}

/** Valida argumentos con zod, aplica el cerrojo de confirmación y ejecuta la herramienta. */
async function ejecutarHerramienta(nombre: string, args: unknown, ctx: Contexto, confirmoAhora: boolean): Promise<string> {
  // Las llamadas rechazadas también pasan por `ejecutar` para quedar en out/log.jsonl (CA4).
  const caso = typeof args === "object" && args !== null && "caso" in args ? String(args.caso) : ""
  const rechazar = (error: string) => ejecutar(ctx, nombre, caso, async () => { throw new ErrorClaro(error) })

  const herramienta = herramientas[nombre]
  if (!herramienta) return rechazar(`La herramienta ${nombre} no existe.`)

  const validacion = z.object(herramienta.args).safeParse(args)
  if (!validacion.success) return rechazar(`Argumentos inválidos: ${z.prettifyError(validacion.error)}`)

  // RN4: aunque el modelo envíe confirmado=true, el servidor verifica que la persona realmente confirmó.
  if (REQUIEREN_CONFIRMACION.has(nombre) && validacion.data.confirmado === true && !confirmoAhora) {
    return rechazar("requiere confirmación explícita: pregunta al usuario y espera su respuesta")
  }
  return herramienta.execute(validacion.data, ctx)
}

function resumir(contenido: string): { ok: boolean; resumen: string } {
  try {
    const r = JSON.parse(contenido) as { ok: boolean; data?: unknown; error?: string }
    return { ok: r.ok, resumen: r.ok ? JSON.stringify(r.data).slice(0, 400) : String(r.error) }
  } catch {
    return { ok: false, resumen: "Respuesta de herramienta ilegible" }
  }
}

function cerrarTurno(sesion: Sesion, reply: string, toolCalls: LlamadaVisible[], needsConfirmation: boolean, agregarAlModelo = true): RespuestaTurno {
  // Si el turno no terminó con una respuesta del modelo, se agrega una para mantener el orden usuario/asistente.
  if (agregarAlModelo) sesion.mensajes.push({ rol: "asistente", texto: reply, llamadas: [] })
  const respuesta = { reply, toolCalls, needsConfirmation }
  sesion.historial.push({ rol: "agente", ...respuesta })
  return respuesta
}
