/**
 * Demo state around the solver: firing electrons, the detector screen (dots +
 * histogram), auto-fire, measurement/collapse, taps, live meters and the
 * shot "story" the caption narrates.
 */
import {
  DA, DT, DX, DY, LX, LY, NX, NY, X_DET, X_GUN, Y_MID,
  Solver, barrierSpan, defaultGeometry, fringeSpacing, lambdaOf, mulberry32, rectTransmission, slitsOf,
  type Geometry, type Mode,
} from "./engine";

/** Simulation time units per real second at speed 1. */
export const RATE = 80;
/** Detector screen: how many electrons one unit of arriving probability stands for in auto-fire. */
const DOTS_PER_PROB = 520;
export const MAX_DOTS = 2400;
export const HIST_BINS = 80;
export const K_MIN = 0.6;
export const K_MAX = 1.3;

export interface Dot {
  /** Position along the screen (y units). */
  y: number;
  /** Height on the screen 0..1 (the screen is 2D; this coordinate is uncorrelated). */
  v: number;
  /** Colour key 0..1. */
  hue: number;
  /** Birth time (real seconds). */
  t: number;
}

export interface Mark {
  x: number;
  y: number;
  t: number;
}

export type Stage = "idle" | "leaving" | "flying" | "atBarrier" | "beyond" | "arriving" | "done";

export class Sim {
  readonly solver: Solver;
  geom: Geometry = defaultGeometry();
  k0 = 0.9;
  sigma = 14;
  speed = 1;
  autoFire = true;
  showPhase = true;
  theory = false;
  /** Real seconds since start. */
  clock = 0;
  dots: Dot[] = [];
  dotsTotal = 0;
  hist = new Float64Array(HIST_BINS);
  /** Live meters. */
  norm = 1;
  beyond = 0;
  transmitted = 0;
  meanX = X_GUN;
  /** Mean x of the part beyond the barrier. */
  meanXFar = 0;
  maxNear = 0;
  maxFar = 0;
  /** Exposure for display (smoothed peak density, emitter side / beyond the barrier). */
  gainNear = 1e-3;
  gainFar = 1e-3;
  /** Per-row arrivals at the screen during the current shot. */
  shotDet = new Float64Array(NY);
  shotDetTotal = 0;
  /** Arrivals at the screen during the last frame (for dots + screen glow). */
  frameDet = new Float64Array(NY);
  stage: Stage = "idle";
  shotId = 0;
  shotAge = 0;
  /** Sim-time since the shot started. */
  shotSimT = 0;
  lastFire = -99;
  /** Outcome of the last single (non-auto) electron: "dot" | "miss" | "". */
  lastOutcome: "" | "dot" | "miss" = "";
  lastOutcomeT = -99;
  taps: Mark[] = [];
  measures: Mark[] = [];
  lastMeasure: Mark | null = null;
  lastEdit = -99;
  editKind = "";
  /** Transmitted-probability history (sparkline), one sample per 1/20 s. */
  history: number[] = [];
  private histT = 0;
  private acc = 0;
  private dotAcc = 0;
  private singleDone = false;
  private refireAt = -1;
  private rng = mulberry32(20261019);
  /** Smoothed ms per solver step (adaptive step cap). */
  stepMs = 2;
  maxStepsPerFrame = 4;
  stepped = false;
  onChange: (() => void) | null = null;

  constructor() {
    this.solver = new Solver(this.geom);
    this.solver.re.fill(0);
    this.solver.im.fill(0);
    this.norm = 0;
  }

  get E(): number {
    return (this.k0 * this.k0) / 2;
  }
  get lambda(): number {
    return lambdaOf(this.k0);
  }
  get mode(): Mode {
    return this.geom.mode;
  }
  /** Fringe spacing λL/d at the screen (double slit). */
  get spacing(): number {
    return fringeSpacing(this.geom, this.k0);
  }
  /** Plane-wave tunnelling probability for the tunnel wall (theory hint). */
  get tunnelTheory(): number {
    return rectTransmission(this.E, this.geom.wallHeight, this.geom.wallThick);
  }
  get farEdge(): number {
    const s = barrierSpan(this.geom);
    return s ? s[1] : this.geom.barrierX;
  }
  get nearEdge(): number {
    const s = barrierSpan(this.geom);
    return s ? s[0] : this.geom.barrierX;
  }

