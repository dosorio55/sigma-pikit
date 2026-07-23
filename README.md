# sigma

Σ — mi colección de plugins para el agente [pi](https://github.com/earendil-works).
La suma de mis piezas, separadas para poder instalar y cambiar solo lo que quiera.

## Extensiones

| Extensión | Qué hace |
|-----------|----------|
| `footer`  | Footer de dos líneas: ruta del proyecto, modelo, rama, barra de contexto, tokens, thinking y coste. |

## Cómo funciona

`package.json` declara dónde están las extensiones:

```json
"pi": { "extensions": ["./agent/extensions/*/index.ts"] }
```

pi carga la función exportada por defecto en cada `index.ts`. Cada extensión se
suscribe a eventos (`pi.on(...)`) y/o registra UI (`ctx.ui.setFooter(...)`).

## Instalar / probar en local

Probar una extensión suelta sin instalar nada:

```bash
pi -ne -e ./agent/extensions/footer/index.ts
```

Instalarla de forma permanente desde git (cuando esté publicada):

```bash
pi install git:github.com/tu-usuario/sigma
```

## Desarrollo y tests

El proyecto usa **pnpm** (obligatorio: un `preinstall` bloquea npm/yarn).

```bash
pnpm install     # instala dependencias
pnpm check       # tipos: tsc --noEmit
pnpm test        # tests
```

Los tests corren con el runner nativo de Node (`node:test`) a través de
[`tsx`](https://tsx.is), que ejecuta TypeScript directamente (resuelve los
imports `.js` → `.ts`, cosa que Node por sí solo no hace). El script es:

```json
"test": "node --import tsx --test 'agent/extensions/**/*.test.ts'"
```

Los tests viven junto a cada extensión como `*.test.ts` (p. ej.
`agent/extensions/footer/footer.test.ts`). Se centran en la lógica pura y fácil
de romper —formateo de tokens/coste, umbrales de la barra de contexto y el
armado del footer (`compose`)— y no en el cableado con el runtime de pi.

Para añadir tests a otra extensión, crea un `*.test.ts` en su carpeta; el glob
del script los recoge automáticamente. Exporta desde el `index.ts` solo los
helpers puros que quieras probar.

