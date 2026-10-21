/**
 * Canvas2D fallback: a top-down view of the same simulation. Phase-coloured
 * density image (ImageData), brass frame + barrier, electron gun, frosted
 * detector strip with dots, theory rays, tap ripples.
 */
import { DX, LX, LY, NX, NY, X_DET, X_GUN, Y_MID, barrierSpan, slitsOf } from "./engine";
import { HIST_BINS, type Sim } from "./sim";
import { PALETTE, phaseColor, type Layout, type View } from "./view";
import { walnut } from "./textures";

export class Scene2D implements View {
  readonly kind = "2d" as const;
  readonly canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private sim: Sim;
  private w = 1;
  private h = 1;
  private dpr = 1;
  private layout: Layout = { x: 0, y: 0, w: 800, h: 450, portrait: false };
  private img: ImageData;
  private off: HTMLCanvasElement;
  private offG: CanvasRenderingContext2D;
  private wood: CanvasPattern | null = null;
  private rect = { x: 0, y: 0, w: 1, h: 1 };
  private time = 0;
  private rgb: [number, number, number] = [0, 0, 0];

  constructor(container: HTMLElement, sim: Sim) {
    this.sim = sim;
    const c = document.createElement("canvas");
    c.id = "canvas";
    c.setAttribute("aria-label", "Ripple tank seen from above: tap the water to drop an electron, drag the brass barrier to move it");
    container.appendChild(c);
    this.canvas = c;
    this.g = c.getContext("2d")!;
    this.off = document.createElement("canvas");
    this.off.width = NX;
    this.off.height = NY;
    this.offG = this.off.getContext("2d")!;
    this.img = this.offG.createImageData(NX, NY);
    try {
      this.wood = this.g.createPattern(walnut(512).color, "repeat");
    } catch {
      this.wood = null;
    }
  }

  resize(w: number, h: number, layout: Layout): void {
    this.w = w;
    this.h = h;
    this.layout = layout;
    this.dpr = Math.min(2, devicePixelRatio || 1);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
  }

  rebuild(): void {}
  poke(): void {}
  orbit(): void {}
  zoom(): void {}

  /** Tank rectangle on screen (interior), keeping the 1.6 : 1 aspect inside the layout box. */
  private fit(): void {
    const L = this.layout;
    const pad = 26;
    const aw = Math.max(40, L.w - 2 * pad), ah = Math.max(40, L.h - 2 * pad);
    const asp = L.portrait ? LY / LX : LX / LY;
    let w = aw, h = aw / asp;
    if (h > ah) {
      h = ah;
      w = ah * asp;
    }
    this.rect = { x: L.x + (L.w - w) / 2, y: L.y + (L.h - h) / 2, w, h };
  }

  /** Simulation → screen. */
  private P(x: number, y: number): [number, number] {
    const r = this.rect;
    if (this.layout.portrait) return [r.x + (y / LY) * r.w, r.y + r.h - (x / LX) * r.h];
    return [r.x + (x / LX) * r.w, r.y + (y / LY) * r.h];
  }

  /** Screen → simulation. */
  private S(px: number, py: number): { x: number; y: number } {
    const r = this.rect;
    if (this.layout.portrait) return { x: ((r.y + r.h - py) / r.h) * LX, y: ((px - r.x) / r.w) * LY };
    return { x: ((px - r.x) / r.w) * LX, y: ((py - r.y) / r.h) * LY };
  }

