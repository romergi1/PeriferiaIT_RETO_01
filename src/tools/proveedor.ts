// Herramientas del agente "Registro como Proveedor".
// Cada export de este archivo se expone al modelo como proveedor_<export>.
// Por eso aquí SOLO se exportan herramientas; las funciones de apoyo no se exportan.
import { z } from "zod"
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import {
  type Celda,
  type CampoMapeado,
  type Solicitud,
  EstadoPaqueteSchema,
  GlosarioSchema,
  IndiceSoportesSchema,
  MaestroSchema,
  MapeoSchema,
  PlantillaCamposSchema,
  PlantillaCeldasSchema,
  ReglasSchema,
  SolicitudSchema,
  SoportesExigidosSchema,
} from "./esquemas"
import {
  type Contexto,
  ErrorClaro,
  ejecutar,
  hoy,
  leerJson,
  normalizar,
  relativa,
  rutaConocimiento,
  rutaFixtures,
  rutaSalida,
  validarCaso,
} from "./utilidades"
import { type Fila, escribirExcel, escribirPdf, escribirValoresMd } from "./formularios"

const argCaso = z.string().describe("Nombre de la carpeta del caso en fixtures/reto-01/casos/, por ejemplo co-industrias-delta")

// 1. Leer la solicitud

export const leer_solicitud = {
  description: "Lee la solicitud de un caso y devuelve país, cliente, formato de salida, campos que pide la plantilla y soportes exigidos.",
  args: { caso: argCaso },
  async execute(args: { caso: string }, ctx: Contexto): Promise<string> {
    return ejecutar(ctx, "proveedor_leer_solicitud", args.caso, async () => {
      await validarCaso(ctx, args.caso)
      const solicitud = await leerSolicitud(ctx, args.caso)
      const soportes = await leerJson(rutaFixtures(ctx, "casos", args.caso, "soportes-exigidos.json"), SoportesExigidosSchema, "los soportes exigidos")
      const reglas = await leerJson(rutaConocimiento(ctx, "reglas.json"), ReglasSchema, "las reglas de negocio")

      // Si la plantilla está dañada seguimos con lo que sí podemos leer (HU-5).
      let campos: string[] = []
      const advertencias: string[] = []
      try {
        campos = (await leerPlantilla(ctx, args.caso)).etiquetas
      } catch (e) {
        advertencias.push(e instanceof Error ? e.message : String(e))
      }

      return {
        pais: solicitud.pais,
        cliente: solicitud.cliente,
        formato: solicitud.formato,
        campos,
        soportes,
        identificador_tributario_del_pais: reglas.identificador_por_pais[solicitud.pais] ?? null,
        correo: { de: solicitud.de, asunto: solicitud.asunto, fecha: solicitud.fecha },
        advertencias,
      }
    })
  },
}

// 2. Mapear campos al maestro

export const mapear_campos = {
  description: "Cruza cada campo pedido con el repositorio maestro y lo clasifica como lleno, faltante o requiere_confirmacion; nunca inventa valores.",
  args: {
    caso: argCaso,
    campos: z
      .array(z.string())
      .optional()
      .describe("Etiquetas a mapear tal como las devolvió leer_solicitud. Si se omite, se usan todas las de la plantilla"),
  },
  async execute(args: { caso: string; campos?: string[] }, ctx: Contexto): Promise<string> {
    return ejecutar(ctx, "proveedor_mapear_campos", args.caso, async () => {
      await validarCaso(ctx, args.caso)
      const campos = args.campos ?? (await leerPlantilla(ctx, args.caso)).etiquetas
      if (campos.length === 0) throw new ErrorClaro("No hay campos para mapear.")

      const mapeo = await calcularMapeo(ctx, args.caso, campos)
      await mkdir(rutaSalida(ctx, args.caso), { recursive: true })
      await writeFile(rutaSalida(ctx, args.caso, "mapeo.json"), JSON.stringify(mapeo, null, 2))

      return {
        llenos: mapeo.filter((m) => m.estado === "lleno").map(({ campo, valor, fuente, confianza }) => ({ campo, valor, fuente, confianza })),
        faltantes: mapeo.filter((m) => m.estado === "faltante").map(({ campo, nota }) => ({ campo, motivo: nota })),
        requiere_confirmacion: mapeo
          .filter((m) => m.estado === "requiere_confirmacion")
          .map(({ campo, valor, fuente, nota }) => ({ campo, valor, fuente, nota })),
      }
    })
  },
}

