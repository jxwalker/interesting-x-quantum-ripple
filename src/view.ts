/** Renderer-agnostic view interface (WebGL scene or Canvas2D fallback). */
export interface Layout {
  /** Screen rectangle (CSS px) the tank should fill. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Portrait phone: the tank's long axis runs up the screen. */
  portrait: boolean;
}

export interface View {
  readonly kind: "webgl" | "2d";
  readonly canvas: HTMLCanvasElement;
  resize(w: number, h: number, layout: Layout): void;
  render(dt: number): void;
  /** Point on the water under the pointer, in simulation units (x along the tank, y across), or null. */
  pickWater(clientX: number, clientY: number): { x: number; y: number } | null;
  /** Screen position (client px) of a simulation point on the water (tests). */
  project(x: number, y: number): { x: number; y: number };
  /** Is the brass barrier / wall under the pointer? */
  pickBarrier(clientX: number, clientY: number): boolean;
  orbit(dx: number, dy: number): void;
  zoom(f: number): void;
  /** Deterministic stepping (recorder/tests): disables wall-clock adaptive quality. */
  setStepped?(on: boolean): void;
  /** Geometry (barrier / slits / wall) changed. */
  rebuild(): void;
  /** Any user interaction (pauses idle drift). */
  poke(): void;
  dispose(): void;
}

/** Iridescent phase wheel: teal → violet → magenta → amber → teal. Returns linear-ish RGB 0..1. */
export const PALETTE: [number, number, number][] = [
  [0.1, 0.95, 0.85],
  [0.42, 0.32, 1.0],
  [1.0, 0.28, 0.78],
  [1.0, 0.72, 0.22],
];

export function phaseColor(phase: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  let t = (phase / (Math.PI * 2)) % 1;
  if (t < 0) t += 1;
  const f = t * 4, i = Math.floor(f) % 4, j = (i + 1) % 4;
  let u = f - Math.floor(f);
  u = u * u * (3 - 2 * u);
  const a = PALETTE[i], b = PALETTE[j];
  out[0] = a[0] + (b[0] - a[0]) * u;
  out[1] = a[1] + (b[1] - a[1]) * u;
  out[2] = a[2] + (b[2] - a[2]) * u;
  return out;
}
