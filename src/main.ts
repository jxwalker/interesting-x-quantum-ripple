import "./styles.css";
import { K_MAX, K_MIN, LY, NX, NY, Sim, X_DET } from "./sim";
import { selfTest, type Mode } from "./engine";
import { Scene2D } from "./scene2d";
import type { Layout, View } from "./view";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const params = new URLSearchParams(location.search);
const recording = params.get("record") === "1";
if (recording) document.documentElement.classList.add("ix-record");
const force2d = params.get("renderer") === "2d";
const hq = params.get("hq") === "1" || recording;

const sim = new Sim();
const stage = $("stage");
let view: View;
let frames = 0;
let fps = 60;

// ───────────────────────── renderer selection ─────────────────────────

async function makeWebGL(): Promise<View> {
  const probe = document.createElement("canvas");
  const ctx = probe.getContext("webgl2");
  if (!ctx) throw new Error("WebGL2 unavailable");
  (ctx.getExtension("WEBGL_lose_context") as { loseContext?: () => void } | null)?.loseContext?.();
  const { Scene3D } = await import("./scene3d");
  return new Scene3D(stage, sim, { hq });
}

function switchTo2D(reason: string): void {
  if (view?.kind === "2d") return;
  console.warn(`[quantum-ripple] using Canvas2D fallback: ${reason}`);
  try {
    view?.dispose();
  } catch {
    /* ignore */
  }
  stage.querySelectorAll("canvas").forEach((c) => c.remove());
  view = new Scene2D(stage, sim);
  $("badge").hidden = false;
  bindCanvas(view.canvas);
  onResize();
}

async function boot(): Promise<void> {
  if (force2d) {
    switchTo2D("forced by ?renderer=2d");
  } else {
    try {
      view = await makeWebGL();
      view.canvas.addEventListener("webglcontextlost", (e) => {
        e.preventDefault();
        switchTo2D("webglcontextlost");
      });
      bindCanvas(view.canvas);
      onResize();
      view.render(1 / 60); // compile now so init errors surface here
    } catch (err) {
      switchTo2D(`WebGL init failed: ${(err as Error)?.message ?? err}`);
    }
  }
  window.__ixRecord.ready = true;
  requestAnimationFrame(loop);
}

// ───────────────────────── layout ─────────────────────────

const dock = $("dock");
const adv = $("adv");
const intro = $("intro");

function computeLayout(w: number, h: number): Layout {
  const phone = w <= 760;
  if (phone) {
    const top = intro.getBoundingClientRect().bottom + 4;
    // Advanced is a bottom sheet over the controls on phones
    const bottom = Math.min(dock.getBoundingClientRect().top, adv.hidden ? Infinity : adv.getBoundingClientRect().top) - 6;
    const avail = Math.max(120, bottom - top);
    // portrait when there is clearly more height than width
    const portrait = avail > w * 0.9;
    return { x: 8, y: top, w: w - 16, h: avail, portrait };
  }
  const left = dock.getBoundingClientRect().right + 16;
  const right = adv.hidden ? w - 20 : adv.getBoundingClientRect().left - 12;
  // the flat top-down fallback fills a rectangle: keep it below the title block
  const top = view?.kind === "2d" ? intro.getBoundingClientRect().bottom + 12 : h < 600 ? 16 : 28;
  return { x: left, y: top, w: Math.max(200, right - left), h: h - top - 56, portrait: false };
}

function onResize(): void {
  const w = innerWidth, h = innerHeight;
  if (w > 760) document.documentElement.style.setProperty("--dock-top", `${Math.round(intro.getBoundingClientRect().bottom + 14)}px`);
  view?.resize(w, h, computeLayout(w, h));
}
addEventListener("resize", onResize);

// ───────────────────────── pointer: tap water / drag barrier / orbit ─────────────────────────

type Drag =
  | { kind: "tap"; id: number; x0: number; y0: number }
  | { kind: "barrier"; id: number; off: number; x0: number }
  | { kind: "orbit"; id: number; x: number; y: number };
let drag: Drag | null = null;
const touches = new Map<number, { x: number; y: number }>();
let pinch0 = 0;
let pinchMid: { x: number; y: number } | null = null;