// 3. Generar el formulario

export const generar_formulario = {
  description: "Genera el formulario lleno en el formato que pidió el cliente (Excel o PDF) usando el último mapeo del caso; para portal web deja los valores listos para copiar.",
  args: { caso: argCaso },
  async execute(args: { caso: string }, ctx: Contexto): Promise<string> {
    return ejecutar(ctx, "proveedor_generar_formulario", args.caso, async () => {
      await validarCaso(ctx, args.caso)
      const solicitud = await leerSolicitud(ctx, args.caso)
      const plantilla = await leerPlantilla(ctx, args.caso)
      // Los valores salen del mapeo guardado, no de lo que diga el modelo (regla CA2).
      const mapeo = await leerJson(rutaSalida(ctx, args.caso, "mapeo.json"), MapeoSchema, "el mapeo del caso (ejecuta primero proveedor_mapear_campos)")
      const valores = new Map(mapeo.map((m) => [m.campo, m.valor]))
      const filas: Fila[] = plantilla.etiquetas.map((etiqueta) => {
        const m = mapeo.find((x) => x.campo === etiqueta)
        const nota = m && m.estado !== "lleno" ? `${m.estado}: ${m.nota ?? ""}` : null
        return { etiqueta, valor: m?.valor ?? null, nota }
      })
      const titulo = `Registro de proveedor - ${solicitud.cliente}`

      if (solicitud.formato === "xlsx") {
        if (!plantilla.celdas) throw new ErrorClaro("La solicitud pide Excel pero el caso no trae plantilla-celdas.json.")
        const ruta = rutaSalida(ctx, args.caso, "formulario.xlsx")
        await escribirExcel(ruta, plantilla.celdas, valores)
        return { ruta: relativa(ctx, ruta), formato: "xlsx" }
      }

      if (solicitud.formato === "pdf") {
        const ruta = rutaSalida(ctx, args.caso, "formulario.pdf")
        await escribirPdf(ruta, titulo, `Solicitud ${solicitud.id} del ${solicitud.fecha}`, filas)
        return { ruta: relativa(ctx, ruta), formato: "pdf" }
      }

      // Portal web u otro formato: no se implementa, se dejan los valores para copiar (P2).
      const archivo = solicitud.formato === "portal" ? "valores-portal.md" : "valores-para-copiar.md"
      const ruta = rutaSalida(ctx, args.caso, archivo)
      const aviso = `Formato no soportado (${solicitud.formato}): una persona diligencia el formulario. Copie estos valores.`
      await escribirValoresMd(ruta, `Valores para ${solicitud.cliente}`, aviso, filas)
      return { ruta: relativa(ctx, ruta), formato: solicitud.formato, soportado: false, mensaje: `formato no soportado: ${solicitud.formato}` }
    })
  },
}

// 4. Armar el paquete para firma

