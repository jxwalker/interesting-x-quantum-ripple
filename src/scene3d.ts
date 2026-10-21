/**
 * WebGL scene (three.js): a liquid-glass ripple tank on a walnut desk.
 * The water is a dense plane displaced by |ψ|² and coloured by arg ψ (vertex
 * texture fetch from a float field texture), on a physical clearcoat material
 * so it picks up studio reflections; brass rails, posts, bolts and barrier;
 * aluminium electron gun; frosted detector screen with glowing dots; fringe
 * light spilling onto the desk; ACES, bloom, vignette and grain.
 */
import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { DX, DY, LY, NX, NY, V_HARD, X_DET, Y_MID, barrierSpan, slitsOf } from "./engine";
import { HIST_BINS, MAX_DOTS, type Sim } from "./sim";
import { PALETTE, phaseColor, type Layout, type View } from "./view";
import { brassRuler, brushed, glow, softbox, walnut } from "./textures";

/** Tank interior size (world units) and heights. */
const TW = 3.2;
const TD = 2.0;
const Y_WATER = 0.2;
const WALL_TOP = 0.3;
const GLASS_T = 0.024;
const RAIL_W = 0.085;
const RAIL_H = 0.028;
const H_MAX = 0.12;
/** World units per simulation x unit. */
const SX = TW / ((NX - 1) * DX);
/** Simulation (x, y) → world (x, z), matching the water mesh vertices (texel centres). */
const gx = (x: number) => ((x / DX - 0.5) / (NX - 1) - 0.5) * TW;
const gz = (y: number) => (0.5 - (y / DY - 0.5) / (NY - 1)) * TD;
const ix = (X: number) => ((X / TW + 0.5) * (NX - 1) + 0.5) * DX;
const iy = (Z: number) => ((0.5 - Z / TD) * (NY - 1) + 0.5) * DY;
const DET_X = gx(X_DET + 3);
/** Electron gun: base of the nozzle (outside the left wall) and axis height. */
const GUN_BASE = -TW / 2 - GLASS_T - 0.4;
const GUN_Y = 0.47;

const GLSL_PALETTE = /* glsl */ `
vec3 qPal(float ph) {
  float t = fract(ph / 6.2831853) * 4.0;
  float i = floor(t);
  float u = t - i; u = u * u * (3.0 - 2.0 * u);
  vec3 c0 = vec3(${PALETTE[0].join(",")});
  vec3 c1 = vec3(${PALETTE[1].join(",")});
  vec3 c2 = vec3(${PALETTE[2].join(",")});
  vec3 c3 = vec3(${PALETTE[3].join(",")});
  vec3 a = i < 0.5 ? c0 : i < 1.5 ? c1 : i < 2.5 ? c2 : c3;
  vec3 b = i < 0.5 ? c1 : i < 1.5 ? c2 : i < 2.5 ? c3 : c0;
  return mix(a, b, u);
}`;

const FINISH_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uVignette: { value: 1.0 },
    uGrain: { value: 0.03 },
  },
  vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse; uniform float uTime; uniform float uVignette; uniform float uGrain;
    varying vec2 vUv;
    float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
    void main(){
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 q = vUv - 0.5;
      float v = smoothstep(0.9, 0.25, length(q * vec2(1.1, 1.0)));
      c.rgb *= mix(1.0 - uVignette * 0.6, 1.0, v);
      float g = hash(vUv * 1024.0 + fract(uTime) * 91.0) - 0.5;
      c.rgb += g * uGrain;
      gl_FragColor = c;
    }`,
};

const BACKDROP_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}`;
const BACKDROP_FRAG = /* glsl */ `
varying vec3 vDir;
void main() {
  float h = vDir.y;
  vec3 top = vec3(0.004, 0.005, 0.007);
  vec3 mid = vec3(0.022, 0.024, 0.028);
  vec3 col = mix(mid, top, smoothstep(0.0, 0.55, h));
  col = mix(col, vec3(0.006), smoothstep(0.0, -0.2, h));
  gl_FragColor = vec4(col, 1.0);
}`;

