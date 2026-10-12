// Escritura de los formularios de salida: Excel (P0), PDF (P1) y valores en Markdown (P2 portal).
import ExcelJS from "exceljs"
import { PDFDocument, StandardFonts, type PDFFont } from "pdf-lib"
import { writeFile } from "node:fs/promises"
import type { Celda } from "./esquemas"

export type Fila = { etiqueta: string; valor: string | number | null; nota: string | null }

/** Excel: escribe cada etiqueta y su valor en la hoja y celda que indica la plantilla. */
export async function escribirExcel(ruta: string, celdas: Celda[], valores: Map<string, string | number | null>): Promise<void> {
  const libro = new ExcelJS.Workbook()
  for (const celda of celdas) {
    const hoja = libro.getWorksheet(celda.hoja) ?? libro.addWorksheet(celda.hoja)
    hoja.getCell(celda.celda_etiqueta).value = celda.etiqueta
    hoja.getCell(celda.celda_valor).value = valores.get(celda.etiqueta) ?? null // faltante = celda vacía
    hoja.getColumn(celda.celda_etiqueta.replace(/\d+/g, "")).width = 35
    hoja.getColumn(celda.celda_valor.replace(/\d+/g, "")).width = 55
  }
  await libro.xlsx.writeFile(ruta)
}

/** PDF: genera un documento con etiqueta y valor en el orden de la plantilla. */
export async function escribirPdf(ruta: string, titulo: string, subtitulo: string, filas: Fila[]): Promise<void> {
  const doc = await PDFDocument.create()
  const normal = await doc.embedFont(StandardFonts.Helvetica)
  const negrita = await doc.embedFont(StandardFonts.HelveticaBold)
  let pagina = doc.addPage([595, 842]) // tamaño A4
  let y = 790

  pagina.drawText(limpiar(titulo), { x: 50, y, size: 14, font: negrita })
  pagina.drawText(limpiar(subtitulo), { x: 50, y: y - 20, size: 10, font: normal })
  y -= 55

  for (const fila of filas) {
    const lineas = partirTexto(fila.valor === null ? "" : String(fila.valor), normal, 10, 310)
    if (y - lineas.length * 14 < 50) {
      pagina = doc.addPage([595, 842])
      y = 790
    }
    pagina.drawText(limpiar(fila.etiqueta), { x: 50, y, size: 10, font: negrita })
    lineas.forEach((linea, i) => pagina.drawText(linea, { x: 235, y: y - i * 14, size: 10, font: normal }))
    y -= Math.max(1, lineas.length) * 14 + 10
  }
  await writeFile(ruta, await doc.save())
}

/** Portal web (no soportado): tabla en Markdown con los valores listos para copiar. */
export async function escribirValoresMd(ruta: string, titulo: string, aviso: string, filas: Fila[]): Promise<void> {
  const tabla = filas.map((f) => `| ${f.etiqueta} | ${f.valor ?? "(faltante)"} | ${f.nota ?? ""} |`).join("\n")
  await writeFile(ruta, `# ${titulo}\n\n> ${aviso}\n\n| Campo | Valor | Nota |\n|---|---|---|\n${tabla}\n`)
}

// Las fuentes estándar del PDF solo admiten caracteres latinos básicos (incluye tildes y ñ).
const limpiar = (texto: string) => texto.replace(/[^\x20-\x7E -ÿ]/g, "-")

/** Parte un texto en líneas que quepan en el ancho indicado. */
function partirTexto(texto: string, fuente: PDFFont, tamano: number, ancho: number): string[] {
  const lineas: string[] = []
  let actual = ""
  for (const palabra of limpiar(texto).split(" ")) {
    const prueba = actual ? `${actual} ${palabra}` : palabra
    if (fuente.widthOfTextAtSize(prueba, tamano) > ancho && actual) {
      lineas.push(actual)
      actual = palabra
    } else {
      actual = prueba
    }
  }
  lineas.push(actual)
  return lineas
}
