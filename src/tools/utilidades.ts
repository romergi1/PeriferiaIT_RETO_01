// Funciones de apoyo que usan las herramientas: rutas, lectura de JSON y el
// envoltorio `ejecutar`, que garantiza que ninguna herramienta lance excepciones.
import { appendFile, mkdir, readFile, readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join, relative, sep } from "node:path"
import type { z } from "zod"

export type Contexto = { directory: string; sessionId: string }

type Resultado = { ok: true; data: unknown } | { ok: false; error: string }

/** Error de negocio: su mensaje se muestra tal cual al usuario. */
export class ErrorClaro extends Error {}

export const rutaFixtures = (ctx: Contexto, ...partes: string[]) => join(ctx.directory, "fixtures", "reto-01", ...partes)
export const rutaSalida = (ctx: Contexto, ...partes: string[]) => join(ctx.directory, "out", ...partes)
export const rutaConocimiento = (ctx: Contexto, archivo: string) => join(ctx.directory, "src", "knowledge", archivo)
/** Ruta relativa a la raíz del proyecto (nunca exponemos rutas absolutas). */
export const relativa = (ctx: Contexto, ruta: string) => relative(ctx.directory, ruta).split(sep).join("/")

/** Lee un JSON y lo valida con zod. Si falla, lanza un ErrorClaro legible. */
export async function leerJson<T>(ruta: string, esquema: z.ZodType<T>, queEs: string): Promise<T> {
  if (!existsSync(ruta)) throw new ErrorClaro(`No encontré ${queEs}.`)
  let contenido: unknown
  try {
    contenido = JSON.parse(await readFile(ruta, "utf8"))
  } catch {
    throw new ErrorClaro(`El archivo de ${queEs} está corrupto (no es JSON válido).`)
  }
  const resultado = esquema.safeParse(contenido)
  if (!resultado.success) throw new ErrorClaro(`El archivo de ${queEs} no tiene la estructura esperada.`)
  return resultado.data
}

/** Valida el nombre del caso (evita rutas como "../") y que la carpeta exista. */
export async function validarCaso(ctx: Contexto, caso: string): Promise<void> {
  if (!/^[a-z0-9-]+$/.test(caso)) throw new ErrorClaro(`Nombre de caso inválido: "${caso}".`)
  if (!existsSync(rutaFixtures(ctx, "casos", caso))) {
    const disponibles = await readdir(rutaFixtures(ctx, "casos"))
    throw new ErrorClaro(`El caso "${caso}" no existe. Casos disponibles: ${disponibles.sort().join(", ")}.`)
  }
}

/** Fecha de hoy en Colombia, formato YYYY-MM-DD. */
export const hoy = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Bogota" })

/** Quita tildes, mayúsculas y espacios repetidos para comparar etiquetas. */
export const normalizar = (texto: string) =>
  texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim()

/**
 * Envoltorio común de todas las herramientas:
 * 1. ejecuta la lógica, 2. convierte cualquier error en { ok: false, error },
 * 3. deja el registro en out/log.jsonl y out/<caso>/log.jsonl, 4. devuelve JSON en texto.
 */
export async function ejecutar(ctx: Contexto, herramienta: string, caso: string, logica: () => Promise<unknown>): Promise<string> {
  let resultado: Resultado
  try {
    resultado = { ok: true, data: await logica() }
  } catch (e) {
    const detalle = e instanceof Error ? e.message : String(e)
    resultado = { ok: false, error: e instanceof ErrorClaro ? detalle : `Error inesperado en ${herramienta}: ${detalle}` }
  }
  await registrarLog(ctx, herramienta, caso, resultado)
  return JSON.stringify(resultado)
}

async function registrarLog(ctx: Contexto, herramienta: string, caso: string, resultado: Resultado): Promise<void> {
  const resumen = resultado.ok ? JSON.stringify(resultado.data).slice(0, 200) : resultado.error
  const linea = JSON.stringify({ ts: new Date().toISOString(), sesion: ctx.sessionId, herramienta, caso, ok: resultado.ok, resumen }) + "\n"
  try {
    await mkdir(rutaSalida(ctx), { recursive: true })
    await appendFile(rutaSalida(ctx, "log.jsonl"), linea)
    if (/^[a-z0-9-]+$/.test(caso) && existsSync(rutaFixtures(ctx, "casos", caso))) {
      await mkdir(rutaSalida(ctx, caso), { recursive: true })
      await appendFile(rutaSalida(ctx, caso, "log.jsonl"), linea)
    }
  } catch {
    // Si el log falla, la herramienta igual responde: el log nunca bloquea el proceso.
  }
}