  // ───────────────────────── actions ─────────────────────────

  /** Launch a fresh electron packet from the gun. */
  fire(): void {
    this.solver.setPacket(X_GUN + 6, Y_MID, this.sigma, this.k0);
    this.solver.resetLoss();
    this.startShot();
    this.lastFire = this.clock;
    this.refireAt = -1;
  }

  private startShot(): void {
    this.shotDet.fill(0);
    this.shotDetTotal = 0;
    this.shotId++;
    this.shotAge = 0;
    this.shotSimT = 0;
    this.singleDone = false;
    this.dotAcc = 0;
    this.stage = "leaving";
    this.solver.resetLoss();
    this.gainNear = Math.max(this.gainNear, this.peakDensity() * 0.9);
  }

  private peakDensity(): number {
    return 1 / (2 * Math.PI * this.sigma * this.sigma);
  }

  /** Tap on the water: drop a small packet there, heading right. */
  tap(x: number, y: number): void {
    const s = this.solver;
    const keep = this.norm > 0.15;
    if (!keep) {
      s.re.fill(0);
      s.im.fill(0);
    }
    s.addPacket(x, y, 7, this.k0, keep ? Math.sqrt(this.norm) : 1);
    s.normalize();
    this.startShot();
    this.taps.push({ x, y, t: this.clock });
    if (this.taps.length > 6) this.taps.shift();
    this.refireAt = -1;
    this.markEdit("tap");
  }

  /** Measure position: sample from |ψ|², collapse ψ to a small blob there. */
  measure(): Mark | null {
    const s = this.solver, re = s.re, im = s.im;
    const n = s.norm();
    if (n < 0.02) {
      this.markEdit("measure-empty");
      return null;
    }
    let u = this.rng() * (n / DA), o = 0;
    for (; o < re.length - 1; o++) {
      u -= re[o] * re[o] + im[o] * im[o];
      if (u <= 0) break;
    }
    const x = ((o % NX) + 0.5) * DX, y = (Math.floor(o / NX) + 0.5) * DY;
    s.setPacket(x, y, 2.6, 0);
    this.startShot();
    this.stage = "flying";
    const m = { x, y, t: this.clock };
    this.measures.push(m);
    if (this.measures.length > 4) this.measures.shift();
    this.lastMeasure = m;
    if (x >= X_DET) this.addDot(y);
    this.refireAt = this.autoFire ? this.clock + 1.6 : -1;
    this.markEdit("measure");
    return m;
  }

  setMode(mode: Mode): void {
    if (mode === this.geom.mode) return;
    this.geom = { ...this.geom, mode };
    this.solver.setGeometry(this.geom);
    this.clearDots();
    this.history.length = 0;
    this.fire();
    this.markEdit("mode");
  }

  setEnergy(k0: number): void {
    this.k0 = Math.min(K_MAX, Math.max(K_MIN, k0));
    this.markEdit("energy");
  }

  /** Live geometry edit (barrier drag / sliders): the potential changes under the running wave. */
  setGeometry(patch: Partial<Geometry>, kind = "geom"): void {
    const g = { ...this.geom, ...patch };
    g.barrierX = Math.min(170, Math.max(84, g.barrierX));
    this.geom = g;
    this.solver.setGeometry(g);
    this.markEdit(kind);
  }

  setSigma(s: number): void {
    this.sigma = s;
    this.markEdit("sigma");
  }

  setAuto(on: boolean): void {
    this.autoFire = on;
    if (on && (this.stage === "done" || this.stage === "idle")) this.refireAt = this.clock + 0.2;
    this.onChange?.();
  }

  clearDots(): void {
    this.dots.length = 0;
    this.dotsTotal = 0;
    this.hist.fill(0);
  }

  private markEdit(kind: string): void {
    this.lastEdit = this.clock;
    this.editKind = kind;
    this.onChange?.();
  }