function bindCanvas(c: HTMLCanvasElement): void {
  c.addEventListener("contextmenu", (e) => e.preventDefault());
  c.addEventListener("pointerdown", (e) => {
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    view.poke();
    if (touches.size === 2) {
      const [a, b] = [...touches.values()];
      pinch0 = Math.hypot(a.x - b.x, a.y - b.y);
      pinchMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      if (drag?.kind === "barrier") finishBarrier();
      drag = null;
      return;
    }
    c.setPointerCapture(e.pointerId);
    if (e.button === 2) {
      drag = { kind: "orbit", id: e.pointerId, x: e.clientX, y: e.clientY };
      return;
    }
    if (view.pickBarrier(e.clientX, e.clientY)) {
      const w = view.pickWater(e.clientX, e.clientY);
      drag = { kind: "barrier", id: e.pointerId, off: w ? w.x - sim.geom.barrierX : 0, x0: sim.geom.barrierX };
      c.classList.add("grabbing");
      return;
    }
    if (view.pickWater(e.clientX, e.clientY)) drag = { kind: "tap", id: e.pointerId, x0: e.clientX, y0: e.clientY };
    else drag = { kind: "orbit", id: e.pointerId, x: e.clientX, y: e.clientY };
  });
  c.addEventListener("pointermove", (e) => {
    if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (touches.size === 2 && pinch0 > 0) {
      const [a, b] = [...touches.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      view.zoom(pinch0 / Math.max(10, d));
      if (pinchMid) view.orbit(mid.x - pinchMid.x, mid.y - pinchMid.y);
      pinch0 = d;
      pinchMid = mid;
      return;
    }
    if (!drag || drag.id !== e.pointerId) return;
    if (drag.kind === "tap" && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) > 9) {
      drag = { kind: "orbit", id: e.pointerId, x: e.clientX, y: e.clientY };
    }
    if (drag.kind === "orbit") {
      view.orbit(e.clientX - drag.x, e.clientY - drag.y);
      drag.x = e.clientX;
      drag.y = e.clientY;
    } else if (drag.kind === "barrier") {
      const w = view.pickWater(e.clientX, e.clientY);
      if (w) {
        sim.setGeometry({ barrierX: w.x - drag.off }, "drag");
        view.rebuild();
      }
    }
  });
  const end = (e: PointerEvent) => {
    touches.delete(e.pointerId);
    if (touches.size < 2) {
      pinch0 = 0;
      pinchMid = null;
    }
    if (!drag || drag.id !== e.pointerId) return;
    if (drag.kind === "tap" && e.type === "pointerup") {
      const w = view.pickWater(e.clientX, e.clientY);
      if (w && w.x < X_DET) sim.tap(w.x, w.y);
    }
    if (drag.kind === "barrier") finishBarrier();
    c.classList.remove("grabbing");
    drag = null;
  };
  c.addEventListener("pointerup", end);
  c.addEventListener("pointercancel", end);
  c.addEventListener("wheel", (e) => {
    e.preventDefault();
    view.zoom(Math.exp(e.deltaY * 0.001));
  }, { passive: false });
}

function finishBarrier(): void {
  if (drag?.kind === "barrier" && Math.abs(sim.geom.barrierX - drag.x0) > 1.5) sim.clearDots();
}

// ───────────────────────── controls ─────────────────────────

const energy = $<HTMLInputElement>("energy");
const sep = $<HTMLInputElement>("sep");
const width = $<HTMLInputElement>("width");
const thick = $<HTMLInputElement>("thick");
const height = $<HTMLInputElement>("height");
const sigma = $<HTMLInputElement>("sigma");
const speed = $<HTMLInputElement>("speed");
const ranges = [energy, sep, width, thick, height, sigma, speed];

function paintRange(el: HTMLInputElement): void {
  const p = ((+el.value - +el.min) / (+el.max - +el.min)) * 100;
  el.style.setProperty("--p", `${p}%`);
}

const kToSlider = (k: number) => ((k - K_MIN) / (K_MAX - K_MIN)) * 100;
const sliderToK = (v: number) => K_MIN + ((K_MAX - K_MIN) * v) / 100;

