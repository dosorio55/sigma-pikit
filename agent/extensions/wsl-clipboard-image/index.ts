import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

// ─────────────────────────────────────────────────────────────────────────────
// wsl-clipboard-image — pega imágenes del portapapeles de Windows en el prompt.
//
// Lee el portapapeles NATIVO de Windows vía powershell.exe (más fiable que el
// puente wl-paste de WSLg). Con Alt+V inserta un marcador "[Image #n]" y, al
// enviar el mensaje, lo sustituye por la ruta real del PNG temporal.
//
// Clave: probamos VARIOS formatos del portapapeles, en orden. Así funciona
// también al elegir una imagen del historial (Win+V), que a menudo llega como
// stream PNG o como fichero copiado, no como bitmap DIB:
//   1. Formato "PNG"      → navegadores y muchas apps (sin pérdida, con alfa).
//   2. Lista de ficheros  → imagen copiada desde el Explorador (CF_HDROP).
//   3. Bitmap / DIB       → Recortes, capturas de pantalla.
// ─────────────────────────────────────────────────────────────────────────────

function isWsl(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.WSL_DISTRO_NAME || env.WSLENV) return true;
  try {
    const version = spawnSync("sh", ["-lc", "cat /proc/version"], {
      encoding: "utf8",
      timeout: 1000,
    });
    return /microsoft|wsl/i.test(version.stdout ?? "");
  } catch {
    return false;
  }
}

// PowerShell: devuelve el PNG en base64 por stdout, o sale con código 2 si no
// hay ninguna imagen reconocible. Prueba PNG → ficheros → bitmap.
const CLIPBOARD_PS = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "$cb = [System.Windows.Forms.Clipboard]",
  "function Emit($ms) { [Convert]::ToBase64String($ms.ToArray()); exit 0 }",
  // 1) Stream PNG nativo (navegadores, apps modernas): sin pérdida, conserva alfa.
  "if ($cb::ContainsData('PNG')) {",
  "  $d = $cb::GetData('PNG')",
  "  if ($d -is [System.IO.MemoryStream]) { Emit $d }",
  "}",
  // 2) Imagen copiada como fichero desde el Explorador (CF_HDROP).
  "if ($cb::ContainsFileDropList()) {",
  "  foreach ($f in $cb::GetFileDropList()) {",
  "    $ext = [System.IO.Path]::GetExtension($f).ToLower()",
  "    if (@('.png','.jpg','.jpeg','.gif','.bmp','.webp','.tif','.tiff') -contains $ext) {",
  "      $img = [System.Drawing.Image]::FromFile($f)",
  "      $ms = New-Object System.IO.MemoryStream",
  "      $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)",
  "      Emit $ms",
  "    }",
  "  }",
  "}",
  // 3) Bitmap / DIB (Recortes, capturas de pantalla).
  "$img = $cb::GetImage()",
  "if ($img) {",
  "  $ms = New-Object System.IO.MemoryStream",
  "  $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)",
  "  Emit $ms",
  "}",
  "exit 2",
].join("; ");

function readWindowsClipboardImagePng(): Buffer | null {
  try {
    const result = spawnSync(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-Command", CLIPBOARD_PS],
      { encoding: "utf8", timeout: 10000, maxBuffer: 64 * 1024 * 1024 },
    );
    if (result.status !== 0) return null;
    const base64 = (result.stdout ?? "").trim();
    if (!base64) return null;
    return Buffer.from(base64, "base64");
  } catch {
    return null;
  }
}

function writeTempImage(bytes: Buffer): string {
  const filePath = join(tmpdir(), `pi-wsl-clipboard-${randomUUID()}.png`);
  writeFileSync(filePath, bytes);
  return filePath;
}

function replaceImagePlaceholders(text: string, placeholders: Map<string, string>): string {
  let next = text;
  for (const [placeholder, filePath] of placeholders) {
    next = next.split(placeholder).join(filePath);
  }
  return next;
}

async function pasteWindowsClipboardImage(
  ctx: ExtensionContext | ExtensionCommandContext,
  placeholders: Map<string, string>,
  nextImageNumber: { value: number },
  options?: { notifyOnEmpty?: boolean; notifyOnSuccess?: boolean },
): Promise<boolean> {
  if (!isWsl()) return false;

  const bytes = readWindowsClipboardImagePng();
  if (!bytes || bytes.length === 0) {
    if (options?.notifyOnEmpty) {
      ctx.ui.notify("No hay imagen en el portapapeles de Windows", "warning");
    }
    return false;
  }

  const filePath = writeTempImage(bytes);
  const placeholder = `[Image #${nextImageNumber.value++}]`;
  placeholders.set(placeholder, filePath);
  ctx.ui.pasteToEditor(placeholder);

  if (options?.notifyOnSuccess) {
    ctx.ui.notify(`Pegado ${placeholder}`, "info");
  }
  return true;
}

// Editor que intercepta Alt+V para disparar el pegado antes que el editor base.
class WslClipboardEditor extends CustomEditor {
  private readonly keys: ConstructorParameters<typeof CustomEditor>[2];

  constructor(
    tui: ConstructorParameters<typeof CustomEditor>[0],
    theme: ConstructorParameters<typeof CustomEditor>[1],
    keybindings: ConstructorParameters<typeof CustomEditor>[2],
    private readonly onPasteWindowsClipboardImage: () => Promise<void> | void,
  ) {
    super(tui, theme, keybindings);
    this.keys = keybindings;
  }

  handleInput(data: string): void {
    if (this.keys.matches(data, "app.clipboard.pasteImage") || matchesKey(data, "alt+v")) {
      void Promise.resolve(this.onPasteWindowsClipboardImage());
      return;
    }
    super.handleInput(data);
  }
}

export default function wslClipboardImage(pi: ExtensionAPI) {
  if (!isWsl()) return;

  const placeholders = new Map<string, string>();
  const nextImageNumber = { value: 1 };

  pi.registerCommand("wsl-paste-image", {
    description: "Pegar una imagen del portapapeles de Windows en el editor",
    handler: async (_args, ctx) => {
      await pasteWindowsClipboardImage(ctx, placeholders, nextImageNumber, {
        notifyOnEmpty: true,
        notifyOnSuccess: true,
      });
    },
  });

  // Al enviar, sustituye los "[Image #n]" por las rutas reales y reinicia la
  // numeración para el siguiente mensaje.
  pi.on("input", async (event) => {
    const transformed = replaceImagePlaceholders(event.text, placeholders);
    if (placeholders.size > 0) {
      placeholders.clear();
      nextImageNumber.value = 1;
    }
    if (transformed === event.text) return { action: "continue" };
    return { action: "transform", text: transformed };
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, keybindings) =>
      new WslClipboardEditor(tui, theme, keybindings, async () => {
        await pasteWindowsClipboardImage(ctx, placeholders, nextImageNumber, { notifyOnEmpty: true });
      }),
    );
  });
}
