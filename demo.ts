// Demo sin modelo: procesa todos los casos llamando directamente a las herramientas.
// No usa modelo de lenguaje ni necesita clave. Uso: bun run demo.ts
import { rm } from "node:fs/promises"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import * as proveedor from "./src/tools/proveedor"

const ctx = { directory: import.meta.dir, sessionId: "demo" }
const FECHA = "2026-09-03" // fecha fija: la demo da siempre el mismo resultado

type Respuesta<T> = { ok: true; data: T } | { ok: false; error: string }
type DatosSolicitud = { cliente: string; pais: string; formato: string; campos: string[] }
type DatosMapeo = { llenos: unknown[]; faltantes: { campo: string }[]; requiere_confirmacion: { campo: string }[] }
type DatosFormulario = { ruta: string }
type DatosPaquete = { listo_para_firma: boolean; motivos_bloqueo: string[] }
type DatosEnvio = { ruta: string }

const leer = <T>(texto: string) => JSON.parse(texto) as Respuesta<T>
const nombres = (lista: { campo: string }[]) => (lista.length ? ` (${lista.map((x) => x.campo).join(", ")})` : "")

await rm(join(ctx.directory, "out"), { recursive: true, force: true }) // out/ limpio en cada ejecución
console.log(`Demo sin modelo, fecha de referencia ${FECHA}\n`)

const casos = readdirSync(join(ctx.directory, "fixtures", "reto-01", "casos")).sort()
for (const caso of casos) {
  console.log(`== ${caso}`)

  const solicitud = leer<DatosSolicitud>(await proveedor.leer_solicitud.execute({ caso }, ctx))
  if (!solicitud.ok) {
    console.log(`   ERROR: ${solicitud.error}\n`)
    continue // un caso malo no detiene los demás
  }
  const s = solicitud.data
  console.log(`   ${s.cliente}, país ${s.pais}, formato ${s.formato}, ${s.campos.length} campos`)

  const mapeo = leer<DatosMapeo>(await proveedor.mapear_campos.execute({ caso, campos: s.campos }, ctx))
  if (mapeo.ok) {
    const m = mapeo.data
    console.log(`   Llenos: ${m.llenos.length}`)
    console.log(`   Faltantes: ${m.faltantes.length}${nombres(m.faltantes)}`)
    console.log(`   Requieren confirmación: ${m.requiere_confirmacion.length}${nombres(m.requiere_confirmacion)}`)
  } else console.log(`   ERROR mapeo: ${mapeo.error}`)

  const formulario = leer<DatosFormulario>(await proveedor.generar_formulario.execute({ caso }, ctx))
  console.log(formulario.ok ? `   Formulario: ${formulario.data.ruta}` : `   ERROR formulario: ${formulario.error}`)

  const paquete = leer<DatosPaquete>(await proveedor.armar_paquete.execute({ caso, fecha_referencia: FECHA }, ctx))
  if (paquete.ok) {
    const p = paquete.data
    console.log(`   Paquete: ${p.listo_para_firma ? "LISTO PARA FIRMA" : "BLOQUEADO"}`)
    p.motivos_bloqueo.forEach((motivo) => console.log(`     - ${motivo}`))
  } else console.log(`   ERROR paquete: ${paquete.error}`)
  console.log()
}

console.log("== Manejo de errores")
const inexistente = leer<unknown>(await proveedor.leer_solicitud.execute({ caso: "caso-que-no-existe" }, ctx))
console.log(`   Caso inexistente: ${inexistente.ok ? "ok" : inexistente.error}\n`)

console.log("== Confirmación humana (co-industrias-delta)")
const sinConfirmar = leer<DatosEnvio>(await proveedor.simular_envio.execute({ caso: "co-industrias-delta", confirmado: false }, ctx))
console.log(`   Sin confirmar: ${sinConfirmar.ok ? sinConfirmar.data.ruta : sinConfirmar.error}`)
const confirmado = leer<DatosEnvio>(await proveedor.simular_envio.execute({ caso: "co-industrias-delta", confirmado: true }, ctx))
console.log(`   Confirmado:    ${confirmado.ok ? confirmado.data.ruta : confirmado.error}`)