function syncControls(): void {
  const g = sim.geom;
  if (document.activeElement !== energy) energy.value = String(Math.round(kToSlider(sim.k0)));
  $("energy-val").textContent = `λ ${sim.lambda.toFixed(1)}`;
  sep.value = String(g.slitSep);
  $("sep-val").textContent = g.slitSep.toFixed(0);
  const single = g.mode === "single";
  width.min = single ? "8" : "3";
  width.max = single ? "30" : "12";
  width.value = String(single ? g.singleWidth : g.slitWidth);
  $("width-val").textContent = (single ? g.singleWidth : g.slitWidth).toFixed(1);
  thick.value = String(g.wallThick);
  $("thick-val").textContent = g.wallThick.toFixed(1);
  height.value = String(g.wallHeight);
  $("height-val").textContent = `${(g.wallHeight / sim.E).toFixed(2)}× energy`;
  sigma.value = String(sim.sigma);
  $("sigma-val").textContent = sim.sigma.toFixed(1);
  speed.value = String(sim.speed);
  $("speed-val").textContent = `${sim.speed.toFixed(2)}×`;
  ranges.forEach(paintRange);
  for (const b of document.querySelectorAll<HTMLButtonElement>(".seg-btn")) b.setAttribute("aria-checked", String(b.dataset.mode === g.mode));
  for (const el of document.querySelectorAll<HTMLElement>("[data-show]")) el.hidden = !el.dataset.show!.split(" ").includes(g.mode);
  for (const id of ["btn-auto", "adv-auto"]) $(id).setAttribute("aria-pressed", String(sim.autoFire));
  $("btn-phase").setAttribute("aria-pressed", String(sim.showPhase));
  $("btn-phase").textContent = sim.showPhase ? "Phase colour: on" : "Density only";
  $("btn-theory").setAttribute("aria-pressed", String(sim.theory));
  $("btn-auto").lastChild!.textContent = sim.autoFire ? "Auto-fire: on" : "Auto-fire: off";
}
sim.onChange = syncControls;

// Energy: refire while dragging (throttled) so the new wavelength shows at once.
let energyFireT = 0;
let energyTimer = 0;
energy.addEventListener("input", () => {
  sim.setEnergy(sliderToK(+energy.value));
  sim.clearDots();
  syncControls();
  const now = performance.now();
  clearTimeout(energyTimer);
  if (now - energyFireT > 450) {
    energyFireT = now;
    sim.fire();
  } else {
    energyTimer = window.setTimeout(() => {
      energyFireT = performance.now();
      sim.fire();
    }, 160);
  }
});

energy.addEventListener("change", () => {
  // release: the final energy always gets a fresh electron
  clearTimeout(energyTimer);
  energyFireT = performance.now();
  sim.fire();
});

function geomSlider(el: HTMLInputElement, apply: (v: number) => void): void {
  el.addEventListener("input", () => {
    apply(+el.value);
    view?.rebuild();
    syncControls();
  });
  el.addEventListener("change", () => {
    sim.clearDots();
    sim.fire();
  });
}
geomSlider(sep, (v) => sim.setGeometry({ slitSep: v }, "sep"));
geomSlider(width, (v) => sim.setGeometry(sim.mode === "single" ? { singleWidth: v } : { slitWidth: v }, "width"));
geomSlider(thick, (v) => sim.setGeometry({ wallThick: v }, "thick"));
geomSlider(height, (v) => sim.setGeometry({ wallHeight: v }, "height"));
sigma.addEventListener("input", () => {
  sim.setSigma(+sigma.value);
  syncControls();
});
sigma.addEventListener("change", () => sim.fire());
speed.addEventListener("input", () => {
  sim.speed = +speed.value;
  syncControls();
});

for (const id of ["btn-fire", "adv-fire"]) {
  $(id).addEventListener("click", () => {
    sim.fire();
    view?.poke();
  });
}
for (const b of document.querySelectorAll<HTMLButtonElement>(".seg-btn")) {
  b.addEventListener("click", () => {
    sim.setMode(b.dataset.mode as Mode);
    view?.rebuild();
    syncControls();
  });
}
const toggleAuto = () => sim.setAuto(!sim.autoFire);
$("btn-auto").addEventListener("click", toggleAuto);
$("adv-auto").addEventListener("click", toggleAuto);
$("btn-measure").addEventListener("click", () => sim.measure());
$("btn-phase").addEventListener("click", () => {
  sim.showPhase = !sim.showPhase;
  syncControls();
});
$("btn-theory").addEventListener("click", () => {
  sim.theory = !sim.theory;
  syncControls();
});
$("btn-clear").addEventListener("click", () => sim.clearDots());

