import { test } from "node:test";
import assert from "node:assert/strict";

import { formatTokens, formatCost } from "./format.js";
import { contextBar, formatPath, groupWidth, compose, type Part } from "./index.js";
import { visibleWidth } from "@earendil-works/pi-tui";

// Theme falso: fg(token, text) devuelve el texto sin colorear, pero registra
// el token usado como prefijo "<token>" para poder afirmar sobre el color.
const theme = { fg: (token: string, text: string) => `<${token}>${text}` } as any;

// ── format.ts ────────────────────────────────────────────────────────────────

test("formatTokens: umbrales de escala", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1000), "1.0k");
  assert.equal(formatTokens(9999), "10.0k"); // redondeo a un decimal
  assert.equal(formatTokens(10_000), "10k");
  assert.equal(formatTokens(249_000), "249k");
  assert.equal(formatTokens(999_999), "1000k");
  assert.equal(formatTokens(1_000_000), "1.0M");
  assert.equal(formatTokens(9_999_999), "10.0M");
  assert.equal(formatTokens(10_000_000), "10M");
});

test("formatCost: 2 decimales por encima del umbral y para 0", () => {
  assert.equal(formatCost(0), "0.00");
  assert.equal(formatCost(0.1), "0.10");
  assert.equal(formatCost(1.234), "1.23");
  assert.equal(formatCost(0.0123), "0.0123"); // por debajo de 0.1 → 4 decimales
  assert.equal(formatCost(0.09999), "0.1000");
});

// ── contextBar ─────────────────────────────────────────────────────────────

test("contextBar: color por umbral y relleno correcto", () => {
  const bar = (pct: number) => contextBar(theme, pct);
  // El segmento lleno (con color de estado) siempre va primero, aunque esté vacío.
  assert.ok(bar(0).startsWith("<success>")); // < 70 verde
  assert.ok(bar(50).startsWith("<success>")); // < 70 verde
  assert.ok(bar(70).startsWith("<warning>")); // >= 70 ámbar
  assert.ok(bar(90).startsWith("<error>")); // >= 90 rojo
});

test("contextBar: siempre 10 celdas visibles", () => {
  for (const pct of [0, 33, 70, 100, 150]) {
    assert.equal(visibleWidth(contextBar(theme, pct).replace(/<\w+>/g, "")), 10);
  }
});

// ── formatPath ─────────────────────────────────────────────────────────────

test("formatPath: colapsa el home a ~", () => {
  const home = process.env.HOME ?? "";
  if (home) {
    assert.equal(formatPath(home + "/proyecto"), "~/proyecto");
  }
  assert.equal(formatPath("/otra/ruta"), "/otra/ruta");
});

// ── groupWidth ─────────────────────────────────────────────────────────────

test("groupWidth: suma anchos + separadores de 2 espacios", () => {
  assert.equal(groupWidth([]), 0);
  const parts: Part[] = [
    { text: "abc", side: "l", drop: 0 },
    { text: "de", side: "l", drop: 0 },
  ];
  assert.equal(groupWidth(parts), 3 + 2 + 2); // 3 + sep(2) + 2
});

// ── compose ──────────────────────────────────────────────────────────────────

test("compose: separación entre grupos cuando hay espacio de sobra", () => {
  const parts: Part[] = [
    { text: "L", side: "l", drop: 0 },
    { text: "R", side: "r", drop: 0 },
  ];
  const out = compose(40, parts);
  assert.ok(out.includes("L"));
  assert.ok(out.includes("R"));
  assert.ok(out.indexOf("L") < out.indexOf("R"));
  assert.equal(visibleWidth(out), 40 - 2); // ancho menos margen derecho
});

test("compose: elimina primero las partes con menor prioridad de drop", () => {
  const parts: Part[] = [
    { text: "MODELO", side: "l", drop: 0 },
    { text: "bajaPrioridad", side: "r", drop: 10 },
    { text: "altaPrioridad", side: "r", drop: 90 },
    { text: "COSTE", side: "r", drop: 0 },
  ];
  const out = compose(24, parts);
  assert.ok(!out.includes("bajaPrioridad")); // se elimina antes
  assert.ok(out.includes("COSTE")); // drop 0 nunca se elimina
});

test("compose: si ni el grupo derecho cabe, muestra solo ese recortado", () => {
  const parts: Part[] = [
    { text: "IZQUIERDA", side: "l", drop: 0 },
    { text: "DERECHAMUYLARGA", side: "r", drop: 0 },
  ];
  const out = compose(8, parts);
  assert.ok(!out.includes("IZQUIERDA"));
  assert.ok(visibleWidth(out) <= 8);
});