export class Scene3D implements View {
  readonly kind = "webgl" as const;
  readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private finish: ShaderPass;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 16 / 9, 0.05, 200);
  private sim: Sim;
  private w = 1;
  private h = 1;
  private layout: Layout = { x: 0, y: 0, w: 800, h: 450, portrait: false };
  private mobile: boolean;
  private dpr = 1;
  private hq: boolean;
  private stepped = false;
  // camera rig
  private yawOff = 0;
  private pitchOff = 0;
  private yawT = 0;
  private pitchT = 0;
  private zoomF = 1;
  private zoomT = 1;
  private idle = 10;
  private driftW = 1;
  private time = 0;
  private dist = 8;
  private offX = 0;
  private offY = 0;
  private framed = false;
  /** ?cam=yaw,pitch,zoom offsets (debug / screenshots). */
  private camDbg = [0, 0, 1];
  private fitPts: THREE.Vector3[] = [];
  // water
  private field: Float32Array;
  private fieldTex: THREE.DataTexture;
  private edge: Float32Array;
  private waterU = {
    uField: { value: null as THREE.Texture | null },
    uH: { value: H_MAX },
    uRipple: { value: 0.3 },
    uPhaseOn: { value: 1 },
    uGlow: { value: 1.55 },
    uGlowPow: { value: 1.15 },
  };
  private glowData: Uint8Array;
  private glowTex: THREE.DataTexture;
  private glowAcc = new Float32Array(64 * 32 * 3);
  private spill!: THREE.ShaderMaterial;
  private liquidMat!: THREE.MeshPhysicalMaterial;
  private fringeCol = new THREE.Color();
  private fringeAmt = 0;
  // props
  private brass!: THREE.MeshPhysicalMaterial;
  private barrier = new THREE.Group();
  private gun = new THREE.Group();
  private gunGlow!: THREE.Sprite;
  private gunCore!: THREE.MeshStandardMaterial;
  private gunLight!: THREE.PointLight;
  private recoil = 0;
  private lastFireSeen = -99;
  private dots!: THREE.InstancedMesh;
  private dotsShown = -1;
  private histData = new Uint8Array(HIST_BINS * 4);
  private histTex: THREE.DataTexture;
  private liveData = new Uint8Array(NY * 4);
  private liveTex: THREE.DataTexture;
  private screenMat!: THREE.ShaderMaterial;
  private rings: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>[] = [];
  private flash!: THREE.Sprite;
  private theory!: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private theoryKey = "";
  private raycaster = new THREE.Raycaster();
  private fpsAcc = 0;
  private fpsFrames = 0;
  private lowFor = 0;
  private dummy = new THREE.Object3D();
  private tmpC = new THREE.Color();
  private tmpV = new THREE.Vector3();
  private rgb: [number, number, number] = [0, 0, 0];

  constructor(container: HTMLElement, sim: Sim, opts: { hq?: boolean } = {}) {
    this.sim = sim;
    this.hq = !!opts.hq;
    this.mobile = matchMedia("(pointer: coarse)").matches || Math.min(innerWidth, innerHeight) < 600;
    const canvas = document.createElement("canvas");
    canvas.id = "canvas";
    canvas.setAttribute("aria-label", "Ripple tank: tap the water to drop an electron, drag the brass barrier to move it, drag elsewhere to turn the view");
    container.appendChild(canvas);
    this.canvas = canvas;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: "high-performance", alpha: false });
    } catch (e) {
      canvas.remove();
      throw e;
    }
    this.renderer = renderer;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(this.dpr);

    // field texture: R,G = Re ψ, Im ψ (exposure-scaled), B = potential, A = edge mask
    this.field = new Float32Array(NX * NY * 4);
    this.fieldTex = new THREE.DataTexture(this.field, NX, NY, THREE.RGBAFormat, THREE.FloatType);
    this.fieldTex.magFilter = THREE.NearestFilter;
    this.fieldTex.minFilter = THREE.NearestFilter;
    this.fieldTex.needsUpdate = true;
    this.waterU.uField.value = this.fieldTex;
    this.edge = new Float32Array(NX * NY);
    for (let j = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++) {
        const d = Math.min(i, NX - 1 - i, j, NY - 1 - j);
        this.edge[j * NX + i] = Math.min(1, d / 3);
      }
    }
    this.glowData = new Uint8Array(64 * 32 * 4);
    this.glowTex = new THREE.DataTexture(this.glowData, 64, 32, THREE.RGBAFormat);
    this.glowTex.magFilter = THREE.LinearFilter;
    this.glowTex.minFilter = THREE.LinearFilter;
    this.glowTex.needsUpdate = true;
    this.histTex = new THREE.DataTexture(this.histData, HIST_BINS, 1, THREE.RGBAFormat);
    this.histTex.magFilter = THREE.LinearFilter;
    this.histTex.minFilter = THREE.LinearFilter;
    this.histTex.needsUpdate = true;
    this.liveTex = new THREE.DataTexture(this.liveData, NY, 1, THREE.RGBAFormat);
    this.liveTex.magFilter = THREE.LinearFilter;
    this.liveTex.minFilter = THREE.LinearFilter;
    this.liveTex.needsUpdate = true;

    this.buildEnvironment();
    this.buildDesk();
    this.buildTank();
    this.buildWater();
    this.buildGun();
    this.buildScreen();
    this.buildFx();
    this.scene.add(this.barrier);
    this.rebuild();

    const qs = new URLSearchParams(location.search);
    const dbg = qs.get("dbg") ?? "";
    const cam = (qs.get("cam") ?? "").split(",").map(Number);
    if (cam.length === 3 && cam.every(Number.isFinite)) this.camDbg = cam;
    const num = (k: string) => (qs.has(k) && Number.isFinite(+qs.get(k)!) ? +qs.get(k)! : null);
    const samples = this.mobile || dbg.includes("nomsaa") ? 0 : 4;
    const rt = new THREE.WebGLRenderTarget(2, 2, { type: THREE.HalfFloatType, samples });
    this.composer = new EffectComposer(renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.7, 0.45, 0.84);
    if (!dbg.includes("nobloom")) this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.finish = new ShaderPass(FINISH_SHADER);
    this.composer.addPass(this.finish);
    // tuning knobs (debug)
    const glowK = num("glow"), bs = num("bs"), bt = num("bt"), ex = num("ex"), gp = num("gp");
    if (glowK !== null) this.waterU.uGlow.value = glowK;
    if (bs !== null) this.bloom.strength = bs;
    if (bt !== null) this.bloom.threshold = bt;
    if (ex !== null) renderer.toneMappingExposure = ex;
    if (gp !== null) this.waterU.uGlowPow.value = gp;
    if (dbg.includes("nogunlight")) this.gunLight.visible = false;
    if (dbg.includes("nokey")) this.scene.traverse((o) => { if ((o as THREE.SpotLight).isSpotLight) o.visible = false; });

    // points that must stay in frame
    const hx = TW / 2 + GLASS_T + RAIL_W, hz = TD / 2 + GLASS_T + RAIL_W;
    for (const x of [-hx, hx]) for (const z of [-hz, hz]) for (const y of [0, WALL_TOP + 0.05]) this.fitPts.push(new THREE.Vector3(x, y, z));
    this.fitPts.push(new THREE.Vector3(-hx - 0.42, 0.45, 0), new THREE.Vector3(DET_X, Y_WATER + 0.3, 0));
  }

  // ───────────────────────────── build ─────────────────────────────

  private buildEnvironment(): void {
    // dark studio with a few softboxes: controlled highlights on water, glass and brass
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const env = new THREE.Scene();
    env.add(new THREE.Mesh(new THREE.SphereGeometry(20, 24, 12), new THREE.MeshBasicMaterial({ color: 0x050607, side: THREE.BackSide })));
    const box = (w: number, h: number, c: number, k: number, pos: [number, number, number]) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(k), side: THREE.DoubleSide }));
      m.position.set(...pos);
      m.lookAt(0, 0, 0);
      env.add(m);
    };
    box(12, 7, 0xfff3e6, 3.0, [-4, 10, 3]);
    box(2.6, 11, 0xdfeaff, 2.4, [9, 4, 2]);
    box(9, 2.0, 0xffc690, 2.4, [3, 3, -9]);
    box(6, 3, 0x9fc4ff, 1.0, [-9, 2, -5]);
    box(16, 2.4, 0xfff6ea, 1.6, [-2, 3, 10]);
    box(4, 4, 0xffe2b8, 1.4, [-10, 5, 6]);
    box(9, 4, 0xffefd8, 1.1, [7, 9, -6]);
    const envRT = pmrem.fromScene(env, 0.02);
    this.scene.environment = envRT.texture;
    this.scene.environmentIntensity = 1.0;
    pmrem.dispose();
    env.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    });

    const scene = this.scene;
    scene.background = new THREE.Color(0x030405);
    scene.fog = new THREE.FogExp2(new THREE.Color(0x040506), 0.075);
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(90, 32, 16),
      new THREE.ShaderMaterial({ vertexShader: BACKDROP_VERT, fragmentShader: BACKDROP_FRAG, side: THREE.BackSide, depthWrite: false, fog: false }),
    );
    sky.renderOrder = -10;
    scene.add(sky);

    // out-of-focus studio softboxes far behind
    const sb = new THREE.CanvasTexture(softbox());
    sb.colorSpace = THREE.SRGBColorSpace;
    const boxes: [number, number, number, number, number, number][] = [
      [-7, 3.2, -11, 5, 2.4, 0x2a2622],
      [6.5, 2.4, -12, 4, 2.0, 0x1c2430],
      [0.5, 4.8, -14, 7, 1.6, 0x18181c],
      [11, 1.4, -8, 3, 3, 0x241a12],
    ];
    for (const [x, y, z, w, h, c] of boxes) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(w, h),
        new THREE.MeshBasicMaterial({ map: sb, color: c, transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending }),
      );
      m.position.set(x, y, z);
      m.lookAt(0, 0.5, 4);
      scene.add(m);
    }

    // lights: soft key spot top-left (a pool of light on the desk), warm rim behind-right, cool fill
    const key = new THREE.SpotLight(0xfff0dc, 44, 18, 0.45, 0.85, 1.6);
    key.position.set(-3.4, 7.2, 3.6);
    key.target.position.set(0.2, 0, 0);
    key.castShadow = true;
    const sm = this.mobile ? 1024 : 2048;
    key.shadow.mapSize.set(sm, sm);
    key.shadow.camera.near = 4;
    key.shadow.camera.far = 14;
    key.shadow.bias = -0.0003;
    key.shadow.normalBias = 0.01;
    key.shadow.radius = 4;
    scene.add(key, key.target);
    const rim = new THREE.SpotLight(0xffc48a, 16, 16, 0.24, 0.8, 1.6);
    rim.position.set(5.6, 1.25, -4.2);
    rim.target.position.set(0.2, 0.4, 0);
    scene.add(rim, rim.target);
    const fill = new THREE.HemisphereLight(0x8fb4ff, 0x1a1009, 0.2);
    scene.add(fill);
  }

  private buildDesk(): void {
    const { color, rough } = walnut(this.mobile ? 512 : 1024);
    const map = new THREE.CanvasTexture(color);
    map.colorSpace = THREE.SRGBColorSpace;
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.repeat.set(2.2, 2.6);
    map.anisotropy = 8;
    const rmap = new THREE.CanvasTexture(rough);
    rmap.wrapS = rmap.wrapT = THREE.RepeatWrapping;
    rmap.repeat.copy(map.repeat);
    const mat = new THREE.MeshPhysicalMaterial({
      map, roughnessMap: rmap, roughness: 0.72, metalness: 0, clearcoat: 0.4, clearcoatRoughness: 0.3, envMapIntensity: 0.18,
    });
    const desk = new THREE.Mesh(new THREE.PlaneGeometry(18, 12), mat);
    desk.rotation.x = -Math.PI / 2;
    desk.receiveShadow = true;
    this.scene.add(desk);

    // coloured light spilling from the fringes onto the walnut around the tank
    this.spill = new THREE.ShaderMaterial({
      uniforms: { uGlow: { value: this.glowTex }, uHalf: { value: new THREE.Vector2(TW / 2, TD / 2) }, uStrength: { value: 0.9 } },
      vertexShader: /* glsl */ `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uGlow; uniform vec2 uHalf; uniform float uStrength; varying vec3 vW;
        void main(){
          vec2 p = vW.xz; vec2 q = clamp(p, -uHalf, uHalf); float d = length(p - q);
          // light comes from the bright interior (the edges are absorber, always dim)
          vec2 qi = clamp(p, -uHalf * 0.7, uHalf * 0.7);
          vec2 uv = vec2(qi.x / uHalf.x * 0.5 + 0.5, 0.5 - qi.y / uHalf.y * 0.5);
          vec3 c = texture2D(uGlow, uv).rgb;
          vec3 c2 = texture2D(uGlow, vec2(0.5) + (uv - 0.5) * 0.6).rgb;
          float fall = exp(-d * 2.2) * smoothstep(0.0, 0.08, d);
          gl_FragColor = vec4((c * 0.7 + c2 * 0.3) * fall * uStrength, 1.0);
        }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const spill = new THREE.Mesh(new THREE.PlaneGeometry(TW + 3.4, TD + 3.4), this.spill);
    spill.rotation.x = -Math.PI / 2;
    spill.position.y = 0.002;
    this.scene.add(spill);
  }

  private buildTank(): void {
    const scene = this.scene;
    const brassTex = new THREE.CanvasTexture(brushed(512, 128, 210));
    brassTex.wrapS = brassTex.wrapT = THREE.RepeatWrapping;
    this.brass = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(0.95, 0.7, 0.33), metalness: 1, roughness: 0.36, roughnessMap: brassTex,
      clearcoat: 0.25, clearcoatRoughness: 0.3, envMapIntensity: 2.6,
    });
    const glass = new THREE.MeshPhysicalMaterial({
      color: 0x5d6f7c, metalness: 0, roughness: 0.03, transparent: true, opacity: 0.08,
      clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.0, depthWrite: false, side: THREE.DoubleSide,
    });
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, shadow = true) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = shadow;
      m.receiveShadow = true;
      scene.add(m);
      return m;
    };
    const ox = TW / 2 + GLASS_T / 2, oz = TD / 2 + GLASS_T / 2;
    // smoked glass floor + glass walls
    const floor = new THREE.MeshPhysicalMaterial({ color: 0x06090c, roughness: 0.25, metalness: 0, clearcoat: 1, envMapIntensity: 0.6 });
    add(new THREE.BoxGeometry(TW + 2 * GLASS_T, 0.03, TD + 2 * GLASS_T), floor, 0, 0.015, 0);
    for (const s of [-1, 1]) {
      const wx = add(new THREE.BoxGeometry(GLASS_T, WALL_TOP, TD + 2 * GLASS_T), glass, s * ox, WALL_TOP / 2, 0, false);
      wx.renderOrder = 3;
      const wz = add(new THREE.BoxGeometry(TW, WALL_TOP, GLASS_T), glass, 0, WALL_TOP / 2, s * oz, false);
      wz.renderOrder = 3;
    }
    // dark liquid body seen through the glass
    this.liquidMat = new THREE.MeshPhysicalMaterial({
      color: 0x020508, roughness: 0.15, metalness: 0, transparent: true, opacity: 0.88, envMapIntensity: 0.7, emissive: new THREE.Color(0),
    });
    const body = new THREE.Mesh(new THREE.BoxGeometry(TW - 0.002, Y_WATER - 0.035, TD - 0.002), this.liquidMat);
    body.position.y = 0.03 + (Y_WATER - 0.035) / 2;
    body.renderOrder = 1;
    scene.add(body);

    // brass rim rails with engraved ruler ticks
    const ruler = new THREE.CanvasTexture(brassRuler(2048, 64, 32));
    ruler.colorSpace = THREE.SRGBColorSpace;
    ruler.anisotropy = 8;
    const railMat = new THREE.MeshPhysicalMaterial({
      map: ruler, color: 0xffffff, metalness: 1, roughness: 0.34, roughnessMap: brassTex, clearcoat: 0.3, envMapIntensity: 2.6,
    });
    const railY = WALL_TOP + RAIL_H / 2;
    const longLen = TW + 2 * GLASS_T + 2 * RAIL_W;
    for (const s of [-1, 1]) {
      const zr = s * (TD / 2 + GLASS_T + RAIL_W / 2 - 0.02);
      add(new RoundedBoxGeometry(longLen, RAIL_H, RAIL_W, 2, 0.006), railMat, 0, railY, zr);
      const xr = s * (TW / 2 + GLASS_T + RAIL_W / 2 - 0.02);
      const short = new RoundedBoxGeometry(RAIL_W, RAIL_H, TD + 2 * GLASS_T, 2, 0.006);
      add(short, railMat, xr, railY, 0);
    }
    // corner posts with bolt caps
    const postH = WALL_TOP + RAIL_H + 0.04;
    const pw = 0.13;
    const px = TW / 2 + GLASS_T + RAIL_W / 2 - 0.02, pz = TD / 2 + GLASS_T + RAIL_W / 2 - 0.02;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      add(new RoundedBoxGeometry(pw, postH, pw, 3, 0.014), this.brass, sx * px, postH / 2, sz * pz);
    }
    // bolts along the rails + on posts
    const boltGeo = new THREE.CylinderGeometry(0.016, 0.018, 0.012, 14);
    const pos: [number, number, number][] = [];
    const n = 9;
    for (let k = 0; k < n; k++) {
      const x = -TW / 2 + 0.2 + (k / (n - 1)) * (TW - 0.4);
      for (const s of [-1, 1]) pos.push([x, railY + RAIL_H / 2 + 0.004, s * pz]);
    }
    for (let k = 0; k < 5; k++) {
      const z = -TD / 2 + 0.25 + (k / 4) * (TD - 0.5);
      for (const s of [-1, 1]) pos.push([s * px, railY + RAIL_H / 2 + 0.004, z]);
    }
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) pos.push([sx * px, postH + 0.005, sz * pz]);
    const bolts = new THREE.InstancedMesh(boltGeo, new THREE.MeshPhysicalMaterial({ color: new THREE.Color(0.7, 0.5, 0.24), metalness: 1, roughness: 0.25, envMapIntensity: 2.6 }), pos.length);
    pos.forEach((p, i) => {
      this.dummy.position.set(...p);
      this.dummy.rotation.set(0, i * 0.7, 0);
      this.dummy.updateMatrix();
      bolts.setMatrixAt(i, this.dummy.matrix);
    });
    bolts.castShadow = true;
    scene.add(bolts);

    // soft contact shadow under the tank
    const cs = document.createElement("canvas");
    cs.width = 256;
    cs.height = 160;
    const g = cs.getContext("2d")!;
    g.filter = "blur(14px)";
    g.fillStyle = "rgba(0,0,0,0.85)";
    g.fillRect(34, 34, 188, 92);
    const ctex = new THREE.CanvasTexture(cs);
    const contact = new THREE.Mesh(
      new THREE.PlaneGeometry(TW + 0.9, TD + 0.9),
      new THREE.MeshBasicMaterial({ map: ctex, transparent: true, depthWrite: false, color: 0x000000, opacity: 0.85 }),
    );
    contact.rotation.x = -Math.PI / 2;
    contact.position.y = 0.0015;
    scene.add(contact);
  }

  private buildWater(): void {
    const geo = new THREE.PlaneGeometry(TW, TD, NX - 1, NY - 1);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshPhysicalMaterial({
      color: 0x010305, roughness: 0.14, metalness: 0, clearcoat: 0.7, clearcoatRoughness: 0.05, ior: 1.33,
      envMapIntensity: 0.55, specularIntensity: 0.35,
    });
    const U = this.waterU;
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      const head = /* glsl */ `
        uniform sampler2D uField; uniform float uH; uniform float uRipple; uniform float uPhaseOn; uniform float uGlow; uniform float uGlowPow;
        varying vec3 vEmit;
        ${GLSL_PALETTE}
        float qHeight(vec2 t) {
          vec4 f = texture2D(uField, t);
          float a = min(length(f.rg), 1.7);
          float r = clamp(f.r, -a, a);
          return uH * f.a * ((1.0 - uRipple) * a + uRipple * r) / (1.0 + 0.18 * a);
        }`;
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", `#include <common>\n${head}`)
        .replace(
          "#include <beginnormal_vertex>",
          /* glsl */ `
          vec2 qtc = (uv * vec2(${NX - 1}.0, ${NY - 1}.0) + 0.5) / vec2(${NX}.0, ${NY}.0);
          vec2 qx = vec2(1.0 / ${NX}.0, 0.0), qy = vec2(0.0, 1.0 / ${NY}.0);
          float qh = qHeight(qtc);
          float qdx = (qHeight(qtc + qx) - qHeight(qtc - qx)) / (2.0 * ${(TW / (NX - 1)).toFixed(6)});
          float qdz = -(qHeight(qtc + qy) - qHeight(qtc - qy)) / (2.0 * ${(TD / (NY - 1)).toFixed(6)});
          vec3 objectNormal = normalize(vec3(-qdx, 1.0, -qdz));
          #ifdef USE_TANGENT
            vec3 objectTangent = vec3(tangent.xyz);
          #endif
          vec4 qf = texture2D(uField, qtc);
          float qa = min(length(qf.rg), 1.0);
          vec3 qc = mix(vec3(0.5, 0.85, 1.0), qPal(atan(qf.g, qf.r)), uPhaseOn);
          vEmit = qc * (pow(qa, uGlowPow) * 1.5 / (1.0 + 0.5 * qa * qa) + 0.05 * qa) * uGlow * qf.a;`,
        )
        .replace("#include <begin_vertex>", "vec3 transformed = vec3(position); transformed.y += qh;");
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vEmit;")
        .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += vEmit;");
    };
    mat.customProgramCacheKey = () => "quantum-water-v1";
    const water = new THREE.Mesh(geo, mat);
    water.position.y = Y_WATER;
    water.receiveShadow = true;
    water.frustumCulled = false;
    water.renderOrder = 2;
    this.scene.add(water);
  }

  private buildGun(): void {
    const alu = new THREE.MeshPhysicalMaterial({
      color: 0xc9ced6, metalness: 1, roughness: 0.26, roughnessMap: new THREE.CanvasTexture(brushed(256, 64, 190)), envMapIntensity: 1.5, clearcoat: 0.2,
    });
    // lathe profile along +y, rotated to point +x
    const prof: [number, number][] = [
      [0.0, 0.0], [0.03, 0.004], [0.06, 0.03], [0.078, 0.07], [0.084, 0.11], [0.084, 0.16], [0.078, 0.165], [0.078, 0.178], [0.084, 0.183],
      [0.084, 0.24], [0.078, 0.245], [0.078, 0.258], [0.084, 0.263], [0.084, 0.31], [0.0, 0.31],
    ];
    const body = new THREE.Mesh(new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r, y)), 48), alu);
    const muzzleProf: [number, number][] = [[0.0, 0.0], [0.07, 0.0], [0.074, 0.01], [0.074, 0.07], [0.06, 0.09], [0.045, 0.1], [0.03, 0.1], [0.03, 0.085], [0.0, 0.085]];
    const muzzle = new THREE.Mesh(new THREE.LatheGeometry(muzzleProf.map(([r, y]) => new THREE.Vector2(r, y)), 48), alu);
    muzzle.position.y = 0.44;
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.098, 0.098, 0.045, 48), this.brass);
    collar.position.y = 0.33;
    // glass section with a glowing core and filament rods
    const glassSec = new THREE.Mesh(
      new THREE.CylinderGeometry(0.07, 0.07, 0.09, 40, 1, true),
      new THREE.MeshPhysicalMaterial({ color: 0xbfefff, roughness: 0.05, transparent: true, opacity: 0.25, envMapIntensity: 2, side: THREE.DoubleSide, depthWrite: false }),
    );
    glassSec.position.y = 0.395;
    this.gunCore = new THREE.MeshStandardMaterial({ color: 0x0b2a30, emissive: new THREE.Color(0x7af0ff), emissiveIntensity: 2.2 });
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.09, 24), this.gunCore);
    core.position.y = 0.395;
    const rods = new THREE.Group();
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      const r = new THREE.Mesh(new THREE.CylinderGeometry(0.0045, 0.0045, 0.09, 6), this.gunCore);
      r.position.set(Math.cos(a) * 0.052, 0.395, Math.sin(a) * 0.052);
      rods.add(r);
    }
    const nozzle = new THREE.Group();
    nozzle.add(body, muzzle, collar, glassSec, core, rods);
    const tip2 = new THREE.Mesh(new THREE.CircleGeometry(0.03, 32), this.gunCore);
    tip2.position.y = 0.53;
    tip2.rotation.x = -Math.PI / 2;
    nozzle.add(tip2);
    nozzle.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = m.material !== this.gunCore;
        m.receiveShadow = true;
      }
    });
    nozzle.rotation.z = -Math.PI / 2; // +y → +x
    this.gun.add(nozzle);
    // glow sprite at the muzzle
    const gtex = new THREE.CanvasTexture(glow(128, 2.4));
    this.gunGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: gtex, color: new THREE.Color(0.48, 0.94, 1.0), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    this.gunGlow.position.set(0.535, 0, 0);
    this.gunGlow.scale.setScalar(0.32);
    this.gun.add(this.gunGlow);
    this.gunLight = new THREE.PointLight(0x7af0ff, 0.6, 2.2, 1.8);
    this.gunLight.position.set(0.62, -0.05, 0);
    this.gun.add(this.gunLight);
    // mount: brass post + clamp
    const baseX = GUN_BASE;
    const axisY = GUN_Y;
    this.gun.position.set(baseX, axisY, 0);
    this.gun.rotation.z = -0.13;
    this.scene.add(this.gun);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, axisY - 0.04, 24), this.brass);
    post.position.set(baseX + 0.1, (axisY - 0.04) / 2, 0);
    post.castShadow = true;
    this.scene.add(post);
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.12, 0.025, 40), this.brass);
    foot.position.set(baseX + 0.1, 0.0125, 0);
    foot.castShadow = true;
    foot.receiveShadow = true;
    this.scene.add(foot);
  }

  private buildScreen(): void {
    const H = 0.27;
    const y0 = Y_WATER - 0.03;
    // frosted glass slab
    const frost = new THREE.MeshPhysicalMaterial({
      color: 0x8fa3b2, roughness: 0.45, metalness: 0, transparent: true, opacity: 0.3, envMapIntensity: 1.0, depthWrite: false,
      emissive: new THREE.Color(0x0b1a22), emissiveIntensity: 1,
    });
    const slab = new THREE.Mesh(new THREE.BoxGeometry(0.03, H, TD + 0.03), frost);
    slab.position.set(DET_X + 0.02, y0 + H / 2, 0);
    slab.renderOrder = 4;
    this.scene.add(slab);
    // brass frame top bar
    const bar = new THREE.Mesh(new RoundedBoxGeometry(0.06, 0.03, TD + 2 * GLASS_T + 0.06, 2, 0.008), this.brass);
    bar.position.set(DET_X + 0.02, y0 + H + 0.015, 0);
    bar.castShadow = true;
    this.scene.add(bar);
    // histogram glow + live arrivals on the inner face
    this.screenMat = new THREE.ShaderMaterial({
      uniforms: { uHist: { value: this.histTex }, uLive: { value: this.liveTex }, uAmt: { value: 1 } },
      vertexShader: /* glsl */ `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D uHist; uniform sampler2D uLive; uniform float uAmt; varying vec2 vUv;
        void main(){
          float yf = 1.0 - vUv.x;
          float h = texture2D(uHist, vec2(yf, 0.5)).r;
          float live = texture2D(uLive, vec2(yf, 0.5)).r;
          float bar = smoothstep(h * 0.85 + 0.02, h * 0.85 - 0.06, vUv.y) * h;
          vec3 c = vec3(0.45, 0.85, 1.0) * (bar * 0.55 + h * 0.12);
          c += vec3(0.75, 0.95, 1.0) * live * 1.6 * (0.4 + 0.6 * (1.0 - vUv.y));
          float edge = smoothstep(0.0, 0.03, vUv.x) * smoothstep(1.0, 0.97, vUv.x);
          gl_FragColor = vec4(c * edge * uAmt, 1.0);
        }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const face = new THREE.Mesh(new THREE.PlaneGeometry(TD, H - 0.02), this.screenMat);
    face.rotation.y = -Math.PI / 2;
    face.position.set(DET_X + 0.003, y0 + H / 2 + 0.01, 0);
    face.renderOrder = 5;
    this.scene.add(face);
    // dots
    const dtex = new THREE.CanvasTexture(glow(64, 2.0));
    const dmat = new THREE.MeshBasicMaterial({ map: dtex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xffffff });
    const dgeo = new THREE.PlaneGeometry(1, 1);
    dgeo.rotateY(-Math.PI / 2);
    this.dots = new THREE.InstancedMesh(dgeo, dmat, MAX_DOTS);
    this.dots.count = 0;
    this.dots.frustumCulled = false;
    this.dots.renderOrder = 6;
    this.dots.setColorAt(0, new THREE.Color(1, 1, 1));
    this.scene.add(this.dots);
  }

  private buildFx(): void {
    for (let k = 0; k < 6; k++) {
      const m = new THREE.Mesh(
        new THREE.RingGeometry(0.92, 1, 64),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 0.95, 1.0).multiplyScalar(1.6), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }),
      );
      m.rotation.x = -Math.PI / 2;
      m.visible = false;
      m.renderOrder = 7;
      this.scene.add(m);
      this.rings.push(m);
    }
    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(glow(128, 1.8)), color: new THREE.Color(1.0, 0.8, 0.3), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    this.flash.visible = false;
    this.flash.renderOrder = 8;
    this.scene.add(this.flash);
    this.theory = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xffcf4d, transparent: true, opacity: 0.75, depthTest: false }),
    );
    this.theory.renderOrder = 9;
    this.theory.visible = false;
    this.scene.add(this.theory);
  }

  /** Rebuild the brass barrier / tunnel wall to match the current geometry. */
  rebuild(): void {
    const g = this.sim.geom;
    for (const c of [...this.barrier.children]) {
      this.barrier.remove(c);
      (c as THREE.Mesh).geometry?.dispose();
    }
    const span = barrierSpan(g);
    this.barrier.visible = !!span;
    if (!span) return;
    const zIn = TD / 2 + GLASS_T + 0.03;
    const bottom = 0.03;
    if (g.mode === "tunnel") {
      const t = Math.max(0.014, (span[1] - span[0]) * SX);
      const top = Y_WATER + 0.035 + (g.wallHeight / 1.4) * 0.3;
      const m = new THREE.Mesh(new RoundedBoxGeometry(t, top - bottom, 2 * zIn, 1, Math.min(0.004, t / 3)), this.brass);
      m.position.set(0, (top + bottom) / 2, 0);
      m.castShadow = m.receiveShadow = true;
      this.barrier.add(m);
      const cap = new THREE.Mesh(new RoundedBoxGeometry(t + 0.03, 0.022, 2 * zIn + 0.04, 2, 0.006), this.brass);
      cap.position.set(0, top + 0.011, 0);
      cap.castShadow = true;
      this.barrier.add(cap);
    } else {
      const t = (span[1] - span[0]) * SX;
      const slotTop = Y_WATER + 0.16;
      const top = Y_WATER + 0.33;
      const slits = slitsOf(g).map(([a, b]) => [gz(b), gz(a)] as [number, number]).sort((p, q) => p[0] - q[0]);
      // solid segments between the slit openings (z ascending)
      let z0 = -zIn;
      const segs: [number, number][] = [];
      for (const [a, b] of slits) {
        segs.push([z0, a]);
        z0 = b;
      }
      segs.push([z0, zIn]);
      for (const [a, b] of segs) {
        if (b - a < 0.002) continue;
        const m = new THREE.Mesh(new THREE.BoxGeometry(t, slotTop - bottom, b - a), this.brass);
        m.position.set(0, (slotTop + bottom) / 2, (a + b) / 2);
        m.castShadow = m.receiveShadow = true;
        this.barrier.add(m);
      }
      const plate = new THREE.Mesh(new RoundedBoxGeometry(t, top - slotTop, 2 * zIn, 2, 0.006), this.brass);
      plate.position.set(0, (top + slotTop) / 2, 0);
      plate.castShadow = plate.receiveShadow = true;
      this.barrier.add(plate);
      const cap = new THREE.Mesh(new RoundedBoxGeometry(t + 0.028, 0.024, 2 * zIn + 0.05, 2, 0.007), this.brass);
      cap.position.set(0, top + 0.012, 0);
      cap.castShadow = true;
      this.barrier.add(cap);
      // bolts on both faces
      const bz = [-0.8, -0.45, 0.45, 0.8].map((f) => f * zIn);
      const bolts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.012, 0.013, 0.01, 12), this.brass, bz.length * 2);
      let k = 0;
      for (const s of [-1, 1]) for (const z of bz) {
        this.dummy.position.set(s * (t / 2 + 0.004), top - 0.05, z);
        this.dummy.rotation.set(0, 0, Math.PI / 2);
        this.dummy.updateMatrix();
        bolts.setMatrixAt(k++, this.dummy.matrix);
      }
      this.barrier.add(bolts);
    }
    this.barrier.position.x = gx(g.barrierX);
    this.theoryKey = "";
  }

  // ───────────────────────────── view API ─────────────────────────────

  resize(w: number, h: number, layout: Layout): void {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    if (layout.portrait !== this.layout.portrait) this.framed = false;
    this.layout = layout;
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(this.w, this.h, false);
    this.composer.setPixelRatio(this.dpr);
    this.composer.setSize(this.w, this.h);
    const bloomScale = this.mobile ? 0.25 : 0.5;
    this.bloom.resolution.set(this.w * bloomScale, this.h * bloomScale);
    this.bloom.setSize(this.w * this.dpr * bloomScale, this.h * this.dpr * bloomScale);
    this.camera.aspect = this.w / this.h;
    this.camera.updateProjectionMatrix();
  }

  poke(): void {
    this.idle = 0;
  }

  setStepped(on: boolean): void {
    this.stepped = on;
  }

  orbit(dx: number, dy: number): void {
    this.idle = 0;
    this.yawT = THREE.MathUtils.clamp(this.yawT - dx * 0.005, -0.75, 0.75);
    this.pitchT = THREE.MathUtils.clamp(this.pitchT + dy * 0.004, -0.45, 0.35);
  }

  zoom(f: number): void {
    this.idle = 0;
    this.zoomT = THREE.MathUtils.clamp(this.zoomT * f, 0.7, 1.4);
  }

  private ray(clientX: number, clientY: number): void {
    const r = this.canvas.getBoundingClientRect();
    const v = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(v, this.camera);
  }

  pickWater(clientX: number, clientY: number): { x: number; y: number } | null {
    this.ray(clientX, clientY);
    const p = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -(Y_WATER + 0.02)), p)) return null;
    if (Math.abs(p.x) > TW / 2 || Math.abs(p.z) > TD / 2) return null;
    return { x: ix(p.x), y: iy(p.z) };
  }

  project(x: number, y: number): { x: number; y: number } {
    const v = this.tmpV.set(gx(x), Y_WATER + 0.02, gz(y)).project(this.camera);
    const r = this.canvas.getBoundingClientRect();
    return { x: r.left + (v.x * 0.5 + 0.5) * r.width, y: r.top + (-v.y * 0.5 + 0.5) * r.height };
  }

  pickBarrier(clientX: number, clientY: number): boolean {
    if (!this.barrier.visible) return false;
    this.ray(clientX, clientY);
    this.barrier.updateMatrixWorld(true);
    if (this.raycaster.intersectObject(this.barrier, true).length > 0) return true;
    // generous touch target: near the barrier line on the water
    const w = this.pickWater(clientX, clientY);
    return !!w && Math.abs(w.x - this.sim.geom.barrierX) < (this.mobile ? 9 : 5);
  }

  /** Distance + view offset so the tank fills the layout rectangle. */
  private frameCamera(dt: number): void {
    const k = 1 - Math.exp(-dt * 5);
    this.yawOff += (this.yawT - this.yawOff) * k;
    this.pitchOff += (this.pitchT - this.pitchOff) * k;
    this.zoomF += (this.zoomT - this.zoomF) * k;
    this.idle += dt;
    // idle drift fades in/out smoothly (no jump when the user grabs something)
    const driftT = this.idle > 3 ? 1 : 0;
    this.driftW += (driftT - this.driftW) * Math.min(1, dt * (driftT ? 0.35 : 4));
    const drift = this.driftW * this.driftW * (3 - 2 * this.driftW);
    const t = this.time;
    const L = this.layout;
    const baseYaw = L.portrait ? -Math.PI / 2 + 0.06 : -0.64;
    const basePitch = L.portrait ? 0.98 : 0.7;
    const yaw = baseYaw + this.camDbg[0] + this.yawOff + drift * THREE.MathUtils.degToRad(6) * Math.sin(t * 0.11);
    const pitch = THREE.MathUtils.clamp(basePitch + this.camDbg[1] + this.pitchOff + drift * 0.025 * Math.sin(t * 0.083 + 1), 0.25, 1.3);
    const target = new THREE.Vector3(0.05, 0.12, 0);
    const dir = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    const cam = this.camera;
    cam.clearViewOffset();
    // binary search the distance at which the tank fits in the layout box
    let lo = 1.5, hi = 40;
    const box = { x0: 0, x1: 0, y0: 0, y1: 0 };
    const measure = (d: number) => {
      cam.position.copy(target).addScaledVector(dir, d);
      cam.lookAt(target);
      cam.updateMatrixWorld(true);
      box.x0 = box.y0 = Infinity;
      box.x1 = box.y1 = -Infinity;
      for (const p of this.fitPts) {
        const v = this.tmpV.copy(p).project(cam);
        const sx = (v.x * 0.5 + 0.5) * this.w, sy = (-v.y * 0.5 + 0.5) * this.h;
        box.x0 = Math.min(box.x0, sx); box.x1 = Math.max(box.x1, sx);
        box.y0 = Math.min(box.y0, sy); box.y1 = Math.max(box.y1, sy);
      }
      return box.x1 - box.x0 <= L.w && box.y1 - box.y0 <= L.h;
    };
    for (let i = 0; i < 22; i++) {
      const mid = (lo + hi) / 2;
      if (measure(mid)) hi = mid;
      else lo = mid;
    }
    const push = 1 - drift * 0.03 * (0.5 + 0.5 * Math.sin(t * 0.07));
    const want = hi * this.zoomF * push * this.camDbg[2];
    if (!this.framed) this.dist = want;
    this.dist += (want - this.dist) * Math.min(1, dt * 4);
    measure(this.dist);
    const ox = (box.x0 + box.x1) / 2 - (L.x + L.w / 2);
    const oy = (box.y0 + box.y1) / 2 - (L.y + L.h / 2);
    if (!this.framed) {
      this.offX = ox;
      this.offY = oy;
      this.framed = true;
    }
    this.offX += (ox - this.offX) * Math.min(1, dt * 5);
    this.offY += (oy - this.offY) * Math.min(1, dt * 5);
    cam.setViewOffset(this.w, this.h, this.offX, this.offY, this.w, this.h);
    cam.updateProjectionMatrix();
  }

  /** Copy ψ into the field texture (exposure per side of the barrier) + the low-res glow for the desk. */
  private uploadField(): void {
    const sim = this.sim, s = sim.solver, re = s.re, im = s.im, V = s.V, f = this.field, edge = this.edge;
    const open = sim.mode === "open";
    const gN = Math.max(1e-9, open ? Math.max(sim.gainNear, sim.gainFar) : sim.gainNear);
    const gF = Math.max(1e-9, open ? gN : Math.max(sim.gainFar, sim.gainNear / 9));
    const sN = 1 / Math.sqrt(gN), sF = 1 / Math.sqrt(gF);
    const xf = sim.farEdge;
    const colS = new Float32Array(NX);
    for (let i = 0; i < NX; i++) {
      const x = (i + 0.5) * DX;
      const u = Math.min(1, Math.max(0, (x - (xf - 1)) / 8));
      const w = u * u * (3 - 2 * u);
      colS[i] = sN + (sF - sN) * w;
    }
    const vInv = 1 / V_HARD;
    for (let j = 0, o = 0; j < NY; j++) {
      for (let i = 0; i < NX; i++, o++) {
        const sc = colS[i], q = o * 4;
        f[q] = re[o] * sc;
        f[q + 1] = im[o] * sc;
        f[q + 2] = V[o] * vInv;
        f[q + 3] = edge[o];
      }
    }
    this.fieldTex.needsUpdate = true;

    // 64×32 glow (4×4 blocks): colour = phase hue, weight = scaled density
    const acc = this.glowAcc;
    acc.fill(0);
    const rgb = this.rgb;
    let sumW = 0, cr = 0, cg = 0, cb = 0;
    for (let bj = 0; bj < 32; bj++) {
      for (let bi = 0; bi < 64; bi++) {
        let wsum = 0;
        for (let dj = 0; dj < 4; dj += 2) for (let di = 0; di < 4; di += 2) {
          const o = (bj * 4 + dj) * NX + bi * 4 + di;
          const sc = colS[bi * 4 + di];
          wsum += (re[o] * re[o] + im[o] * im[o]) * sc * sc;
        }
        wsum *= 0.25;
        if (wsum < 1e-4) continue;
        const oc = (bj * 4 + 2) * NX + bi * 4 + 2;
        if (this.waterU.uPhaseOn.value > 0.5) phaseColor(Math.atan2(im[oc], re[oc]), rgb);
        else rgb[0] = 0.5, rgb[1] = 0.85, rgb[2] = 1;
        const wv = Math.min(1.6, Math.pow(wsum, 0.7));
        const a = (bj * 64 + bi) * 3;
        acc[a] = rgb[0] * wv;
        acc[a + 1] = rgb[1] * wv;
        acc[a + 2] = rgb[2] * wv;
        sumW += wv;
        cr += acc[a];
        cg += acc[a + 1];
        cb += acc[a + 2];
      }
    }
    // blur (separable 5-tap) into bytes
    const tmp = new Float32Array(acc.length);
    const k5 = [0.12, 0.22, 0.32, 0.22, 0.12];
    for (let j = 0; j < 32; j++) for (let i = 0; i < 64; i++) for (let c = 0; c < 3; c++) {
      let v = 0;
      for (let t = -2; t <= 2; t++) v += acc[(j * 64 + Math.min(63, Math.max(0, i + t))) * 3 + c] * k5[t + 2];
      tmp[(j * 64 + i) * 3 + c] = v;
    }
    const gd = this.glowData;
    for (let j = 0; j < 32; j++) for (let i = 0; i < 64; i++) for (let c = 0; c < 3; c++) {
      let v = 0;
      for (let t = -2; t <= 2; t++) v += tmp[(Math.min(31, Math.max(0, j + t)) * 64 + i) * 3 + c] * k5[t + 2];
      gd[(j * 64 + i) * 4 + c] = Math.min(255, v * 200);
    }
    this.glowTex.needsUpdate = true;
    // mean colour of the glow (tints the liquid body)
    if (sumW > 0) this.fringeCol.setRGB(cr / sumW, cg / sumW, cb / sumW);
    this.fringeAmt += (Math.min(1, sumW / 120) - this.fringeAmt) * 0.2;
  }

  private updateScreen(): void {
    const sim = this.sim;
    // histogram (normalised to its max) for the frosted screen glow
    let mx = 1;
    for (const v of sim.hist) mx = Math.max(mx, v);
    const fill = Math.min(1, sim.dots.length / 60);
    for (let b = 0; b < HIST_BINS; b++) {
      const v = (sim.hist[b] / mx) * fill;
      this.histData[b * 4] = Math.round(v * 255);
    }
    this.histTex.needsUpdate = true;
    let lm = 1e-9;
    for (let j = 0; j < NY; j++) lm = Math.max(lm, sim.frameDet[j]);
    const scale = Math.min(1, lm * 900) / lm;
    for (let j = 0; j < NY; j++) {
      const prev = this.liveData[j * 4] / 255;
      const v = Math.max(prev * 0.86, sim.frameDet[j] * scale);
      this.liveData[j * 4] = Math.round(Math.min(1, v) * 255);
    }
    this.liveTex.needsUpdate = true;

    // dots (re-write only when they change; fresh ones pulse)
    const dots = sim.dots, n = dots.length;
    const now = sim.clock;
    const d = this.dummy, col = this.tmpC;
    const y0 = Y_WATER - 0.03 + 0.03;
    const start = this.dotsShown === n && n > 0 ? Math.max(0, n - 40) : 0;
    for (let k = start; k < n; k++) {
      const dt = dots[k];
      const age = now - dt.t;
      const fresh = Math.max(0, 1 - age / 0.6);
      d.position.set(DET_X - 0.004 - k * 1e-6, y0 + dt.v * 0.2, gz(dt.y));
      d.rotation.set(0, 0, 0);
      d.scale.setScalar(0.034 + 0.06 * fresh);
      d.updateMatrix();
      this.dots.setMatrixAt(k, d.matrix);
      const p = PALETTE[Math.floor(dt.hue * 4) % 4];
      col.setRGB(0.25 + p[0] * 0.75, 0.25 + p[1] * 0.75, 0.25 + p[2] * 0.75).multiplyScalar(1.6 + 4 * fresh);
      this.dots.setColorAt(k, col);
    }
    this.dots.count = n;
    this.dotsShown = n;
    this.dots.instanceMatrix.needsUpdate = true;
    if (this.dots.instanceColor) this.dots.instanceColor.needsUpdate = true;
  }

  private updateTheory(): void {
    const sim = this.sim;
    this.theory.visible = sim.theory && (sim.mode === "double" || sim.mode === "single");
    if (!this.theory.visible) return;
    const key = `${sim.mode}|${sim.k0}|${sim.geom.barrierX}|${sim.geom.slitSep}|${sim.geom.singleWidth}`;
    if (key === this.theoryKey) return;
    this.theoryKey = key;
    const pts: number[] = [];
    const x0 = sim.farEdge, xs = X_DET + 4;
    const yH = Y_WATER + 0.012;
    for (const { sin, bright } of sim.theoryAngles()) {
      const tan = sin / Math.sqrt(1 - sin * sin);
      // dashed look for dark (single-slit) lines: several short segments
      const segs = bright ? 1 : 9;
      for (let k = 0; k < segs; k++) {
        const a = k / segs, b = bright ? 1 : (k + 0.55) / segs;
        const xa = x0 + (xs - x0) * a, xb = x0 + (xs - x0) * b;
        const ya = Y_MID + (xa - x0) * tan, yb = Y_MID + (xb - x0) * tan;
        if (yb < 4 || yb > LY - 4) break;
        pts.push(gx(xa), yH, gz(ya), gx(xb), yH, gz(yb));
      }
      // tick on the screen
      const yS = Y_MID + (xs - x0) * tan;
      if (yS > 4 && yS < LY - 4) pts.push(DET_X - 0.006, Y_WATER + 0.02, gz(yS), DET_X - 0.006, Y_WATER + 0.22, gz(yS));
    }
    this.theory.geometry.dispose();
    this.theory.geometry = new THREE.BufferGeometry();
    this.theory.geometry.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  }

  render(dt: number): void {
    this.time += dt;
    const sim = this.sim;
    this.adaptQuality(dt);
    this.frameCamera(dt);

    this.waterU.uPhaseOn.value = sim.showPhase ? 1 : 0;
    this.waterU.uRipple.value = sim.showPhase ? 0.2 : 0.0;
    this.uploadField();
    this.updateScreen();
    this.updateTheory();
    this.barrier.position.x = gx(sim.geom.barrierX);

    // gun: recoil + glow pulse on fire
    if (sim.lastFire !== this.lastFireSeen) {
      this.lastFireSeen = sim.lastFire;
      if (sim.clock - sim.lastFire < 0.2) this.recoil = 1;
    }
    this.recoil = Math.max(0, this.recoil - dt * 2.2);
    const r = this.recoil;
    const kick = r * r * (3 - 2 * r);
    const base = GUN_BASE;
    this.gun.position.x = base - 0.05 * kick;
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 2.4);
    this.gunCore.emissiveIntensity = 1.6 + 0.4 * pulse + 1.4 * kick;
    this.gunGlow.scale.setScalar(0.24 + 0.04 * pulse + 0.1 * kick);
    this.gunGlow.material.opacity = 0.45 + 0.2 * kick;
    this.gunLight.intensity = 0.5 + 0.2 * pulse + 1.0 * kick;

    // desk spill + liquid tint
    this.spill.uniforms.uStrength.value = 0.55;
    this.liquidMat.emissive.copy(this.fringeCol).multiplyScalar(this.fringeAmt * 0.06);

    // tap ripples (cyan) + measurement flash (amber)
    const now = sim.clock;
    for (let k = 0; k < this.rings.length; k++) {
      const m = this.rings[k];
      const tp = sim.taps[sim.taps.length - 1 - k];
      const age = tp ? now - tp.t : 99;
      if (!tp || age > 1.1) {
        m.visible = false;
        continue;
      }
      m.visible = true;
      const a = age / 1.1;
      m.position.set(gx(tp.x), Y_WATER + 0.03, gz(tp.y));
      m.scale.setScalar(0.03 + a * 0.32);
      m.material.opacity = (1 - a) * (1 - a);
    }
    const ms = sim.lastMeasure;
    const mAge = ms ? now - ms.t : 99;
    this.flash.visible = mAge < 1.4;
    if (ms && this.flash.visible) {
      const a = mAge / 1.4;
      this.flash.position.set(gx(ms.x), Y_WATER + 0.06, gz(ms.y));
      this.flash.scale.setScalar(0.12 + 0.3 * (1 - a));
      this.flash.material.opacity = 1 - a;
    }

    this.finish.uniforms.uTime.value = this.time;
    this.composer.render(dt);
  }

  /** Dynamic resolution: drop DPR if sustained fps is low (never switches renderer). */
  private adaptQuality(dt: number): void {
    if (this.hq || this.stepped) return;
    this.fpsAcc += dt;
    this.fpsFrames++;
    if (this.fpsAcc < 1) return;
    const fps = this.fpsFrames / this.fpsAcc;
    this.fpsAcc = 0;
    this.fpsFrames = 0;
    this.lowFor = fps < 42 ? this.lowFor + 1 : 0;
    if (this.lowFor >= 2 && this.dpr > 0.75) {
      this.dpr = Math.max(0.75, this.dpr * 0.8);
      this.lowFor = 0;
      this.resize(this.w, this.h, this.layout);
    }
  }

  dispose(): void {
    this.renderer.dispose();
    this.canvas.remove();
  }
}
