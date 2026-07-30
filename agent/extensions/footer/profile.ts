import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Mismo patrón que usa `profiles` para validar nombres. */
const VALID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Nombre del perfil activo, o `null` si la extensión `profiles` no está en uso.
 *
 * Lee el fichero en vez de importar de `../profiles/`: las extensiones se
 * instalan por separado a propósito, y el footer tiene que seguir funcionando
 * sin `profiles` delante. El precio es duplicar una ruta de tres segmentos; el
 * de importar sería arrastrar `profiles` entero cada vez que se carga el footer.
 *
 * Tampoco vale una variable compartida: pi reconstruye la extensión en cada
 * runtime, así que el estado de módulo se pierde en cada `/reload`, `/new`,
 * `/resume` y `/fork` — justo cuando el perfil puede haber cambiado. El fichero
 * es lo único que sobrevive.
 */
export function activeProfile(): string | null {
  try {
    const name = readFileSync(join(getAgentDir(), "profiles", "active"), "utf8").trim();
    // `active` se edita a mano y lo que salga de aquí va directo a una línea de
    // terminal: se valida para que nadie cuele secuencias de escape en el footer.
    return VALID.test(name) ? name : null;
  } catch {
    return null; // no existe: profiles no se usa
  }
}
