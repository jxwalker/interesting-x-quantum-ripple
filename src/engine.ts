/**
 * 2D time-dependent Schrödinger equation, i ∂ψ/∂t = −½∇²ψ + Vψ (ħ = m = 1),
 * solved with the split-step (split-operator) Fourier method on a periodic
 * NX × NY grid:
 *
 *   ψ ← e^{−iV dt/2} · F⁻¹[ e^{−i k² dt/2} · F[ e^{−iV dt/2} ψ ] ]
 *
 * Edges get a complex absorbing potential (V − iW) so waves leaving the tank
 * are eaten instead of wrapping around. Everything here is DOM-free so the
 * self-test can run headless.
 */

export const NX = 256;
export const NY = 128;
export const DX = 1;
/** Cells are slightly taller than wide so the tank is 1.6 : 1 with a power-of-two grid. */
export const DY = 1.25;
export const LX = NX * DX;
export const LY = NY * DY;
export const DA = DX * DY;
export const DT = 0.5;
export const TAU = Math.PI * 2;

/** Absorbing layer widths (cells). The right one doubles as the detector screen. */
export const ABS_L = 14;
export const ABS_R = 20;
export const ABS_Y = 13;
/** x where the detector screen begins (start of the right absorber). */
export const X_DET = LX - ABS_R * DX;
/** Hard-wall height for the brass barrier: far above any electron energy here. */
export const V_HARD = 6;
/** Emitter (electron gun) position. */
export const X_GUN = 42;
export const Y_MID = LY / 2;

export type Mode = "double" | "single" | "tunnel" | "open";

export interface Geometry {
  mode: Mode;
  /** Barrier / wall centre (x units). */
  barrierX: number;
  /** Centre-to-centre slit separation d (y units). */
  slitSep: number;
  /** Slit width a in double mode (y units). */
  slitWidth: number;
  /** Slit width in single mode (y units). */
  singleWidth: number;
  /** Brass barrier thickness (x units). */
  barrierThick: number;
  /** Tunnel wall thickness (x units) and height V₀. */
  wallThick: number;
  wallHeight: number;
  /** Edge absorber on/off (off only for the norm test). */
  absorb: boolean;
}

export function defaultGeometry(): Geometry {
  return {
    mode: "double",
    barrierX: 100,
    slitSep: 30,
    slitWidth: 6,
    singleWidth: 16,
    barrierThick: 4,
    wallThick: 2,
    wallHeight: 0.6,
    absorb: true,
  };
}

/** Length of overlap between [a0,a1] and [b0,b1]. */
function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}

/** Slit openings [y0, y1] for the current mode. */
export function slitsOf(g: Geometry): [number, number][] {
  if (g.mode === "double") {
    const h = g.slitWidth / 2;
    return [
      [Y_MID - g.slitSep / 2 - h, Y_MID - g.slitSep / 2 + h],
      [Y_MID + g.slitSep / 2 - h, Y_MID + g.slitSep / 2 + h],
    ];
  }
  if (g.mode === "single") return [[Y_MID - g.singleWidth / 2, Y_MID + g.singleWidth / 2]];
  return [];
}

/** Barrier x-extent [x0, x1] (or null in open water). */
export function barrierSpan(g: Geometry): [number, number] | null {
  if (g.mode === "open") return null;
  const t = g.mode === "tunnel" ? g.wallThick : g.barrierThick;
  return [g.barrierX - t / 2, g.barrierX + t / 2];
}

// ───────────────────────── FFT ─────────────────────────

function bitReverse(n: number): Uint32Array {
  const bits = Math.log2(n), r = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let x = 0;
    for (let b = 0; b < bits; b++) x |= ((i >> b) & 1) << (bits - 1 - b);
    r[i] = x;
  }
  return r;
}

