import type { MapPoint } from "./globe-sites";
import { sunDirection } from "./moon-globe.ts";

export type GlobeView = { center: MapPoint; zoom: number };

export type GlobeUniforms = {
  lon: number; sinLat: number; cosLat: number;
  radius: number; half: readonly [number, number];
  sun: readonly [number, number, number]; lit: 0 | 1;
};

// The same per-frame constants that drawGlobe derives before its pixel loop.
export function globeUniforms(longitude: number, latitude: number, zoom: number, width: number, height: number, subsolar?: MapPoint): GlobeUniforms {
  const lat = latitude * Math.PI / 180;
  const sun = sunDirection(longitude, latitude, subsolar);
  return {
    lon: longitude * Math.PI / 180, sinLat: Math.sin(lat), cosLat: Math.cos(lat),
    radius: zoom * Math.min(width, height) / 2, half: [width / 2, height / 2],
    sun: sun ?? [0, 0, 0], lit: sun ? 1 : 0,
  };
}

// Device pixels for a square canvas, kept within a range the renderer can afford.
export function canvasPixels(cssWidth: number, devicePixelRatio: number, min: number, max: number) {
  const ratio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const width = Number.isFinite(cssWidth) && cssWidth > 0 ? cssWidth : 0;
  return Math.max(min, Math.min(max, Math.round(width * ratio)));
}

// Coalesces any number of requests into at most one callback per animation frame.
export function frameScheduler(callback: () => void,
  request: (run: () => void) => number = run => requestAnimationFrame(run),
  cancel: (id: number) => void = id => cancelAnimationFrame(id)) {
  let pending: number | null = null;
  const run = () => { pending = null; callback(); };
  return {
    request() { if (pending === null) pending = request(run); },
    flush() { if (pending !== null) { cancel(pending); run(); } },
    cancel() { if (pending !== null) { cancel(pending); pending = null; } },
  };
}
export type FrameScheduler = ReturnType<typeof frameScheduler>;

// A tiny external store for useSyncExternalStore: the live view shown while dragging.
export function viewStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
export type ViewStore<T> = ReturnType<typeof viewStore<T>>;

const vertexSource = `
attribute vec2 a_position;
void main() { gl_Position = vec4(a_position, 0.0, 1.0); }`;

// A line-for-line port of drawGlobe's inverse orthographic projection and shading.
const fragmentSource = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D u_map;
uniform vec2 u_half;
uniform float u_radius;
uniform float u_lon;
uniform float u_sinLat;
uniform float u_cosLat;
uniform vec3 u_sun;
uniform float u_lit;
const float PI = 3.141592653589793;
void main() {
  // gl_FragCoord is the pixel center, counted from the bottom row, so y already points north.
  vec2 p = (gl_FragCoord.xy - u_half) / u_radius;
  float depth = 1.0 - dot(p, p);
  if (depth < 0.0) { gl_FragColor = vec4(0.0); return; }
  float z = sqrt(depth);
  float u = 0.5 + (u_lon + atan(p.x, z * u_cosLat - p.y * u_sinLat)) / (2.0 * PI);
  float v = 0.5 - asin(clamp(p.y * u_cosLat + z * u_sinLat, -1.0, 1.0)) / PI;
  vec3 color = texture2D(u_map, vec2(fract(u), v)).rgb;
  float shade = u_lit > 0.5 ? 0.13 + 0.87 * max(0.0, dot(vec3(p, z), u_sun)) : 0.64 + 0.36 * z;
  gl_FragColor = vec4(color * shade, 1.0);
}`;

export type GlobeRenderer = { draw(uniforms: GlobeUniforms, width: number, height: number): void; dispose(): void };

/**
 * Returns null when the browser offers no WebGL context (the canvas can still take a 2D context).
 * Throws when a context exists but cannot be used; the caller then needs a fresh canvas.
 */
export function createGlobeRenderer(canvas: HTMLCanvasElement, map: HTMLImageElement): GlobeRenderer | null {
  const options: WebGLContextAttributes = { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false };
  const gl: WebGLRenderingContext | WebGL2RenderingContext | null = canvas.getContext("webgl2", options) ?? canvas.getContext("webgl", options);
  if (!gl) return null;
  if (gl.isContextLost()) throw Error("WebGL context lost");
  const webgl2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
  const width = map.naturalWidth, height = map.naturalHeight;
  if (Math.max(width, height) > gl.getParameter(gl.MAX_TEXTURE_SIZE)) throw Error("Map exceeds texture size");

  function shader(type: number, source: string) {
    const item = gl!.createShader(type)!;
    gl!.shaderSource(item, source);
    gl!.compileShader(item);
    if (!gl!.getShaderParameter(item, gl!.COMPILE_STATUS)) throw Error(gl!.getShaderInfoLog(item) ?? "Shader failed");
    return item;
  }
  const program = gl.createProgram()!;
  const vertex = shader(gl.VERTEX_SHADER, vertexSource), fragment = shader(gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program) ?? "Program failed");
  gl.useProgram(program);

  // One oversized triangle covers the viewport.
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "a_position");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  const texture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, map);
  // Bilinear sampling without mipmaps, as on the CPU. Longitude wraps; latitude clamps at the poles.
  // WebGL1 can only repeat power-of-two textures; fract() in the shader keeps the coordinate in range either way.
  const powerOfTwo = (width & (width - 1)) === 0 && (height & (height - 1)) === 0;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, webgl2 || powerOfTwo ? gl.REPEAT : gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const at = (name: string) => gl.getUniformLocation(program, name);
  const uniform = { map: at("u_map"), half: at("u_half"), radius: at("u_radius"), lon: at("u_lon"),
    sinLat: at("u_sinLat"), cosLat: at("u_cosLat"), sun: at("u_sun"), lit: at("u_lit") };
  gl.uniform1i(uniform.map, 0);
  gl.disable(gl.BLEND);
  if (gl.getError() !== gl.NO_ERROR) throw Error("WebGL setup failed");

  return {
    draw(values, pixelWidth, pixelHeight) {
      // Resizing clears the drawing buffer, so the new frame is drawn in the same task.
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
      gl.viewport(0, 0, pixelWidth, pixelHeight);
      gl.uniform2f(uniform.half, values.half[0], values.half[1]);
      gl.uniform1f(uniform.radius, values.radius);
      gl.uniform1f(uniform.lon, values.lon);
      gl.uniform1f(uniform.sinLat, values.sinLat);
      gl.uniform1f(uniform.cosLat, values.cosLat);
      gl.uniform3f(uniform.sun, values.sun[0], values.sun[1], values.sun[2]);
      gl.uniform1f(uniform.lit, values.lit);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose() {
      if (gl.isContextLost()) return;
      gl.deleteTexture(texture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
    },
  };
}