export const armar_paquete = {
  description: "Arma la carpeta del paquete para firma con el formulario, los soportes exigidos, un checklist de vigencias y un borrador de correo, e indica si quedó listo para firma.",
  args: {
    caso: argCaso,
    fecha_referencia: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("Fecha para evaluar la vigencia de los soportes (YYYY-MM-DD). Si se omite, se usa la fecha de hoy"),
  },
  async execute(args: { caso: string; fecha_referencia?: string }, ctx: Contexto): Promise<string> {
    return ejecutar(ctx, "proveedor_armar_paquete", args.caso, async () => {
      await validarCaso(ctx, args.caso)
      const fecha = args.fecha_referencia ?? hoy()
      const solicitud = await leerSolicitud(ctx, args.caso)
      const exigidos = await leerJson(rutaFixtures(ctx, "casos", args.caso, "soportes-exigidos.json"), SoportesExigidosSchema, "los soportes exigidos")
      const indice = await leerJson(rutaFixtures(ctx, "repositorio", "soportes", "index.json"), IndiceSoportesSchema, "el índice de soportes")
      const maestro = await leerJson(rutaFixtures(ctx, "repositorio", "maestro.json"), MaestroSchema, "el repositorio maestro")
      const rutaMapeo = rutaSalida(ctx, args.caso, "mapeo.json")
      const mapeo = existsSync(rutaMapeo) ? await leerJson(rutaMapeo, MapeoSchema, "el mapeo del caso") : []

      // Carpeta limpia en cada ejecución
      const carpeta = rutaSalida(ctx, args.caso, "paquete")
      await rm(carpeta, { recursive: true, force: true })
      await mkdir(carpeta, { recursive: true })
      const motivos: string[] = []
      const archivos: string[] = []

      // a) Formulario
      const formulario = ["formulario.xlsx", "formulario.pdf", "valores-portal.md", "valores-para-copiar.md"].find((a) =>
        existsSync(rutaSalida(ctx, args.caso, a)),
      )
      if (formulario) {
        await copyFile(rutaSalida(ctx, args.caso, formulario), `${carpeta}/${formulario}`)
        archivos.push(formulario)
      } else {
        motivos.push("No se ha generado el formulario")
      }

      // b) Soportes: presente, vencido o ausente (RN3)
      const soportes = exigidos.map((tipo) => {
        const s = indice.find((i) => i.tipo === tipo)
        if (!s || !existsSync(rutaFixtures(ctx, "repositorio", "soportes", s.archivo))) {
          return { tipo, estado: "ausente", archivo: null, vigencia_hasta: null, descripcion: tipo }
        }
        const vencido = s.vigencia_hasta !== null && s.vigencia_hasta < fecha
        return { tipo, estado: vencido ? "vencido" : "presente", archivo: s.archivo, vigencia_hasta: s.vigencia_hasta, descripcion: s.descripcion }
      })
      for (const s of soportes) {
        if (s.archivo) {
          await copyFile(rutaFixtures(ctx, "repositorio", "soportes", s.archivo), `${carpeta}/${s.archivo}`)
          archivos.push(s.archivo)
        }
        if (s.estado === "ausente") motivos.push(`Falta el soporte exigido: ${s.tipo}`)
        if (s.estado === "vencido") motivos.push(`Soporte vencido: ${s.tipo} (vigente hasta ${s.vigencia_hasta})`)
      }

      const listo = motivos.length === 0
      const faltantes = mapeo.filter((m) => m.estado === "faltante").map((m) => m.campo)
      const porConfirmar = mapeo.filter((m) => m.estado === "requiere_confirmacion").map((m) => `${m.campo}: ${m.nota}`)

      // c) Checklist y borrador de correo
      await writeFile(`${carpeta}/checklist.md`, textoChecklist(solicitud, fecha, listo, motivos, soportes, faltantes, porConfirmar))
      const borrador = textoBorrador(solicitud, String(maestro.razon_social ?? "Periferia IT Group"), soportes, listo, motivos)
      const cuenta = (maestro.banco as { numero_cuenta?: unknown } | undefined)?.numero_cuenta
      if (cuenta !== undefined && borrador.includes(String(cuenta))) throw new ErrorClaro("RN2: el borrador no puede incluir datos bancarios.")
      await writeFile(`${carpeta}/borrador-correo.md`, borrador)
      archivos.push("checklist.md", "borrador-correo.md")

      const estado = EstadoPaqueteSchema.parse({ listo_para_firma: listo, motivos_bloqueo: motivos, fecha_referencia: fecha, archivos })
      await writeFile(rutaSalida(ctx, args.caso, "estado-paquete.json"), JSON.stringify(estado, null, 2))

      return {
        ruta: relativa(ctx, carpeta),
        listo_para_firma: listo,
        motivos_bloqueo: motivos,
        fecha_referencia: fecha,
        checklist: {
          presentes: soportes.filter((s) => s.estado === "presente").map((s) => s.tipo),
          vencidos: soportes.filter((s) => s.estado === "vencido").map((s) => s.tipo),
          ausentes: soportes.filter((s) => s.estado === "ausente").map((s) => s.tipo),
          campos_faltantes: faltantes,
          campos_por_confirmar: porConfirmar,
        },
      }
    })
  },
}