/** Twiddles e^{2πik/size} for every radix-2 stage, concatenated (size = 2, 4, …, n). */
function twiddles(n: number): [Float64Array, Float64Array] {
  const c: number[] = [], s: number[] = [];
  for (let size = 2; size <= n; size <<= 1) {
    for (let k = 0; k < size / 2; k++) {
      c.push(Math.cos((TAU * k) / size));
      s.push(Math.sin((TAU * k) / size));
    }
  }
  return [Float64Array.from(c), Float64Array.from(s)];
}

/**
 * In-place 2D radix-2 complex FFT over (re, im) laid out row-major NX × NY.
 * Rows are transformed one by one; columns are transformed "row-vectorised"
 * (each butterfly combines two whole rows), which keeps memory access contiguous.
 * sign = −1 forward, +1 inverse (unscaled).
 */
class FFT2 {
  private rx = bitReverse(NX);
  private ry = bitReverse(NY);
  private tx = twiddles(NX);
  private ty = twiddles(NY);
  private tmp = new Float64Array(NX);

  run(re: Float64Array, im: Float64Array, sign: number): void {
    this.rows(re, im, sign);
    this.cols(re, im, sign);
  }

  private rows(re: Float64Array, im: Float64Array, sign: number): void {
    const rx = this.rx, [cx, sx] = this.tx;
    for (let j = 0; j < NY; j++) {
      const off = j * NX, end = off + NX;
      for (let i = 0; i < NX; i++) {
        const k = rx[i];
        if (k > i) {
          const a = off + i, b = off + k;
          let t = re[a]; re[a] = re[b]; re[b] = t;
          t = im[a]; im[a] = im[b]; im[b] = t;
        }
      }
      for (let i = off; i < end; i += 2) {
        const ar = re[i], ai = im[i], br = re[i + 1], bi = im[i + 1];
        re[i] = ar + br; im[i] = ai + bi;
        re[i + 1] = ar - br; im[i + 1] = ai - bi;
      }
      let tb = 1;
      for (let size = 4; size <= NX; size <<= 1) {
        const half = size >> 1;
        for (let k = 0; k < half; k++) {
          const wr = cx[tb + k], wi = sign * sx[tb + k];
          for (let a = off + k; a < end; a += size) {
            const b = a + half;
            const xr = re[b], xi = im[b];
            const tr = xr * wr - xi * wi, ti = xr * wi + xi * wr;
            const ar = re[a], ai = im[a];
            re[b] = ar - tr; im[b] = ai - ti;
            re[a] = ar + tr; im[a] = ai + ti;
          }
        }
        tb += half;
      }
    }
  }

  private cols(re: Float64Array, im: Float64Array, sign: number): void {
    const ry = this.ry, tmp = this.tmp, [cy, sy] = this.ty;
    for (let j = 0; j < NY; j++) {
      const k = ry[j];
      if (k > j) {
        const a = j * NX, b = k * NX;
        tmp.set(re.subarray(a, a + NX)); re.copyWithin(a, b, b + NX); re.set(tmp, b);
        tmp.set(im.subarray(a, a + NX)); im.copyWithin(a, b, b + NX); im.set(tmp, b);
      }
    }
    let tb = 0;
    for (let size = 2; size <= NY; size <<= 1) {
      const half = size >> 1;
      for (let k = 0; k < half; k++) {
        const wr = cy[tb + k], wi = sign * sy[tb + k];
        for (let j = k; j < NY; j += size) {
          const A = j * NX, B = (j + half) * NX;
          for (let i = 0; i < NX; i++) {
            const a = A + i, b = B + i;
            const xr = re[b], xi = im[b];
            const tr = xr * wr - xi * wi, ti = xr * wi + xi * wr;
            const ar = re[a], ai = im[a];
            re[b] = ar - tr; im[b] = ai - ti;
            re[a] = ar + tr; im[a] = ai + ti;
          }
        }
      }
      tb += half;
    }
  }
}

// ───────────────────────── solver ─────────────────────────

