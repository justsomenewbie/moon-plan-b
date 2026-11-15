// Decorative Three.js backdrop: a parallax starfield in the dark theme, drifting motes and a faint
// Moon-orbit wireframe in the light theme. Loaded lazily by three-backdrop.tsx; never in a route's first load.
import {
  BufferAttribute, BufferGeometry, Group, IcosahedronGeometry, LineLoop, LineSegments,
  Mesh, PerspectiveCamera, Points, Scene, ShaderMaterial, WebGLRenderer, WireframeGeometry,
} from "three";
import { particleCount } from "./gate";

const MAX_PIXEL_RATIO = 1.5;

// Points are placed directly in clip space: xy in [-1, 1], z is the parallax depth (0 = far, 1 = near).
// That keeps the density even at any aspect ratio and makes the wrap-around invisible.
const vertexShader = /* glsl */ `
attribute vec3 aSeed;
uniform float uTime;
uniform float uPx;
uniform vec2 uShift;
uniform vec2 uDrift;
uniform vec2 uSize;
uniform vec2 uAlpha;
uniform vec3 uColorA;
uniform vec3 uColorB;
varying vec4 vColor;
void main() {
  float depth = position.z;
  vec2 p = position.xy + (uShift + uDrift * uTime) * depth;
  p = mod(p + 1.06, 2.12) - 1.06;
  gl_Position = vec4(p, 0.0, 1.0);
  float twinkle = 0.72 + 0.28 * sin(uTime * (0.6 + aSeed.y * 1.6) + aSeed.x * 6.2832);
  gl_PointSize = mix(uSize.x, uSize.y, aSeed.z * (0.35 + 0.65 * depth)) * uPx;
  vColor = vec4(mix(uColorA, uColorB, aSeed.x), mix(uAlpha.x, uAlpha.y, depth) * twinkle);
}`;
const fragmentShader = /* glsl */ `
varying vec4 vColor;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = smoothstep(1.0, 0.15, d) * vColor.a;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor.rgb, a);
}`;