// 5. Simular el envío

export const simular_envio = {
  description: "Simula el envío del paquete escribiendo ENVIO-SIMULADO.md; solo funciona si el usuario confirmó explícitamente el envío.",
  args: {
    caso: argCaso,
    confirmado: z.boolean().describe("true solo si el usuario confirmó el envío de forma explícita en su último mensaje"),
  },
  async execute(args: { caso: string; confirmado: boolean }, ctx: Contexto): Promise<string> {
    return ejecutar(ctx, "proveedor_simular_envio", args.caso, async () => {
      await validarCaso(ctx, args.caso)
      if (!args.confirmado) throw new ErrorClaro("requiere confirmación explícita")
      const estado = await leerJson(rutaSalida(ctx, args.caso, "estado-paquete.json"), EstadoPaqueteSchema, "el paquete del caso (ejecuta primero proveedor_armar_paquete)")
      const solicitud = await leerSolicitud(ctx, args.caso)

      const advertencia = estado.listo_para_firma
        ? ""
        : `\n**Advertencia:** el usuario confirmó el envío con el paquete bloqueado:\n${estado.motivos_bloqueo.map((m) => `- ${m}`).join("\n")}\n`
      const texto = `# Envío simulado

- Fecha: ${new Date().toISOString()}
- Para: ${solicitud.de}
- Asunto: RE: ${solicitud.asunto}
- Adjuntos: ${estado.archivos.join(", ")}
- Estado del paquete: ${estado.listo_para_firma ? "listo para firma" : "BLOQUEADO"}
${advertencia}
> Simulación: no se envió ningún correo real.
`
      const ruta = rutaSalida(ctx, args.caso, "ENVIO-SIMULADO.md")
      await writeFile(ruta, texto)
      return { ruta: relativa(ctx, ruta), listo_para_firma: estado.listo_para_firma }
    })
  },
}

// Funciones de apoyo (no se exportan)

function leerSolicitud(ctx: Contexto, caso: string): Promise<Solicitud> {
  return leerJson(rutaFixtures(ctx, "casos", caso, "solicitud.json"), SolicitudSchema, `la solicitud del caso ${caso}`)
}

/** Lee la plantilla Excel (celdas) o, si no existe, la plantilla de campos (PDF / portal). */
async function leerPlantilla(ctx: Contexto, caso: string): Promise<{ etiquetas: string[]; celdas: Celda[] | null }> {
  const rutaCeldas = rutaFixtures(ctx, "casos", caso, "plantilla-celdas.json")
  if (existsSync(rutaCeldas)) {
    const celdas = await leerJson(rutaCeldas, PlantillaCeldasSchema, "la plantilla Excel (plantilla-celdas.json)")
    return { etiquetas: celdas.map((c) => c.etiqueta), celdas }
  }
  const campos = await leerJson(rutaFixtures(ctx, "casos", caso, "plantilla-campos.json"), PlantillaCamposSchema, "la plantilla (plantilla-campos.json)")
  return { etiquetas: campos.map((c) => c.etiqueta), celdas: null }
}

/** Busca un valor en el maestro siguiendo una ruta tipo "banco.numero_cuenta". */
function valorEnMaestro(maestro: Record<string, unknown>, ruta: string): string | number | null {
  let actual: unknown = maestro
  for (const parte of ruta.split(".")) {
    if (typeof actual !== "object" || actual === null) return null
    actual = (actual as Record<string, unknown>)[parte]
  }
  if (typeof actual === "string" || typeof actual === "number") return actual
  if (typeof actual === "boolean") return actual ? "Sí" : "No"
  return null
}