  addDot(y: number): void {
    const d: Dot = { y, v: 0.12 + this.rng() * 0.76, hue: this.rng(), t: this.clock };
    if (this.dots.length >= MAX_DOTS) this.dots.shift();
    this.dots.push(d);
    this.dotsTotal++;
    const b = Math.min(HIST_BINS - 1, Math.max(0, Math.floor((y / LY) * HIST_BINS)));
    this.hist[b]++;
  }

  /** Sample a row from a distribution over detector rows. */
  private sampleRow(p: Float64Array, total: number): number {
    let u = this.rng() * total;
    for (let j = 0; j < NY; j++) {
      u -= p[j];
      if (u <= 0) return (j + this.rng()) * DY;
    }
    return (NY - 0.5) * DY;
  }

  // ───────────────────────── update ─────────────────────────

  update(dt: number): void {
    this.clock += dt;
    this.shotAge += dt;
    const s = this.solver;
    const prevDet = this.solver.loss.detRow.slice();
    // advance the physics: fixed dt, capped per frame (slow motion rather than a death spiral)
    this.acc += dt * RATE * this.speed;
    let n = Math.floor(this.acc / DT);
    const cap = this.stepped ? 12 : this.maxStepsPerFrame;
    if (n > cap) {
      n = cap;
      this.acc = 0;
    } else this.acc -= n * DT;
    if (n > 0 && this.norm > 1e-5) {
      const t0 = performance.now();
      s.step(n);
      const ms = (performance.now() - t0) / n;
      this.stepMs += (ms - this.stepMs) * 0.1;
      if (!this.stepped) this.maxStepsPerFrame = Math.max(2, Math.min(5, Math.floor(9 / Math.max(0.5, this.stepMs))));
      this.shotSimT += n * DT;
    }
    if (!s.finite()) {
      // never show garbage: restart cleanly
      console.warn("[quantum-ripple] non-finite wavefunction; refiring");
      s.setGeometry(this.geom);
      this.fire();
    }

    // arrivals this frame
    const det = s.loss.detRow;
    let frameTot = 0;
    for (let j = 0; j < NY; j++) {
      const d = Math.max(0, det[j] - prevDet[j]);
      this.frameDet[j] = d;
      this.shotDet[j] += d;
      frameTot += d;
    }
    this.shotDetTotal += frameTot;

    this.measureStats();

    // dots: auto-fire = a batch of electrons riding this wave, landing where it arrives
    if (this.autoFire && frameTot > 0) {
      this.dotAcc += frameTot * DOTS_PER_PROB;
      while (this.dotAcc >= 1) {
        this.dotAcc -= 1;
        this.addDot(this.sampleRow(this.frameDet, frameTot));
      }
    }

    this.updateStage(frameTot);

    // single electron: decide once the wave has finished arriving
    if (!this.autoFire && !this.singleDone && this.stage === "done" && this.shotId > 0) {
      this.singleDone = true;
      if (this.rng() < this.shotDetTotal) {
        this.addDot(this.sampleRow(this.shotDet, this.shotDetTotal));
        this.lastOutcome = "dot";
      } else this.lastOutcome = "miss";
      this.lastOutcomeT = this.clock;
    }

    // auto-fire: next electron once this one has gone
    if (this.autoFire && this.stage === "done" && this.refireAt < 0) this.refireAt = this.clock + 0.35;
    if (this.refireAt >= 0 && this.clock >= this.refireAt) {
      this.refireAt = -1;
      if (this.autoFire) this.fire();
    }

    // sparkline
    this.histT += dt;
    while (this.histT >= 0.05) {
      this.histT -= 0.05;
      this.history.push(this.transmitted);
      if (this.history.length > 240) this.history.shift();
    }
  }