export interface StepLoss {
  /** Probability eaten by the detector screen (x ≥ X_DET), per row. */
  detRow: Float64Array;
  /** Total eaten beyond the barrier (counts as transmitted). */
  far: number;
  /** Total eaten on the emitter side. */
  near: number;
}

export class Solver {
  readonly re = new Float64Array(NX * NY);
  readonly im = new Float64Array(NX * NY);
  /** Potential (real part), for drawing. */
  readonly V = new Float32Array(NX * NY);
  geom: Geometry;
  dt = DT;
  private fft = new FFT2();
  private kr = new Float64Array(NX * NY);
  private ki = new Float64Array(NX * NY);
  private hr = new Float64Array(NX * NY);
  private hi = new Float64Array(NX * NY);
  private fr = new Float64Array(NX * NY);
  private fi = new Float64Array(NX * NY);
  /** Absorber cells and their per-application loss fractions (half and full potential steps). */
  private absIdx = new Int32Array(0);
  private absHalf = new Float64Array(0);
  private absFull = new Float64Array(0);
  private absTag = new Int32Array(0);
  /** Absorbing strength W(x, y) (≥ 0). */
  private W = new Float64Array(NX * NY);
  readonly loss: StepLoss = { detRow: new Float64Array(NY), far: 0, near: 0 };
  steps = 0;
  time = 0;

  constructor(geom: Geometry = defaultGeometry(), dt = DT) {
    this.dt = dt;
    this.geom = { ...geom };
    this.buildKinetic();
    this.setGeometry(this.geom);
  }

  private buildKinetic(): void {
    const dt = this.dt, scale = 1 / (NX * NY);
    for (let j = 0; j < NY; j++) {
      const ky = (TAU * (j < NY / 2 ? j : j - NY)) / LY;
      for (let i = 0; i < NX; i++) {
        const kx = (TAU * (i < NX / 2 ? i : i - NX)) / LX;
        const ph = -0.5 * (kx * kx + ky * ky) * dt;
        const o = j * NX + i;
        this.kr[o] = Math.cos(ph) * scale;
        this.ki[o] = Math.sin(ph) * scale;
      }
    }
  }

  /** Rebuild V (anti-aliased brass barrier / tunnel wall) and the edge absorber. */
  setGeometry(g: Geometry): void {
    this.geom = { ...g };
    const V = this.V;
    V.fill(0);
    const span = barrierSpan(g);
    if (span) {
      const [x0, x1] = span;
      const slits = slitsOf(g);
      const vMax = g.mode === "tunnel" ? g.wallHeight : V_HARD;
      for (let i = 0; i < NX; i++) {
        const cx = overlap(i * DX, (i + 1) * DX, x0, x1) / DX;
        if (cx <= 0) continue;
        for (let j = 0; j < NY; j++) {
          let open = 0;
          for (const [s0, s1] of slits) open += overlap(j * DY, (j + 1) * DY, s0, s1);
          const solid = 1 - Math.min(1, open / DY);
          V[j * NX + i] = vMax * cx * solid;
        }
      }
    }
    // absorber: W = γ s², s ramps 0 → 1 into each edge layer
    const W = this.W;
    const gamma = 0.55;
    const idx: number[] = [];
    for (let j = 0; j < NY; j++) {
      const sy = Math.max(0, (ABS_Y - j) / ABS_Y, (j - (NY - 1 - ABS_Y)) / ABS_Y);
      for (let i = 0; i < NX; i++) {
        const sx = Math.max(0, (ABS_L - i) / ABS_L, (i - (NX - 1 - ABS_R)) / ABS_R);
        const s = Math.min(1, Math.max(sx, sy));
        const w = g.absorb ? gamma * s * s : 0;
        W[j * NX + i] = w;
        if (w > 0) idx.push(j * NX + i);
      }
    }
    this.absIdx = Int32Array.from(idx);
    this.absHalf = new Float64Array(idx.length);
    this.absFull = new Float64Array(idx.length);
    this.absTag = new Int32Array(idx.length);
    const far = span ? span[1] : -1;
    for (let n = 0; n < idx.length; n++) {
      const o = idx[n], i = o % NX, w = W[o];
      this.absHalf[n] = 1 - Math.exp(-w * this.dt); // |e^{−W dt/2}|²
      this.absFull[n] = 1 - Math.exp(-2 * w * this.dt);
      // tag: 2 = detector screen, 1 = far side of barrier, 0 = emitter side
      this.absTag[n] = i * DX >= X_DET ? 2 : (i + 0.5) * DX > far ? 1 : 0;
    }
    // e^{(−iV − W) dt/2} and its square
    const dt = this.dt;
    for (let o = 0; o < NX * NY; o++) {
      const a = Math.exp(-W[o] * dt * 0.5), ph = -V[o] * dt * 0.5;
      const hr = a * Math.cos(ph), hi = a * Math.sin(ph);
      this.hr[o] = hr;
      this.hi[o] = hi;
      this.fr[o] = hr * hr - hi * hi;
      this.fi[o] = 2 * hr * hi;
    }
  }