const advBtn = $("btn-adv");
function setAdv(open: boolean): void {
  adv.hidden = !open;
  advBtn.setAttribute("aria-expanded", String(open));
  onResize();
}
advBtn.addEventListener("click", () => setAdv(adv.hidden));
$("btn-adv-close").addEventListener("click", () => setAdv(false));

// ───────────────────────── intro card ("What am I looking at?") ─────────────────────────

const explain = $("explain");
const helpBtn = $("btn-help");
const INTRO_KEY = "quantum-ripple:intro-seen";

function setExplain(open: boolean, remember = true): void {
  if (explain.hidden === !open) return;
  explain.hidden = !open;
  helpBtn.setAttribute("aria-expanded", String(open));
  if (open) $("btn-explain-ok").focus({ preventScroll: true });
  else if (remember) {
    try {
      localStorage.setItem(INTRO_KEY, "1");
    } catch {
      /* private mode: just don't remember */
    }
  }
}
helpBtn.addEventListener("click", () => setExplain(explain.hidden));
$("btn-explain-x").addEventListener("click", () => setExplain(false));
$("btn-explain-ok").addEventListener("click", () => setExplain(false));
addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !explain.hidden) setExplain(false);
});
// Clicking anywhere else dismisses it (and still lets that click fire / poke the water).
document.addEventListener("pointerdown", (e) => {
  const t = e.target as Node;
  if (!explain.hidden && !explain.contains(t) && !helpBtn.contains(t)) setExplain(false);
}, true);
{
  let seen = false;
  try {
    seen = localStorage.getItem(INTRO_KEY) === "1";
  } catch {
    /* ignore */
  }
  // ?intro=0 or ?record=1 keep the frame clean for screenshots / the X video.
  if (!seen && !recording && params.get("intro") !== "0") setExplain(true, false);
}

// ───────────────────────── live caption ─────────────────────────

const caption = $("caption");
const captionText = $("caption-text");
const advCaptionText = $("adv-caption-text");
const advCaption = advCaptionText.parentElement!;
let capState = "";
let capPending = "";
let capPendingT = 0;

type Narration = [state: string, text: string, tone: "" | "busy" | "good"];