  private measureStats(): void {
    const s = this.solver, re = s.re, im = s.im;
    const iFar = Math.ceil(this.farEdge / DX - 0.5);
    const iNear = Math.floor(this.nearEdge / DX - 0.5);
    let tot = 0, sx = 0, far = 0, sxf = 0, mxN = 0, mxF = 0;
    for (let j = 0; j < NY; j++) {
      const row = j * NX;
      for (let i = 0; i < NX; i++) {
        const o = row + i;
        const p = re[o] * re[o] + im[o] * im[o];
        tot += p;
        sx += p * i;
        if (i >= iFar) {
          far += p;
          sxf += p * i;
          if (p > mxF && i < NX - 20) mxF = p;
        } else if (i <= iNear && p > mxN) mxN = p;
      }
    }
    this.norm = tot * DA;
    this.meanX = tot > 0 ? (sx / tot + 0.5) * DX : X_GUN;
    this.beyond = far * DA;
    this.meanXFar = far > 0 ? (sxf / far + 0.5) * DX : this.farEdge;
    this.maxNear = mxN;
    this.maxFar = mxF;
    const t = this.mode === "open" ? 0 : this.beyond + s.loss.far;
    this.transmitted = Math.min(1, Math.max(0, t));
    // exposure: fast attack, slow release, floors so a nearly-empty tank stays dark
    const p0 = this.peakDensity();
    const tn = Math.max(mxN, p0 * 0.05), tf = Math.max(mxF, p0 * 0.025);
    const rel = 0.04;
    this.gainNear = tn > this.gainNear ? tn : this.gainNear + (tn - this.gainNear) * rel;
    this.gainFar = tf > this.gainFar ? tf : this.gainFar + (tf - this.gainFar) * rel;
  }

  private updateStage(frameTot: number): void {
    if (this.shotId === 0) {
      this.stage = "idle";
      return;
    }
    // stages only move forward within a shot
    const order: Stage[] = ["idle", "leaving", "flying", "atBarrier", "beyond", "arriving", "done"];
    let next: Stage = "flying";
    const open = this.mode === "open";
    const through = this.beyond + this.solver.loss.far;
    if (this.norm < 0.035 || this.shotSimT > 900 / this.k0) next = "done";
    else if (this.shotDetTotal > (open ? 0.01 : 0.004) && (frameTot > 1e-7 || this.stage === "arriving")) next = "arriving";
    else if (!open && through > 0.02 && this.meanXFar > this.farEdge + 16) next = "beyond";
    else if (!open && (through > 0.004 || this.meanX > this.nearEdge - 2.2 * this.sigma)) next = "atBarrier";
    else if (this.shotAge < 0.45) next = "leaving";
    if (order.indexOf(next) > order.indexOf(this.stage)) this.stage = next;
  }

  /** Theory: bright-stripe directions (double) or dark directions (single), as sin θ list. */
  theoryAngles(): { sin: number; bright: boolean }[] {
    const out: { sin: number; bright: boolean }[] = [];
    if (this.mode === "double") {
      for (let n = -4; n <= 4; n++) {
        const s = (n * this.lambda) / this.geom.slitSep;
        if (Math.abs(s) < 0.95) out.push({ sin: s, bright: true });
      }
    } else if (this.mode === "single") {
      for (let n = -3; n <= 3; n++) {
        if (n === 0) continue;
        const s = (n * this.lambda) / this.geom.singleWidth;
        if (Math.abs(s) < 0.95) out.push({ sin: s, bright: false });
      }
    }
    return out;
  }

  /** Theory intensity on the screen at y (unnormalised): two-slit (or one-slit) Fraunhofer pattern. */
  theoryIntensity(y: number): number {
    const L = X_DET + 4 - this.geom.barrierX;
    const dy = y - Y_MID;
    const sin = dy / Math.hypot(dy, L);
    const k = this.k0;
    const sinc = (x: number) => (Math.abs(x) < 1e-6 ? 1 : Math.sin(x) / x);
    if (this.mode === "double") {
      const a = this.geom.slitWidth, d = this.geom.slitSep;
      const env = sinc((k * a * sin) / 2);
      return Math.cos((k * d * sin) / 2) ** 2 * env * env;
    }
    if (this.mode === "single") {
      const env = sinc((k * this.geom.singleWidth * sin) / 2);
      return env * env;
    }
    return 0;
  }

  slits(): [number, number][] {
    return slitsOf(this.geom);
  }

  finite(): boolean {
    return this.solver.finite() && Number.isFinite(this.norm) && Number.isFinite(this.transmitted);
  }
}

export { LX, LY, NX, NY, X_DET, X_GUN, Y_MID, DX, DY };
