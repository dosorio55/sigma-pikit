# sigma

Σ — mi colección de plugins para el agente [pi](https://github.com/earendil-works).
La suma de mis piezas, separadas para poder instalar y cambiar solo lo que quiera.

## Extensiones

| Extensión | Qué hace |
|-----------|----------|
| `hello`   | El "hola mundo": dibuja un footer de una línea. Base para aprender. |
| `footer`  | Footer de dos líneas: ruta del proyecto, modelo, rama, barra de contexto, tokens, thinking y coste. |
| `wsl-clipboard-image` | Pega imágenes del portapapeles de Windows en el prompt con `Alt+V` (o el comando `wsl-paste-image`). Lee el portapapeles nativo vía `powershell.exe` y prueba varios formatos (PNG, fichero, bitmap), así que también funciona con el historial `Win+V`. Solo WSL. |

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
pi install git:github.com/dosorio55/sigma-pikit
```