  /** Gaussian packet ψ = exp(−|r − r₀|²/4σ²) e^{i k₀ x}, normalised (replaces ψ). */
  setPacket(x0: number, y0: number, sigma: number, k0: number): void {
    this.re.fill(0);
    this.im.fill(0);
    this.addPacket(x0, y0, sigma, k0, 1);
    this.normalize();
    this.steps = 0;
    this.time = 0;
  }

  /** Superpose a packet with amplitude weight `amp` (relative to a unit-norm packet). */
  addPacket(x0: number, y0: number, sigma: number, k0: number, amp: number): void {
    const s4 = 4 * sigma * sigma;
    const nrm = amp / Math.sqrt(2 * Math.PI * sigma * sigma);
    const ex = new Float64Array(NX), cr = new Float64Array(NX), ci = new Float64Array(NX);
    for (let i = 0; i < NX; i++) {
      let dx = (i + 0.5) * DX - x0;
      if (dx > LX / 2) dx -= LX;
      if (dx < -LX / 2) dx += LX;
      ex[i] = Math.exp(-(dx * dx) / s4);
      const ph = k0 * dx;
      cr[i] = Math.cos(ph);
      ci[i] = Math.sin(ph);
    }
    for (let j = 0; j < NY; j++) {
      let dy = (j + 0.5) * DY - y0;
      if (dy > LY / 2) dy -= LY;
      if (dy < -LY / 2) dy += LY;
      const ey = Math.exp(-(dy * dy) / s4) * nrm;
      if (ey < 1e-12) continue;
      const row = j * NX;
      for (let i = 0; i < NX; i++) {
        const a = ex[i] * ey;
        this.re[row + i] += a * cr[i];
        this.im[row + i] += a * ci[i];
      }
    }
  }

  norm(): number {
    let s = 0;
    const re = this.re, im = this.im;
    for (let o = 0; o < re.length; o++) s += re[o] * re[o] + im[o] * im[o];
    return s * DA;
  }

  normalize(target = 1): void {
    const n = this.norm();
    if (!(n > 0)) return;
    const f = Math.sqrt(target / n);
    for (let o = 0; o < this.re.length; o++) {
      this.re[o] *= f;
      this.im[o] *= f;
    }
  }

  private fft2(sign: number): void {
    this.fft.run(this.re, this.im, sign);
  }