function pct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function narrate(): Narration {
  const m = sim.mode, st = sim.stage, now = sim.clock;
  const dots = sim.dotsTotal;
  const sinceEdit = now - sim.lastEdit;
  if (sim.lastMeasure && now - sim.lastMeasure.t < 2.2) return ["measured", "Measured! The electron was found right here; its spread-out wave collapsed to one small blob", "good"];
  if (sim.editKind === "measure-empty" && sinceEdit < 2) return ["measure-empty", "Nothing left to find: the wave has already left the tank. Press Fire first", ""];
  if (sim.editKind === "tap" && sinceEdit < 1.4) return ["tap", "You dropped a new electron into the water: its wave heads right", "busy"];
  if (sim.editKind === "drag" && sinceEdit < 1.2) {
    return m === "tunnel"
      ? ["drag", "Moving the wall: the wave reacts to the new position at once", "busy"]
      : ["drag", "Moving the barrier: closer to the screen = narrower stripes there", "busy"];
  }
  if (st === "idle") return ["idle", "Getting the electron gun ready…", ""];
  if (st === "leaving") return ["leaving", "Electron leaving the gun…", "busy"];
  if (m === "open") {
    if (st === "arriving" || st === "done") return ["open-end", "Open water: with nothing in the way the wave just spreads out (where the electron is gets fuzzier)", ""];
    return ["open", "Open water: the wave travels and slowly spreads. Higher energy = shorter waves and faster travel", "busy"];
  }
  if (m === "tunnel") {
    const over = sim.E > sim.geom.wallHeight;
    if (st === "flying") {
      return over
        ? ["t-fly", "This electron has enough energy to get over the wall… mostly", "busy"]
        : ["t-fly", "Heading for a wall it doesn't have the energy to climb", "busy"];
    }
    if (st === "atBarrier") return ["t-hit", "Hitting the wall: most of the wave bounces back, a little leaks into the wall", "busy"];
    const t = pct(sim.transmitted);
    if (over) return ["t-over", `${t} passed over the wall, yet ${pct(1 - sim.transmitted)} still bounced back: a ball never would`, "good"];
    if (sim.transmitted < 0.005) return ["t-none", "Almost nothing tunnelled through: this wall is too thick or too high", ""];
    return ["t-through", `${t} of the electron tunnelled through the wall: classically impossible`, "good"];
  }
  // double / single
  const two = m === "double";
  if (st === "flying") return ["fly", two ? "The electron's wave spreads as it flies toward the slits" : "The electron's wave flies toward the slit", "busy"];
  if (st === "atBarrier") return ["hit", two ? "The wave reaches both slits at once" : "The wave squeezes through the slit; most of it bounces off the brass", "busy"];
  if (st === "beyond") {
    return two
      ? ["overlap", "Two waves overlap: bright stripes where they add, dark where they cancel", "good"]
      : ["diffract", "Squeezing through one gap makes the wave fan out (diffraction)", "good"];
  }
  if (st === "arriving") {
    return sim.autoFire
      ? ["arrive", "Arriving at the screen: each electron lands as one dot, mostly on the bright stripes", "good"]
      : ["arrive", "Arriving at the screen: the electron will land as one dot, most likely on a bright stripe", "good"];
  }
  // done
  if (!sim.autoFire && now - sim.lastOutcomeT < 4) {
    if (sim.lastOutcome === "dot") return ["one-dot", `Detected! This electron landed as one dot (${dots} so far). Fire again, or turn on Auto-fire`, "good"];
    if (sim.lastOutcome === "miss") return ["miss", `This electron bounced off the brass (only ${pct(sim.transmitted)} get through): no dot. Fire again!`, ""];
  }
  if (dots >= 120 && two) return ["build", `Detected at the screen: ${dots} electrons so far, stripes emerging`, "good"];
  if (dots >= 120) return ["build1", `Detected at the screen: ${dots} electrons so far: one wide bright band from a single slit`, "good"];
  if (dots > 0) return ["few", `Detected at the screen: ${dots} electrons so far. Keep firing to see the pattern`, ""];
  return ["ready", "Press Fire to launch an electron", ""];
}

function updateCaption(): void {
  const [state, text, tone] = narrate();
  if (state === capState && captionText.textContent === text) return;
  // brief hold so the caption doesn't flicker at thresholds
  if (state !== capPending) {
    capPending = state;
    capPendingT = sim.clock;
  }
  const instant = ["leaving", "measured", "tap", "drag", "measure-empty"].includes(state);
  if (capState && !instant && sim.clock - capPendingT < 0.3) return;
  if (state === capState) {
    captionText.textContent = text; // number updates: no re-animation
    advCaptionText.textContent = text;
    return;
  }
  capState = state;
  caption.dataset.state = state;
  caption.dataset.tone = tone;
  captionText.textContent = text;
  advCaption.dataset.tone = tone;
  advCaptionText.textContent = text;
  captionText.style.animation = "none";
  void captionText.offsetWidth;
  captionText.style.animation = "";
}

// ───────────────────────── HUD + plots ─────────────────────────

function setupCanvas(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const r = c.getBoundingClientRect();
  const d = Math.min(2, devicePixelRatio || 1);
  const w = Math.max(10, Math.round(r.width * d)), h = Math.max(10, Math.round(r.height * d));
  if (c.width !== w || c.height !== h) {
    c.width = w;
    c.height = h;
  }
  const g = c.getContext("2d")!;
  g.setTransform(d, 0, 0, d, 0, 0);
  g.clearRect(0, 0, r.width, r.height);
  return g;
}

