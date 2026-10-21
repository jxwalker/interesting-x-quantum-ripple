/** Procedural canvas textures: walnut desk, brushed brass with engraved ticks, brushed aluminium, glow sprites. */
import { mulberry32 } from "./engine";

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

/** Value noise (smooth), deterministic. */
function noise1(seed: number): (x: number) => number {
  const r = mulberry32(seed);
  const t = Float32Array.from({ length: 512 }, () => r());
  return (x: number) => {
    const i = Math.floor(x), f = x - i;
    const a = t[i & 511], b = t[(i + 1) & 511];
    const u = f * f * (3 - 2 * f);
    return a + (b - a) * u;
  };
}

/** Dark polished black-walnut: colour + roughness (grain runs along x). */
export function walnut(size = 1024): { color: HTMLCanvasElement; rough: HTMLCanvasElement } {
  const W = size, H = size / 2;
  const [c, g] = canvas(W, H);
  const [r, rg] = canvas(W, H);
  const img = g.createImageData(W, H);
  const rim = rg.createImageData(W, H);
  const n1 = noise1(11), n2 = noise1(23), n3 = noise1(37), n4 = noise1(51);
  const rnd = mulberry32(5);
  const pores = new Float32Array(W * H);
  for (let k = 0; k < W * H * 0.012; k++) {
    const x = Math.floor(rnd() * W), y = Math.floor(rnd() * H);
    const len = 3 + Math.floor(rnd() * 14);
    for (let d = 0; d < len; d++) pores[y * W + ((x + d) % W)] = 0.5 + 0.5 * rnd();
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // wavy growth rings: warp y by slow noise along x
      const u = x / W, v = y / H;
      const warp = (n1(u * 6 + v * 2) - 0.5) * 34 + (n2(u * 17 + 40) - 0.5) * 9 + Math.sin(u * 6.283 * 2 + v * 3) * 6;
      const yy = y + warp;
      const ring = 0.5 + 0.5 * Math.sin(yy * 0.19 + n3(yy * 0.05) * 7);
      const fine = n4(yy * 0.9 + x * 0.004);
      const figure = n2(u * 3 + yy * 0.012);
      let t = 0.28 + 0.38 * Math.pow(ring, 3) + 0.22 * fine + 0.18 * figure;
      t -= pores[y * W + x] * 0.25;
      t = Math.max(0, Math.min(1, t));
      // dark chocolate → warm mid-brown
      const R = 18 + t * 62, G = 10 + t * 33, B = 6 + t * 18;
      const o = (y * W + x) * 4;
      img.data[o] = R;
      img.data[o + 1] = G;
      img.data[o + 2] = B;
      img.data[o + 3] = 255;
      const ro = 70 + (1 - t) * 50 + pores[y * W + x] * 80;
      rim.data[o] = rim.data[o + 1] = rim.data[o + 2] = ro;
      rim.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  rg.putImageData(rim, 0, 0);
  return { color: c, rough: r };
}

/** Brushed brass with engraved ruler ticks along the length (u) and small numerals. */
export function brassRuler(len = 2048, h = 64, ticks = 64): HTMLCanvasElement {
  const [c, g] = canvas(len, h);
  const grd = g.createLinearGradient(0, 0, 0, h);
  grd.addColorStop(0, "#c9a24f");
  grd.addColorStop(0.5, "#e3c27a");
  grd.addColorStop(1, "#b38a3b");
  g.fillStyle = grd;
  g.fillRect(0, 0, len, h);
  const rnd = mulberry32(3);
  // brushing streaks along the length
  for (let k = 0; k < 1400; k++) {
    const y = rnd() * h;
    g.strokeStyle = rnd() < 0.5 ? `rgba(255,236,190,${0.04 + rnd() * 0.08})` : `rgba(90,60,20,${0.04 + rnd() * 0.08})`;
    g.lineWidth = 0.6 + rnd() * 0.8;
    g.beginPath();
    const x = rnd() * len;
    g.moveTo(x, y);
    g.lineTo(x + 80 + rnd() * 500, y + (rnd() - 0.5));
    g.stroke();
  }
  // engraved ticks (dark groove + bright lower lip)
  for (let i = 0; i <= ticks * 5; i++) {
    const x = (i / (ticks * 5)) * len;
    const major = i % 5 === 0;
    const th = major ? h * 0.42 : h * 0.22;
    g.fillStyle = "rgba(60,38,10,0.75)";
    g.fillRect(x, 0, major ? 2 : 1.3, th);
    g.fillStyle = "rgba(255,240,200,0.35)";
    g.fillRect(x + (major ? 2 : 1.3), 0, 1, th);
    if (major && i % 10 === 0 && i > 0 && i < ticks * 5) {
      g.fillStyle = "rgba(70,45,12,0.7)";
      g.font = `600 ${Math.round(h * 0.26)}px ui-monospace, Menlo, monospace`;
      g.fillText(String(i / 10), x + 4, h * 0.78);
    }
  }
  return c;
}

/** Fine anisotropic brushing (grey), for metal roughness/colour modulation. */
export function brushed(w = 512, h = 128, base = 200): HTMLCanvasElement {
  const [c, g] = canvas(w, h);
  g.fillStyle = `rgb(${base},${base},${base})`;
  g.fillRect(0, 0, w, h);
  const rnd = mulberry32(9);
  for (let k = 0; k < 2400; k++) {
    const y = rnd() * h;
    const v = base + (rnd() - 0.5) * 70;
    g.strokeStyle = `rgba(${v},${v},${v},0.35)`;
    g.lineWidth = 0.5 + rnd();
    const x = rnd() * w;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + 40 + rnd() * 260, y);
    g.stroke();
  }
  return c;
}

/** Soft radial glow sprite. */
export function glow(size = 128, falloff = 2.2): HTMLCanvasElement {
  const [c, g] = canvas(size, size);
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size * 2 - 1, dy = (y + 0.5) / size * 2 - 1;
      const r = Math.min(1, Math.hypot(dx, dy));
      const a = Math.pow(1 - r, falloff) * 0.85 + Math.exp(-r * r * 60) * 0.6;
      const o = (y * size + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = 255;
      img.data[o + 3] = Math.min(255, a * 255);
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** Soft rounded softbox shape for out-of-focus studio bokeh in the background. */
export function softbox(w = 256, h = 128): HTMLCanvasElement {
  const [c, g] = canvas(w, h);
  g.filter = "blur(18px)";
  g.fillStyle = "#fff";
  const m = 34;
  g.beginPath();
  g.roundRect(m, m, w - 2 * m, h - 2 * m, 18);
  g.fill();
  g.filter = "none";
  return c;
}