// One tiny flat-colour program for every line and body of the orbit wireframe. It compiles much faster than
// the built-in line and mesh materials. The colour is the light theme's navy accent (#1B2654).
const flatVertex = /* glsl */ `void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const flatFragment = /* glsl */ `uniform float uOpacity; void main() { gl_FragColor = vec4(0.106, 0.149, 0.329, uOpacity); }`;
const flat = (opacity: number) => new ShaderMaterial({
  vertexShader: flatVertex, fragmentShader: flatFragment, transparent: true, depthTest: false, depthWrite: false,
  uniforms: { uOpacity: { value: opacity } },
});

type Rgb = [number, number, number];
type FieldLook = { drift: [number, number]; size: [number, number]; alpha: [number, number]; colorA: Rgb; colorB: Rgb };

// Seeded so the sky looks the same on every page and visit.
function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function field(count: number, seed: number, look: FieldLook) {
  const next = random(seed);
  const position = new Float32Array(count * 3);
  const seeds = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i += 3) {
    position[i] = next() * 2.12 - 1.06;
    position[i + 1] = next() * 2.12 - 1.06;
    // Squared, so most points are far away and only a few sit near the viewer.
    position[i + 2] = 0.15 + 0.85 * next() ** 2;
    seeds[i] = next();
    seeds[i + 1] = next();
    seeds[i + 2] = next();
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(position, 3));
  geometry.setAttribute("aSeed", new BufferAttribute(seeds, 3));
  const material = new ShaderMaterial({
    vertexShader, fragmentShader, transparent: true, depthTest: false, depthWrite: false,
    uniforms: {
      uTime: { value: 0 }, uPx: { value: 1 }, uShift: { value: [0, 0] },
      uDrift: { value: look.drift }, uSize: { value: look.size }, uAlpha: { value: look.alpha },
      uColorA: { value: look.colorA }, uColorB: { value: look.colorB },
    },
  });
  const points = new Points(geometry, material);
  points.frustumCulled = false;
  return points;
}

// A wireframe Moon with three inclined orbits and one small body on each.
function orbitSystem() {
  const system = new Group();
  const line = flat(0.22);
  // The dense wireframe ball is fainter than the single orbit lines, so it never competes with text near it.
  const faint = flat(0.12);
  const solid = flat(0.42);
  const ball = new IcosahedronGeometry(1, 1);
  const moonWire = new WireframeGeometry(ball);
  const moon = new LineSegments(moonWire, faint);
  moon.scale.setScalar(0.62);
  system.add(moon);
  const bodies: { mesh: Mesh; a: number; b: number; speed: number; phase: number }[] = [];
  const disposables: { dispose(): void }[] = [line, faint, solid, ball, moonWire];
  for (const [a, b, tiltX, tiltZ, speed, phase] of [[1.35, 1.2, 1.2, 0.25, 0.22, 0.4], [1.95, 1.6, 1.35, -0.5, -0.15, 2.1], [2.6, 2.3, 1.05, 0.7, 0.1, 4.2]] as const) {
    const ring = new Float32Array(128 * 3);
    for (let i = 0; i < 128; i++) {
      const angle = (i / 128) * Math.PI * 2;
      ring[i * 3] = Math.cos(angle) * a;
      ring[i * 3 + 1] = Math.sin(angle) * b;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(ring, 3));
    const plane = new Group();
    plane.rotation.set(tiltX, 0, tiltZ);
    const mesh = new Mesh(ball, solid);
    mesh.scale.setScalar(0.045);
    plane.add(new LineLoop(geometry, line), mesh);
    system.add(plane);
    bodies.push({ mesh, a, b, speed, phase });
    disposables.push(geometry);
  }
  return { system, moon, bodies, disposables, line, faint };
}

// Starts the backdrop inside `host` and returns its cleanup. Returns a no-op if WebGL is unavailable or software-only.
export function startScene(host: HTMLElement): () => void {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ alpha: true, antialias: true, depth: false, stencil: false, powerPreference: "low-power", failIfMajorPerformanceCaveat: true });
  } catch {
    return () => {};
  }
  const canvas = renderer.domElement;
  host.append(canvas);
  renderer.setClearColor(0x000000, 0);

  const scene = new Scene();
  const camera = new PerspectiveCamera(35, 1, 0.1, 50);
  camera.position.z = 10;
  const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
  const area = [window.innerWidth, window.innerHeight] as const;

  const stars = field(particleCount(...area, 1800, 220, 900), 20261115, {
    drift: [0.004, 0], size: [1.8, 5], alpha: [0.4, 0.9], colorA: [1, 0.93, 0.82], colorB: [0.78, 0.87, 1],
  });
  const motes = field(particleCount(...area, 14000, 36, 110), 4851, {
    drift: [0.006, 0.011], size: [5, 16], alpha: [0.3, 0.8], colorA: [1, 1, 1], colorB: [1, 0.94, 0.76],
  });
  const orbit = orbitSystem();
  scene.add(stars, motes, orbit.system);
  const fields = [stars, motes].map(points => points.material as ShaderMaterial);

  const root = document.documentElement;
  const applyTheme = () => {
    const dark = root.dataset.theme !== "light";
    stars.visible = dark;
    motes.visible = orbit.system.visible = !dark;
  };
  applyTheme();
  const themeWatch = new MutationObserver(applyTheme);
  themeWatch.observe(root, { attributes: true, attributeFilter: ["data-theme"] });

  let viewHeight = 1;
  let viewWidth = 1;
  const resize = () => {
    const width = host.clientWidth;
    const height = host.clientHeight;
    if (!width || !height) return;
    const ratio = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    renderer.setPixelRatio(ratio);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    viewHeight = 2 * camera.position.z * Math.tan((camera.fov * Math.PI) / 360);
    viewWidth = viewHeight * camera.aspect;
    for (const material of fields) material.uniforms.uPx!.value = ratio;
    // Centred on the right edge, half off screen, so the wireframe stays in the page gutter beside the text.
    const narrow = camera.aspect < 0.9;
    orbit.system.scale.setScalar(narrow ? 0.45 : 0.82);
    // On a phone the text spans the full width, so the lines that pass behind it are drawn fainter.
    orbit.line.uniforms.uOpacity!.value = narrow ? 0.16 : 0.22;
    orbit.faint.uniforms.uOpacity!.value = narrow ? 0.08 : 0.12;
    orbit.system.userData.home = [viewWidth * (narrow ? 0.5 : 0.47), viewHeight * (narrow ? 0.3 : 0.22)];
  };
  resize();
  const sizeWatch = new ResizeObserver(resize);
  sizeWatch.observe(host);

  // Pointer parallax on desktop only. Phones and tablets get the scroll parallax alone.
  const target = { x: 0, y: 0 };
  const eased = { x: 0, y: 0 };
  const onPointer = (event: PointerEvent) => {
    target.x = (event.clientX / window.innerWidth) * 2 - 1;
    target.y = (event.clientY / window.innerHeight) * 2 - 1;
  };
  if (finePointer) window.addEventListener("pointermove", onPointer, { passive: true });

  const frameGap = 1000 / (finePointer ? 60 : 30) - 3;
  let raf = 0;
  let last = 0;
  let time = 0;
  let shown = false;
  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    const elapsed = now - last;
    if (elapsed < frameGap) return;
    last = now;
    const dt = Math.min(elapsed, 100) / 1000;
    time += dt;
    const ease = Math.min(1, dt * 3);
    eased.x += (target.x - eased.x) * ease;
    eased.y += (target.y - eased.y) * ease;
    const scroll = window.scrollY / Math.max(1, window.innerHeight);
    for (const material of fields) {
      material.uniforms.uTime!.value = time;
      material.uniforms.uShift!.value = [-eased.x * 0.035, eased.y * 0.035 + scroll * 0.3];
    }
    if (orbit.system.visible) {
      const [homeX, homeY] = orbit.system.userData.home as [number, number];
      orbit.system.position.set(homeX - eased.x * 0.12, homeY + eased.y * 0.08 + scroll * 0.45, 0);
      orbit.system.rotation.set(0.25 + eased.y * 0.1, time * 0.04 + eased.x * 0.14, scroll * 0.12);
      orbit.moon.rotation.y = time * 0.08;
      for (const body of orbit.bodies) {
        const angle = body.phase + time * body.speed;
        body.mesh.position.set(Math.cos(angle) * body.a, Math.sin(angle) * body.b, 0);
      }
    }
    renderer.render(scene, camera);
    if (!shown) { shown = true; host.dataset.ready = ""; }
  };

  // Run only while the tab is visible, the layer is on screen, the context is alive and motion is not paused.
  let onScreen = true;
  let lost = false;
  // Shaders compile in the background where the browser supports it; the first frame waits for them.
  let compiled = false;
  let disposed = false;
  renderer.compileAsync(scene, camera).catch(() => {}).then(() => { compiled = true; if (!disposed) sync(); });
  const pauseBox = () => document.getElementById("pause-sky-drift") as HTMLInputElement | null;
  const sync = () => {
    const run = compiled && !document.hidden && onScreen && !lost && !pauseBox()?.checked;
    if (run && !raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
    else if (!run && raf) { cancelAnimationFrame(raf); raf = 0; }
  };
  const viewWatch = new IntersectionObserver(entries => { onScreen = entries[entries.length - 1]?.isIntersecting ?? true; sync(); });
  viewWatch.observe(host);
  const onChange = (event: Event) => { if ((event.target as Element | null)?.id === "pause-sky-drift") sync(); };
  const onLost = (event: Event) => { event.preventDefault(); lost = true; sync(); };
  const onRestored = () => { lost = false; sync(); };
  document.addEventListener("visibilitychange", sync);
  document.addEventListener("change", onChange);
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);
  sync();

  return () => {
    disposed = true;
    cancelAnimationFrame(raf);
    raf = 0;
    themeWatch.disconnect();
    sizeWatch.disconnect();
    viewWatch.disconnect();
    window.removeEventListener("pointermove", onPointer);
    document.removeEventListener("visibilitychange", sync);
    document.removeEventListener("change", onChange);
    canvas.removeEventListener("webglcontextlost", onLost);
    canvas.removeEventListener("webglcontextrestored", onRestored);
    for (const points of [stars, motes]) { points.geometry.dispose(); (points.material as ShaderMaterial).dispose(); }
    for (const item of orbit.disposables) item.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
    delete host.dataset.ready;
  };
}