function drawHist(): void {
  const c = $<HTMLCanvasElement>("plot-hist");
  const g = setupCanvas(c);
  const W = c.clientWidth, H = c.clientHeight;
  const pb = 14, pt = 6;
  const hist = sim.hist;
  let mx = 1;
  for (const v of hist) mx = Math.max(mx, v);
  const bw = W / hist.length;
  g.fillStyle = "rgba(122,240,255,0.55)";
  for (let b = 0; b < hist.length; b++) {
    const v = hist[b] / mx;
    g.fillRect(b * bw + 0.5, H - pb - v * (H - pb - pt), Math.max(1, bw - 1), v * (H - pb - pt));
  }
  // theory curve (scaled to the same area)
  if (sim.mode === "double" || sim.mode === "single") {
    const n = 160;
    const ys: number[] = [];
    let tm = 1e-9;
    for (let k = 0; k <= n; k++) {
      const v = sim.theoryIntensity((k / n) * LY);
      ys.push(v);
      tm = Math.max(tm, v);
    }
    g.strokeStyle = "#ffcf4d";
    g.lineWidth = 1.5;
    g.beginPath();
    ys.forEach((v, k) => {
      const x = (k / n) * W, y = H - pb - (v / tm) * (H - pb - pt);
      if (k) g.lineTo(x, y);
      else g.moveTo(x, y);
    });
    g.stroke();
  }
  g.font = "10px ui-monospace, Menlo, monospace";
  g.fillStyle = "rgba(225,235,240,0.55)";
  g.fillText("top edge", 3, H - 3);
  g.fillText("bottom edge", W - 62, H - 3);
}

function drawSpark(): void {
  const c = $<HTMLCanvasElement>("plot-spark");
  const g = setupCanvas(c);
  const W = c.clientWidth, H = c.clientHeight;
  const hst = sim.history;
  g.strokeStyle = "rgba(255,255,255,0.08)";
  g.lineWidth = 1;
  for (const f of [0, 0.5, 1]) {
    const y = 4 + (1 - f) * (H - 8);
    g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
  }
  g.font = "10px ui-monospace, Menlo, monospace";
  g.fillStyle = "rgba(225,235,240,0.5)";
  g.fillText("100%", W - 30, 12);
  g.fillText("0%", W - 18, H - 4);
  if (hst.length < 2) return;
  const X = (i: number) => (i / 239) * W;
  const Y = (v: number) => 4 + (1 - v) * (H - 8);
  const grd = g.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, "rgba(122,240,255,0.3)");
  grd.addColorStop(1, "rgba(122,240,255,0)");
  g.fillStyle = grd;
  g.beginPath();
  g.moveTo(X(0), H);
  hst.forEach((v, i) => g.lineTo(X(i), Y(v)));
  g.lineTo(X(hst.length - 1), H);
  g.fill();
  g.strokeStyle = "#7af0ff";
  g.lineWidth = 2;
  g.beginPath();
  hst.forEach((v, i) => (i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v))));
  g.stroke();
}

const meterLabel = $("meter-label"), meterVal = $("meter-val"), meterFill = $("meter-fill"), meterTheory = $("meter-theory");
const meterLo = $("meter-lo"), meterHi = $("meter-hi");
let lastMode = "";
function updateHud(): void {
  const m = sim.mode;
  if (m !== lastMode) {
    lastMode = m;
    if (m === "open") {
      meterLabel.textContent = "Still in the tank";
      meterLo.textContent = "0% = all absorbed at the edges";
      meterHi.textContent = "100% = all still here";
      $("spark-label").textContent = "Still in the tank, over time";
    } else {
      meterLabel.textContent = m === "tunnel" ? "Tunnelled through the wall" : m === "double" ? "Got through the slits" : "Got through the slit";
      meterLo.textContent = "0% = all bounced back";
      meterHi.textContent = "100% = all passed through";
      $("spark-label").textContent = m === "tunnel" ? "Tunnelled, over time" : "Got through, over time";
    }
  }
  const v = m === "open" ? Math.min(1, sim.norm) : sim.transmitted;
  meterVal.textContent = pct(v);
  meterFill.style.width = `${(v * 100).toFixed(1)}%`;
  const showT = m === "tunnel";
  meterTheory.hidden = !showT;
  if (showT) meterTheory.style.left = `${(sim.tunnelTheory * 100).toFixed(1)}%`;
  $("dot-count").textContent = String(sim.dotsTotal);
  $("dot-word").textContent = sim.dotsTotal === 1 ? "electron detected on the screen" : "electrons detected on the screen";
  updateCaption();
  if (!adv.hidden) {
    $("adv-dots-n").textContent = String(sim.dotsTotal);
    $("norm-val").textContent = sim.norm.toFixed(3);
    $("spark-val").textContent = pct(v);
    $("spacing-val").textContent =
      m === "double" ? `stripe spacing λL/d ≈ ${sim.spacing.toFixed(1)}` : m === "tunnel" ? `plane-wave theory ${pct(sim.tunnelTheory)}` : "";
    drawHist();
    drawSpark();
  }
}

