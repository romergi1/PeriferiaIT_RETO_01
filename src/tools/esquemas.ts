// Esquemas zod de los archivos que leen las herramientas.
// Si un archivo no cumple su esquema, la herramienta responde con un error claro
// ("plantilla corrupta") en lugar de fallar más adelante.
import { z } from "zod"

export const SolicitudSchema = z.object({
  id: z.string(),
  de: z.string(),
  asunto: z.string(),
  fecha: z.string(),
  pais: z.string(),
  cliente: z.string(),
  formato: z.string(),
  cuerpo: z.string(),
  adjuntos: z.array(z.string()),
})
export type Solicitud = z.infer<typeof SolicitudSchema>

export const PlantillaCeldasSchema = z
  .array(z.object({ hoja: z.string(), celda_etiqueta: z.string(), etiqueta: z.string(), celda_valor: z.string() }))
  .min(1)
export type Celda = z.infer<typeof PlantillaCeldasSchema>[number]

export const PlantillaCamposSchema = z.array(z.object({ etiqueta: z.string(), obligatorio: z.boolean() })).min(1)

export const SoportesExigidosSchema = z.array(z.string())

export const IndiceSoportesSchema = z.array(
  z.object({
    tipo: z.string(),
    archivo: z.string(),
    vigencia_hasta: z.string().nullable(),
    pais_emisor: z.string(),
    descripcion: z.string(),
  }),
)

export const GlosarioSchema = z.record(z.string(), z.string())

export const MaestroSchema = z.record(z.string(), z.unknown())

export const ReglasSchema = z.object({
  identificador_por_pais: z.record(z.string(), z.string()),
  etiquetas_ambiguas: z.array(z.string()),
})

// Resultado del mapeo de un campo. Se guarda en out/<caso>/mapeo.json
export const CampoMapeadoSchema = z.object({
  campo: z.string(),
  estado: z.enum(["lleno", "faltante", "requiere_confirmacion"]),
  valor: z.union([z.string(), z.number()]).nullable(),
  fuente: z.string().nullable(),
  confianza: z.number(),
  nota: z.string().nullable(),
})
export type CampoMapeado = z.infer<typeof CampoMapeadoSchema>
export const MapeoSchema = z.array(CampoMapeadoSchema)

// Estado del paquete. Se guarda en out/<caso>/estado-paquete.json
export const EstadoPaqueteSchema = z.object({
  listo_para_firma: z.boolean(),
  motivos_bloqueo: z.array(z.string()),
  fecha_referencia: z.string(),
  archivos: z.array(z.string()),
})
export type EstadoPaquete = z.infer<typeof EstadoPaqueteSchema>
