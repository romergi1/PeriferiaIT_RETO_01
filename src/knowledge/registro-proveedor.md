# Conocimiento del proceso: registro como proveedor

## Para qué sirve
Los clientes de Periferia (Colombia, Ecuador, Perú, Panamá y Honduras) piden registrarla como proveedor. Envían un correo con un formulario (Excel, PDF o portal web) y una lista de soportes. Los datos ya existen en el repositorio maestro.

## Quién hace qué
- **Agente:** lee la solicitud, llena los campos desde el maestro, genera el formulario y arma el paquete.
- **Analista administrativa:** revisa faltantes y confirmaciones, y aprueba el envío.
- **Representante legal:** firma. Nunca interactúa con el agente.

## Estados de un campo
- **lleno:** el valor existe en el maestro (se indica la ruta, por ejemplo `maestro.banco.nombre`).
- **faltante:** la etiqueta no está en el glosario o el maestro no tiene el dato. Nunca se inventa.
- **requiere_confirmacion:** la etiqueta es ambigua o aplica una regla de país (identificador extranjero).

## Identificador tributario por país (RN1)
| País | Nombre |
|---|---|
| Colombia (CO) | NIT |
| Ecuador (EC), Perú (PE), Panamá (PA) | RUC |
| Honduras (HN) | RTN |

Periferia solo tiene NIT colombiano. Para clientes de otros países el campo se llena con el NIT y queda en `requiere_confirmacion` con la nota "identificador extranjero".

## Reglas del paquete
- **RN2:** los datos bancarios solo se llenan si la plantilla los pide. Nunca van en el borrador del correo.
- **RN3:** un soporte vencido (`vigencia_hasta` anterior a la fecha de referencia) o un soporte exigido ausente **bloquean** el estado "listo para firma". Un campo faltante **no** bloquea, pero aparece en el checklist.
- **RN4:** ninguna acción externa (envío, firma, carga a portal) sin confirmación explícita del usuario en el turno inmediatamente anterior.
- **RN5:** cada herramienta deja registro en `out/<caso>/log.jsonl`.

## Formatos de salida
- **xlsx:** se escribe cada etiqueta y su valor en la hoja y celda que indica la plantilla.
- **pdf:** documento generado con etiqueta y valor en el orden de la plantilla.
- **portal:** no soportado. Se genera `valores-portal.md` para que una persona copie los valores en el portal; las credenciales y el clic en "Enviar" son siempre humanos.

## Soportes del repositorio
Cámara de Comercio (vigencia 30 días), RUT, certificación bancaria, parafiscales, estados financieros y certificado ISO 9001. Su vigencia está en `repositorio/soportes/index.json`.