  /** Axis-aligned screen rect for a simulation-space rect. */
  private R(x0: number, y0: number, x1: number, y1: number): [number, number, number, number] {
    const [ax, ay] = this.P(x0, y0), [bx, by] = this.P(x1, y1);
    return [Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay)];
  }

  pickWater(clientX: number, clientY: number): { x: number; y: number } | null {
    const b = this.canvas.getBoundingClientRect();
    const p = this.S(clientX - b.left, clientY - b.top);
    if (p.x < 0 || p.x > LX || p.y < 0 || p.y > LY) return null;
    return p;
  }

  project(x: number, y: number): { x: number; y: number } {
    const b = this.canvas.getBoundingClientRect();
    const [px, py] = this.P(x, y);
    return { x: b.left + px, y: b.top + py };
  }

  pickBarrier(clientX: number, clientY: number): boolean {
    const p = this.pickWater(clientX, clientY);
    return !!p && !!barrierSpan(this.sim.geom) && Math.abs(p.x - this.sim.geom.barrierX) < 7;
  }

  private brassGrad(x: number, y: number, w: number, h: number): CanvasGradient {
    const g = this.g.createLinearGradient(x, y, x + w * 0.4, y + h);
    g.addColorStop(0, "#f2d58e");
    g.addColorStop(0.45, "#c99a45");
    g.addColorStop(1, "#7d5a22");
    return g;
  }

  render(dt: number): void {
    this.time += dt;
    const g = this.g, sim = this.sim;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.fit();
    const r = this.rect;
    // desk
    g.fillStyle = "#120b07";
    g.fillRect(0, 0, this.w, this.h);
    if (this.wood) {
      g.globalAlpha = 0.85;
      g.fillStyle = this.wood;
      g.fillRect(0, 0, this.w, this.h);
      g.globalAlpha = 1;
    }
    const vg = g.createRadialGradient(r.x + r.w / 2, r.y + r.h / 2, Math.min(r.w, r.h) * 0.3, r.x + r.w / 2, r.y + r.h / 2, Math.max(this.w, this.h) * 0.75);
    vg.addColorStop(0, "rgba(0,0,0,0.1)");
    vg.addColorStop(1, "rgba(0,0,0,0.82)");
    g.fillStyle = vg;
    g.fillRect(0, 0, this.w, this.h);

    // tank shadow + brass frame
    const fw = Math.max(7, r.w * 0.018);
    g.save();
    g.shadowColor = "rgba(0,0,0,0.7)";
    g.shadowBlur = 30;
    g.shadowOffsetY = 10;
    g.fillStyle = this.brassGrad(r.x - fw, r.y - fw, r.w + 2 * fw, r.h + 2 * fw);
    g.fillRect(r.x - fw, r.y - fw, r.w + 2 * fw, r.h + 2 * fw);
    g.restore();
    // engraved ticks
    g.strokeStyle = "rgba(70,44,12,0.65)";
    g.lineWidth = 1;
    const ticks = 40;
    for (let k = 0; k <= ticks; k++) {
      const t = k / ticks, len = k % 5 === 0 ? fw * 0.7 : fw * 0.4;
      g.beginPath();
      g.moveTo(r.x + t * r.w, r.y - fw);
      g.lineTo(r.x + t * r.w, r.y - fw + len);
      g.moveTo(r.x + t * r.w, r.y + r.h + fw);
      g.lineTo(r.x + t * r.w, r.y + r.h + fw - len);
      g.stroke();
    }
    // bolts
    g.fillStyle = "#8a6326";
    for (const [bx, by] of [[r.x - fw / 2, r.y - fw / 2], [r.x + r.w + fw / 2, r.y - fw / 2], [r.x - fw / 2, r.y + r.h + fw / 2], [r.x + r.w + fw / 2, r.y + r.h + fw / 2]]) {
      g.beginPath();
      g.arc(bx, by, fw * 0.32, 0, Math.PI * 2);
      g.fill();
    }

    // wave image
    this.paintField();
    g.save();
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    if (this.layout.portrait) {
      g.translate(r.x, r.y + r.h);
      g.rotate(-Math.PI / 2);
      g.drawImage(this.off, 0, 0, r.h, r.w);
    } else g.drawImage(this.off, r.x, r.y, r.w, r.h);
    g.restore();
    // glassy sheen
    const sh = g.createLinearGradient(r.x, r.y, r.x + r.w, r.y + r.h);
    sh.addColorStop(0, "rgba(255,255,255,0.07)");
    sh.addColorStop(0.4, "rgba(255,255,255,0)");
    sh.addColorStop(1, "rgba(255,255,255,0.03)");
    g.fillStyle = sh;
    g.fillRect(r.x, r.y, r.w, r.h);

    // theory rays
    if (sim.theory && (sim.mode === "double" || sim.mode === "single")) {
      g.save();
      g.beginPath();
      g.rect(r.x, r.y, r.w, r.h);
      g.clip();
      g.strokeStyle = "rgba(255,207,77,0.8)";
      g.lineWidth = 1.2;
      for (const { sin, bright } of sim.theoryAngles()) {
        g.setLineDash(bright ? [] : [5, 5]);
        const tan = sin / Math.sqrt(1 - sin * sin);
        const x0 = sim.farEdge, x1 = X_DET + 4;
        const [ax, ay] = this.P(x0, Y_MID), [bx, by] = this.P(x1, Y_MID + (x1 - x0) * tan);
        g.beginPath();
        g.moveTo(ax, ay);
        g.lineTo(bx, by);
        g.stroke();
      }
      g.restore();
    }

    // barrier
    const span = barrierSpan(sim.geom);
    if (span) {
      const segs: [number, number][] = [];
      let y0 = 0;
      for (const [a, b] of slitsOf(sim.geom)) {
        segs.push([y0, a]);
        y0 = b;
      }
      segs.push([y0, LY]);
      const pad = sim.mode === "tunnel" ? 0.8 : 0;
      for (const [a, b] of segs) {
        const [x, y, w, h] = this.R(span[0] - pad, a, span[1] + pad, b);
        g.fillStyle = sim.mode === "tunnel" ? `rgba(230,180,90,${0.45 + 0.4 * Math.min(1, sim.geom.wallHeight)})` : this.brassGrad(x, y, w, h);
        g.fillRect(x, y, w, h);
        g.strokeStyle = "rgba(60,38,10,0.6)";
        g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      }
    }

    // detector strip + histogram + dots
    {
      const [x, y, w, h] = this.R(X_DET, 0, LX, LY);
      g.fillStyle = "rgba(210,230,245,0.16)";
      g.fillRect(x, y, w, h);
      g.strokeStyle = "rgba(220,240,255,0.35)";
      g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
      let mx = 1;
      for (const v of sim.hist) mx = Math.max(mx, v);
      g.fillStyle = "rgba(122,240,255,0.32)";
      for (let b = 0; b < HIST_BINS; b++) {
        const v = sim.hist[b] / mx;
        if (v <= 0) continue;
        const yA = (b / HIST_BINS) * LY, yB = ((b + 1) / HIST_BINS) * LY;
        const [hx, hy, hw, hh] = this.R(LX - v * (LX - X_DET), yA, LX, yB);
        g.fillRect(hx, hy, hw, hh);
      }
      g.globalCompositeOperation = "lighter";
      const now = sim.clock;
      for (const d of sim.dots) {
        const fresh = Math.max(0, 1 - (now - d.t) / 0.6);
        const [px, py] = this.P(X_DET + 2 + d.v * (LX - X_DET - 4), d.y);
        const p = PALETTE[Math.floor(d.hue * 4) % 4];
        g.fillStyle = `rgba(${Math.round(140 + p[0] * 115)},${Math.round(140 + p[1] * 115)},${Math.round(140 + p[2] * 115)},${0.75 + 0.25 * fresh})`;
        g.beginPath();
        g.arc(px, py, 1.6 + 4 * fresh, 0, Math.PI * 2);
        g.fill();
      }
      g.globalCompositeOperation = "source-over";
    }

    // electron gun
    {
      const [gx0, gy0] = this.P(X_GUN - 2, Y_MID);
      const portrait = this.layout.portrait;
      const kick = Math.max(0, 1 - (sim.clock - sim.lastFire) / 0.45);
      const len = Math.min(r.w, r.h) * 0.28, rad = len * 0.16;
      g.save();
      g.translate(gx0, gy0);
      if (portrait) g.rotate(-Math.PI / 2);
      g.translate(-len - kick * 6, 0);
      const al = g.createLinearGradient(0, -rad, 0, rad);
      al.addColorStop(0, "#f4f6f8");
      al.addColorStop(0.5, "#9ea6b0");
      al.addColorStop(1, "#596069");
      g.fillStyle = al;
      g.beginPath();
      g.roundRect(0, -rad, len, rad * 2, rad * 0.6);
      g.fill();
      g.fillStyle = this.brassGrad(len * 0.55, -rad * 1.15, len * 0.1, rad * 2.3);
      g.fillRect(len * 0.55, -rad * 1.15, len * 0.1, rad * 2.3);
      const glow = g.createRadialGradient(len, 0, 0, len, 0, rad * (2.6 + kick * 3));
      glow.addColorStop(0, `rgba(190,250,255,${0.9})`);
      glow.addColorStop(0.3, `rgba(122,240,255,${0.5 + 0.4 * kick})`);
      glow.addColorStop(1, "rgba(122,240,255,0)");
      g.globalCompositeOperation = "lighter";
      g.fillStyle = glow;
      g.beginPath();
      g.arc(len, 0, rad * (2.6 + kick * 3), 0, Math.PI * 2);
      g.fill();
      g.restore();
    }

    // taps + measurement flash
    const now = sim.clock;
    for (const t of sim.taps) {
      const age = now - t.t;
      if (age > 1.1) continue;
      const [px, py] = this.P(t.x, t.y);
      g.strokeStyle = `rgba(122,240,255,${(1 - age / 1.1) ** 2})`;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(px, py, 4 + age * 60, 0, Math.PI * 2);
      g.stroke();
    }
    const m = sim.lastMeasure;
    if (m && now - m.t < 1.4) {
      const a = 1 - (now - m.t) / 1.4;
      const [px, py] = this.P(m.x, m.y);
      const fg = g.createRadialGradient(px, py, 0, px, py, 30 * a + 6);
      fg.addColorStop(0, `rgba(255,220,120,${a})`);
      fg.addColorStop(1, "rgba(255,207,77,0)");
      g.fillStyle = fg;
      g.beginPath();
      g.arc(px, py, 30 * a + 6, 0, Math.PI * 2);
      g.fill();
    }
  }

  /** Phase hue × density brightness into the 256×128 ImageData. */
  private paintField(): void {
    const sim = this.sim, s = sim.solver, re = s.re, im = s.im, V = s.V;
    const open = sim.mode === "open";
    const gN = Math.max(1e-9, open ? Math.max(sim.gainNear, sim.gainFar) : sim.gainNear);
    const gF = Math.max(1e-9, open ? gN : Math.max(sim.gainFar, sim.gainNear / 9));
    const xf = sim.farEdge;
    const d = this.img.data, rgb = this.rgb;
    const phaseOn = sim.showPhase;
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        const o = j * NX + i;
        const x = (i + 0.5) * DX;
        const u = Math.min(1, Math.max(0, (x - (xf - 1)) / 8));
        const gain = gN + (gF - gN) * u * u * (3 - 2 * u);
        const rho = (re[o] * re[o] + im[o] * im[o]) / gain;
        const b = Math.min(1.4, Math.pow(rho, 0.72));
        if (phaseOn) phaseColor(Math.atan2(im[o], re[o]), rgb);
        else rgb[0] = 0.55, rgb[1] = 0.88, rgb[2] = 1;
        const q = o * 4;
        const base = 6 + 10 * (V[o] > 0 ? 1 : 0);
        d[q] = Math.min(255, base + rgb[0] * b * 255 + b * b * 50);
        d[q + 1] = Math.min(255, base + 3 + rgb[1] * b * 255 + b * b * 50);
        d[q + 2] = Math.min(255, base + 8 + rgb[2] * b * 255 + b * b * 50);
        d[q + 3] = 255;
      }
    }
    this.offG.putImageData(this.img, 0, 0);
  }

  dispose(): void {
    this.canvas.remove();
  }
}