/** Regla central del reto: cada campo termina en lleno, faltante o requiere_confirmacion. */
async function calcularMapeo(ctx: Contexto, caso: string, campos: string[]): Promise<CampoMapeado[]> {
  const solicitud = await leerSolicitud(ctx, caso)
  const glosario = await leerJson(rutaFixtures(ctx, "glosario-campos.json"), GlosarioSchema, "el glosario de campos")
  const maestro = await leerJson(rutaFixtures(ctx, "repositorio", "maestro.json"), MaestroSchema, "el repositorio maestro")
  const reglas = await leerJson(rutaConocimiento(ctx, "reglas.json"), ReglasSchema, "las reglas de negocio")

  const glosarioNormalizado = new Map(Object.entries(glosario).map(([etiqueta, clave]) => [normalizar(etiqueta), clave]))
  const ambiguas = new Set(reglas.etiquetas_ambiguas.map(normalizar))
  const idDelPais = reglas.identificador_por_pais[solicitud.pais] ?? "identificador tributario"
  const paisDelMaestro = valorEnMaestro(maestro, "pais")

  return campos.map((campo): CampoMapeado => {
    const clave = glosarioNormalizado.get(normalizar(campo))
    if (!clave) return { campo, estado: "faltante", valor: null, fuente: null, confianza: 0, nota: "La etiqueta no está en el glosario" }

    const fuente = `maestro.${clave}`
    const valor = valorEnMaestro(maestro, clave)
    if (valor === null) return { campo, estado: "faltante", valor: null, fuente, confianza: 0, nota: "El maestro no tiene este dato" }

    // 1.0 = la etiqueta está tal cual en el glosario; 0.9 = coincide ignorando tildes y mayúsculas
    const confianza = Object.hasOwn(glosario, campo) ? 1 : 0.9

    // RN1: identificador tributario por país
    if (clave === "nit" && ambiguas.has(normalizar(campo))) {
      return { campo, estado: "requiere_confirmacion", valor, fuente, confianza: 0.6, nota: `Etiqueta ambigua: para ${solicitud.pais} el equivalente es ${idDelPais}` }
    }
    if (clave === "nit" && solicitud.pais !== paisDelMaestro) {
      return { campo, estado: "requiere_confirmacion", valor, fuente, confianza, nota: `identificador extranjero: el cliente pide ${idDelPais} y Periferia solo tiene NIT colombiano` }
    }
    return { campo, estado: "lleno", valor, fuente, confianza, nota: null }
  })
}

type Soporte = { tipo: string; estado: string; archivo: string | null; vigencia_hasta: string | null; descripcion: string }

function textoChecklist(s: Solicitud, fecha: string, listo: boolean, motivos: string[], soportes: Soporte[], faltantes: string[], porConfirmar: string[]): string {
  const lista = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join("\n") : "- (ninguno)")
  const filas = soportes.map((x) => `| ${x.tipo} | ${x.archivo ?? "-"} | ${x.vigencia_hasta ?? "sin vencimiento"} | ${x.estado} |`).join("\n")
  return `# Checklist - ${s.cliente} (${s.id})

Fecha de referencia: ${fecha}
Estado: **${listo ? "LISTO PARA FIRMA" : "BLOQUEADO"}**

## Motivos de bloqueo
${lista(motivos)}

## Soportes exigidos
| Soporte | Archivo | Vigente hasta | Estado |
|---|---|---|---|
${filas}

## Campos faltantes (no bloquean, pero deben completarse)
${lista(faltantes)}

## Campos que requieren confirmación
${lista(porConfirmar)}
`
}

// RN2: el borrador se arma solo con datos del correo y la lista de soportes; nunca con datos bancarios.
function textoBorrador(s: Solicitud, razonSocial: string, soportes: Soporte[], listo: boolean, motivos: string[]): string {
  const adjuntos = soportes.filter((x) => x.estado === "presente").map((x) => `- ${x.descripcion}`).join("\n")
  const aviso = listo ? "" : `> BORRADOR - No enviar hasta resolver: ${motivos.join("; ")}\n\n`
  return `${aviso}Para: ${s.de}
Asunto: RE: ${s.asunto}

Buenos días,

Adjuntamos el formulario de registro de ${razonSocial} diligenciado y firmado por el representante legal, junto con los siguientes soportes:

${adjuntos || "- (sin soportes vigentes)"}

Quedamos atentos a cualquier información adicional.

Cordialmente,
Área Administrativa
${razonSocial}
`
}