// ───────────────────────── loop ─────────────────────────

let last = performance.now();
let fpsT = 0, fpsN = 0;
let simMs = 0, renderMs = 0;
let stepped = false;
function loop(now: number): void {
  const dt = Math.min(0.1, Math.max(0, (now - last) / 1000));
  last = now;
  if (!stepped) frame(dt);
  requestAnimationFrame(loop);
}

function frame(dt: number): void {
  // auto-play: first electron leaves the gun right away
  if (sim.shotId === 0 && sim.clock > 0.3) sim.fire();
  try {
    const t0 = performance.now();
    sim.update(dt);
    const t1 = performance.now();
    view.render(dt);
    const t2 = performance.now();
    simMs += (t1 - t0 - simMs) * 0.1;
    renderMs += (t2 - t1 - renderMs) * 0.1;
  } catch (err) {
    if (view.kind === "webgl") switchTo2D(`render error: ${(err as Error)?.message ?? err}`);
    else throw err;
  }
  updateHud();
  frames++;
  const now = performance.now();
  if (!fpsT) fpsT = now;
  fpsN++;
  if (now - fpsT >= 500) {
    fps = (fpsN * 1000) / (now - fpsT);
    fpsT = now;
    fpsN = 0;
  }
}

// ───────────────────────── test hooks ─────────────────────────

interface QuantumInfo {
  renderer: "webgl" | "2d";
  grid: [number, number];
  norm: number;
  transmitted: number;
  mode: Mode;
  k0: number;
  frames: number;
  fps: number;
  stage: string;
  dots: number;
  barrierX: number;
  autoFire: boolean;
  caption: string;
  nan: boolean;
  simMs: number;
  renderMs: number;
  stepMs: number;
}

declare global {
  interface Window {
    __quantumInfo: () => QuantumInfo;
    __quantumSelfTest: () => ReturnType<typeof selfTest>;
    __quantumAdvance: (seconds: number) => QuantumInfo;
    __quantumProject: (x: number, y: number) => { x: number; y: number };
    __ixRecord: { ready: boolean; setStepped: (on: boolean) => void; stepFrame: (dt: number) => void };
  }
}
window.__quantumInfo = () => ({
  renderer: view?.kind ?? "webgl",
  grid: [NX, NY],
  norm: sim.norm,
  transmitted: sim.transmitted,
  mode: sim.mode,
  k0: sim.k0,
  frames,
  fps: Math.round(fps * 10) / 10,
  stage: sim.stage,
  dots: sim.dotsTotal,
  barrierX: sim.geom.barrierX,
  autoFire: sim.autoFire,
  caption: captionText.textContent ?? "",
  nan: !sim.finite(),
  simMs: Math.round(simMs * 100) / 100,
  renderMs: Math.round(renderMs * 100) / 100,
  stepMs: Math.round(sim.stepMs * 100) / 100,
});
window.__quantumSelfTest = () => selfTest();
// Test hook: screen position of a simulation point on the water (for taps / barrier drags).
window.__quantumProject = (x: number, y: number) => view.project(x, y);
// Test hook: advance the simulation only (no rendering) by `seconds`.
window.__quantumAdvance = (seconds: number) => {
  for (let t = 0; t < seconds; t += 1 / 30) {
    if (sim.shotId === 0) sim.fire();
    sim.update(1 / 30);
  }
  return window.__quantumInfo();
};
// Deterministic fixed-dt stepping for scripts/record-demo.mjs ("capture": "frames").
window.__ixRecord = {
  ready: false,
  setStepped(on: boolean) {
    stepped = on;
    sim.stepped = on;
    if (on) setExplain(false, false);
    view?.setStepped?.(on);
  },
  stepFrame(dt: number) {
    frame(Math.min(0.1, Math.max(1 / 240, dt || 1 / 30)));
  },
};

syncControls();
void boot();