  /** Multiply by e^{(−iV−W)dt/2} (full=false) or its square, booking absorbed probability. */
  private potential(full: boolean): void {
    const re = this.re, im = this.im;
    const mr = full ? this.fr : this.hr, mi = full ? this.fi : this.hi;
    const idx = this.absIdx, frac = full ? this.absFull : this.absHalf, tag = this.absTag;
    const L = this.loss, det = L.detRow;
    for (let n = 0; n < idx.length; n++) {
      const o = idx[n];
      const p = (re[o] * re[o] + im[o] * im[o]) * frac[n] * DA;
      const t = tag[n];
      if (t === 2) {
        det[(o / NX) | 0] += p;
        L.far += p;
      } else if (t === 1) L.far += p;
      else L.near += p;
    }
    for (let o = 0; o < re.length; o++) {
      const a = re[o], b = im[o], c = mr[o], d = mi[o];
      re[o] = a * c - b * d;
      im[o] = a * d + b * c;
    }
  }

  private kinetic(): void {
    const re = this.re, im = this.im, kr = this.kr, ki = this.ki;
    for (let o = 0; o < re.length; o++) {
      const a = re[o], b = im[o], c = kr[o], d = ki[o];
      re[o] = a * c - b * d;
      im[o] = a * d + b * c;
    }
  }

  /** Advance n steps of dt (Strang splitting; inner half-potential steps merged). */
  step(n: number): void {
    if (n <= 0) return;
    this.potential(false);
    for (let s = 0; s < n; s++) {
      this.fft2(-1);
      this.kinetic();
      this.fft2(1);
      this.potential(s === n - 1 ? false : true);
    }
    this.steps += n;
    this.time += n * this.dt;
  }

  resetLoss(): void {
    this.loss.detRow.fill(0);
    this.loss.far = 0;
    this.loss.near = 0;
  }

  /** Probability currently beyond the barrier (x > its far edge), excluding absorbed. */
  probBeyond(x: number): number {
    const i0 = Math.max(0, Math.ceil(x / DX - 0.5));
    let s = 0;
    const re = this.re, im = this.im;
    for (let j = 0; j < NY; j++) {
      const row = j * NX;
      for (let i = i0; i < NX; i++) {
        const o = row + i;
        s += re[o] * re[o] + im[o] * im[o];
      }
    }
    return s * DA;
  }

  finite(): boolean {
    const re = this.re, im = this.im;
    for (let o = 0; o < re.length; o += 7) if (!Number.isFinite(re[o]) || !Number.isFinite(im[o])) return false;
    return Number.isFinite(re[re.length - 1]) && Number.isFinite(im[im.length - 1]);
  }
}

// ───────────────────────── physics helpers ─────────────────────────

export const lambdaOf = (k0: number) => TAU / k0;
/** Effective slit → screen distance (screen sits a few cells into the absorber on average). */
export const screenL = (g: Geometry) => X_DET + 4 - g.barrierX;
/** Fringe spacing λL/d. */
export const fringeSpacing = (g: Geometry, k0: number) => (lambdaOf(k0) * screenL(g)) / g.slitSep;

/** Plane-wave transmission through a rectangular barrier (for the readout's "theory" hint). */
export function rectTransmission(E: number, V0: number, a: number): number {
  if (V0 <= 0 || a <= 0) return 1;
  if (Math.abs(E - V0) < 1e-6) return 1 / (1 + (V0 * a * a) / 2);
  if (E < V0) {
    const k = Math.sqrt(2 * (V0 - E));
    const s = Math.sinh(k * a);
    return 1 / (1 + (V0 * V0 * s * s) / (4 * E * (V0 - E)));
  }
  const k = Math.sqrt(2 * (E - V0));
  const s = Math.sin(k * a);
  return 1 / (1 + (V0 * V0 * s * s) / (4 * E * (E - V0)));
}

/** Local maxima of a smoothed profile (indices), above `rel` × max. */
export function peaks(p: Float64Array, rel = 0.08): number[] {
  let mx = 0;
  for (const v of p) mx = Math.max(mx, v);
  const out: number[] = [];
  for (let j = 2; j < p.length - 2; j++) {
    if (p[j] > rel * mx && p[j] >= p[j - 1] && p[j] > p[j + 1] && p[j] >= p[j - 2] && p[j] > p[j + 2]) out.push(j);
  }
  return out;
}

/** Sub-cell peak position by parabolic interpolation. */
function refine(p: Float64Array, j: number): number {
  const a = p[j - 1], b = p[j], c = p[j + 1];
  const den = a - 2 * b + c;
  return j + (den !== 0 ? (0.5 * (a - c)) / den : 0);
}

/** Measured fringe spacing (y units) from a detector-row profile: mean gap of the central peaks. */
export function measureSpacing(row: Float64Array, maxFromCentre: number): number {
  const ps = peaks(row)
    .map((j) => (refine(row, j) + 0.5) * DY)
    .filter((y) => Math.abs(y - Y_MID) <= maxFromCentre)
    .sort((a, b) => a - b);
  if (ps.length < 2) return NaN;
  return (ps[ps.length - 1] - ps[0]) / (ps.length - 1);
}

export interface SelfTest {
  norm: { initial: number; final: number; drift: number; steps: number; withAbsorber: number };
  fringe: { measured: number; predicted: number; ratio: number; peaks: number };
  tunnel: { thin: number; thick: number; thinWidth: number; thickWidth: number; V0: number; E: number };
  nan: boolean;
  ms: number;
  pass: boolean;
}

/** Headless physics check: unitarity, fringe spacing vs λL/d, tunnelling vs thickness. */
export function selfTest(): SelfTest {
  const t0 = performance.now();
  const k0 = 0.9, sigma = 14;
  let nan = false;

  // 1. norm conservation without absorber, through the double slit
  const g = defaultGeometry();
  const s = new Solver({ ...g, absorb: false });
  s.setPacket(X_GUN + 6, Y_MID, sigma, k0);
  const n0 = s.norm();
  let worst = 0;
  for (let k = 0; k < 6; k++) {
    s.step(40);
    worst = Math.max(worst, Math.abs(s.norm() - n0));
  }
  nan ||= !s.finite();
  const n1 = s.norm();
  // with absorber: probability must only go down, never NaN
  const sa = new Solver(g);
  sa.setPacket(X_GUN + 6, Y_MID, sigma, k0);
  sa.step(240);
  const withAbs = sa.norm() + sa.loss.far + sa.loss.near;
  nan ||= !sa.finite();

  // 2. double-slit fringe spacing at the detector vs λL/d
  const f = new Solver(g);
  f.setPacket(X_GUN + 6, Y_MID, sigma, k0);
  for (let k = 0; k < 12 && f.norm() > 0.01; k++) f.step(60);
  nan ||= !f.finite();
  const predicted = fringeSpacing(g, k0);
  const measured = measureSpacing(f.loss.detRow, predicted * 2.6);
  const nPeaks = peaks(f.loss.detRow).length;

  // 3. tunnelling: thin wall lets more through than thick, both strictly between 0 and 1
  const tunnel = (a: number) => {
    const t = new Solver({ ...g, mode: "tunnel", wallThick: a, wallHeight: 0.6 });
    t.setPacket(X_GUN + 6, Y_MID, sigma, k0);
    t.step(420);
    nan ||= !t.finite();
    return t.probBeyond(g.barrierX + a / 2) + t.loss.far;
  };
  const thin = tunnel(2), thick = tunnel(5);

  const ratio = measured / predicted;
  const pass =
    !nan &&
    worst < 1e-3 &&
    withAbs <= n0 + 1e-6 &&
    Number.isFinite(ratio) && Math.abs(ratio - 1) < 0.15 &&
    thin > thick && thin > 0 && thin < 1 && thick > 0 && thick < 1;
  return {
    norm: { initial: n0, final: n1, drift: worst, steps: s.steps, withAbsorber: withAbs },
    fringe: { measured, predicted, ratio, peaks: nPeaks },
    tunnel: { thin, thick, thinWidth: 2, thickWidth: 5, V0: 0.6, E: (k0 * k0) / 2 },
    nan,
    ms: Math.round(performance.now() - t0),
    pass,
  };
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
