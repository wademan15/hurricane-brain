/**
 * The hurricane renderer: one full-screen fragment shader, WebGL2 with a WebGL1 fallback.
 *
 * What it draws comes only from `HurricaneUniforms` (bindings.ts). There is no time uniform:
 * the shader cannot animate on its own. The cloud texture is static and is sampled in the
 * storm's rotating frame, so a pixel changes only when a bound parameter changes. The renderer
 * also skips drawing entirely when the uniforms and canvas size are unchanged, so a still
 * measurement gives a still, pixel-identical picture (and costs no GPU time).
 *
 * Geometry formulas mirror geometry.ts (used by the tap-to-inspect hit test). Keep them in step.
 */
import type { HurricaneUniforms } from './bindings.ts';
import { cloudTexture, NOISE_SIZE } from './noise.ts';
import { VIZ_GEOMETRY, VIZ_MAPPING, VIZ_QUALITY, type Quality } from './params.ts';

const f = (x: number): string => (Number.isInteger(x) ? `${x}.0` : `${x}`);
const G = VIZ_GEOMETRY;

const VERT = `
attribute vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAG = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

#define PI 3.14159265
#define TAU 6.2831853
#define MAX_ARMS ${G.MAX_ARMS}
#define MAX_BANDS ${G.MAX_BANDS}
#define EYE_R ${f(G.EYE_R)}
#define EYE_WALL_R ${f(G.EYE_WALL_R)}
#define RING_W ${f(G.RING_WIDTH)}
#define BAND_IN ${f(G.BAND_INNER_R)}
#define BAND_OUT ${f(G.BAND_OUTER_R)}
#define STORM_R ${f(G.STORM_OUTER_R)}
#define PULSE_GAIN ${f(VIZ_MAPPING.PULSE_GAIN)}

uniform vec2 u_res;
uniform float u_radius;
uniform sampler2D u_noise;

uniform float u_rot;
uniform float u_armN;
uniform float u_arm[MAX_ARMS];
uniform float u_wind;
uniform float u_bandN;
uniform float u_band[MAX_BANDS];
uniform float u_ring;
uniform float u_eye;
uniform float u_sym;
uniform float u_pulse;
uniform float u_swell;

float wrapA(float a) { return a - TAU * floor((a + PI) / TAU); }
float gauss(float x) { return exp(-x * x); }
// Static screen-space dither against banding. Depends only on pixel position.
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * u_res) / u_radius;
  p /= u_swell;
  float r = length(p);

  // Calm water: dark, still, screen-locked. Only the breath swell (scale) moves it.
  vec3 water = vec3(0.010, 0.018, 0.034);
  float rip = texture2D(u_noise, p * 0.30 + 0.5).g * 0.65 + texture2D(u_noise, p * 0.85 + 0.25).b * 0.35;
  water += vec3(0.010, 0.017, 0.026) * rip;
  water *= 1.0 - 0.45 * smoothstep(0.5, 1.9, r);

  vec3 col = water;

  // Everything below exists only inside the storm disc, and only for elements that are present.
  // The branches depend on uniforms or on smooth regions of the screen, so they stay coherent.
  if (r < 1.12) {
    // The storm's rotating frame.
    float c = cos(u_rot), s = sin(u_rot);
    vec2 q = vec2(c * p.x + s * p.y, -s * p.x + c * p.y);
    float side = clamp(p.x / 0.04, -1.0, 1.0);
    float detail = texture2D(u_noise, q * 1.1 + 0.3).g;

    // Spiral arms (logarithmic spiral theta = a0 + b ln r; the spiral form is a design choice).
    float arms = 0.0;
    if (u_armN > 0.0) {
      float theta = atan(q.y, q.x) + 0.5 * side * u_sym;
      float lr = log(max(r, 1e-4));
      float sigma = 0.55 * PI / max(u_armN, 2.0);
      float inv2s2 = 1.0 / (2.0 * sigma * sigma);
      float env = smoothstep(EYE_R * 0.8, EYE_WALL_R * 1.8, r) * (1.0 - smoothstep(0.45, STORM_R, r));
      float bestW = 0.0;
      float bestD = 0.0;
      float bestI = 0.0;
      for (int i = 0; i < MAX_ARMS; i++) {
        float fi = float(i);
        float pres = clamp(u_armN - fi, 0.0, 1.0);
        if (pres <= 0.0) break;
        float a0 = TAU * fi / max(u_armN, 1.0);
        float d = wrapA(theta - u_wind * lr - a0);
        float w = pres * exp(-d * d * inv2s2);
        arms += w * u_arm[i];
        if (w > bestW) { bestW = w; bestD = d; bestI = fi; }
      }
      // Cloud streaks along the nearest arm, fixed in the rotating frame.
      float streak = texture2D(u_noise, vec2(bestD * 1.6 + bestI * 0.37, lr * 0.22 + bestI * 0.11)).r;
      arms *= env * mix(0.35, 1.3, streak) * mix(0.7, 1.15, detail);
    }

    // Unorganized bands of cloud: one per confirmed track that is not an arm. No spiral.
    float bands = 0.0;
    if (u_bandN > 0.0) {
      float nb = max(u_bandN, 1.0);
      for (int j = 0; j < MAX_BANDS; j++) {
        float fj = float(j);
        float pres = clamp(u_bandN - fj, 0.0, 1.0);
        if (pres <= 0.0) break;
        float rj = BAND_IN + (BAND_OUT - BAND_IN) * (fj + 0.5) / nb;
        bands += pres * u_band[j] * gauss((r - rj) / 0.06);
      }
      float patchy = texture2D(u_noise, q * 0.55 + 0.21).r * 0.75 + detail * 0.4;
      bands *= smoothstep(0.38, 0.8, patchy) * (1.0 - smoothstep(0.85, 1.05, r));
    }

    // Octave rings: thin, smooth, warm. Deliberately unlike the cloud arms.
    float ringv = 0.0;
    if (u_ring > 0.0) {
      ringv = gauss((r - ${f(G.RING_RADII[0])}) / RING_W) + gauss((r - ${f(G.RING_RADII[1])}) / RING_W)
            + gauss((r - ${f(G.RING_RADII[2])}) / RING_W) * 0.8;
      ringv *= u_ring * (0.85 + 0.2 * texture2D(u_noise, q * 2.3).b);
    }

    // The eye: clears with the cascade's measured hold time. The eye wall carries the heartbeat.
    float eyeMask = 1.0 - u_eye * (1.0 - smoothstep(EYE_R * 0.5, EYE_R * 1.05, r));
    float wall = gauss((r - EYE_WALL_R) / 0.032);
    float wallV = wall * (0.5 * u_eye * (0.8 + 0.3 * detail) + PULSE_GAIN * u_pulse);

    float cloud = (arms + bands * 0.85) * eyeMask;
    float cc = clamp(cloud, 0.0, 1.0);
    vec3 cloudCol = mix(vec3(0.26, 0.34, 0.48), vec3(0.84, 0.89, 0.96), cc);
    col = water * (1.0 - 0.6 * cc) + cloudCol * cloud * 0.8;
    col += vec3(0.95, 0.72, 0.45) * ringv * 0.55;
    col += mix(vec3(0.70, 0.82, 1.0), vec3(1.0, 0.70, 0.66), clamp(u_pulse, 0.0, 1.0)) * wallV * 0.7;
  }

  col = 1.0 - exp(-col * 1.3);
  col += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}
`;

export type RendererApi = 'webgl2' | 'webgl1';

interface GlState {
  gl: WebGLRenderingContext | WebGL2RenderingContext;
  program: WebGLProgram;
  loc: Record<string, WebGLUniformLocation | null>;
}

const UNIFORM_NAMES = [
  'u_res', 'u_radius', 'u_noise', 'u_rot', 'u_armN', 'u_arm', 'u_wind', 'u_bandN', 'u_band',
  'u_ring', 'u_eye', 'u_sym', 'u_pulse', 'u_swell',
] as const;

/** Storm radius as a fraction of the shorter side of the canvas. */
export const STORM_RADIUS_FRACTION = 0.46;

export class HurricaneRenderer {
  readonly canvas: HTMLCanvasElement;
  api: RendererApi | null = null;
  /** True while the WebGL context is lost. Drawing is skipped until it is restored. */
  lost = false;
  /** CPU time of the last draw call submission, ms. */
  lastSubmitMs = 0;
  /** Number of draws actually issued (skipped redraws are not counted). */
  drawCount = 0;

  private st: GlState | null = null;
  private quality: Quality;
  private lastKey = '';
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private readonly onLost: (e: Event) => void;
  private readonly onRestored: () => void;

  constructor(canvas: HTMLCanvasElement, quality: Quality = 'medium') {
    this.canvas = canvas;
    this.quality = quality;
    this.onLost = (e: Event) => {
      e.preventDefault();
      this.lost = true;
      this.st = null;
    };
    this.onRestored = () => {
      this.lost = false;
      this.init();
      this.lastKey = '';
    };
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
    this.init();
  }

  /** Whether a WebGL context could be created. */
  get ok(): boolean {
    return this.st !== null;
  }

  private init(): void {
    const attrs: WebGLContextAttributes = {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'low-power',
    };
    let gl: WebGLRenderingContext | WebGL2RenderingContext | null = this.canvas.getContext('webgl2', attrs);
    this.api = gl ? 'webgl2' : null;
    if (!gl) {
      gl = this.canvas.getContext('webgl', attrs);
      this.api = gl ? 'webgl1' : null;
    }
    if (!gl) {
      this.st = null;
      return;
    }
    const program = link(gl, VERT, FRAG);
    gl.useProgram(program);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const aPos = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, NOISE_SIZE, NOISE_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, cloudTexture());
    gl.generateMipmap(gl.TEXTURE_2D);
    // Trilinear filtering: rotating fine texture must not shimmer (photosensitivity).
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

    const loc: Record<string, WebGLUniformLocation | null> = {};
    for (const n of UNIFORM_NAMES) loc[n] = gl.getUniformLocation(program, n);
    gl.uniform1i(loc.u_noise, 0);
    this.st = { gl, program, loc };
    this.applySize();
  }

  setQuality(q: Quality): void {
    if (q === this.quality) return;
    this.quality = q;
    this.applySize();
  }

  /** Set the CSS size of the canvas and the device pixel ratio. */
  resize(cssW: number, cssH: number, dpr: number): void {
    this.cssW = Math.max(1, Math.floor(cssW));
    this.cssH = Math.max(1, Math.floor(cssH));
    this.dpr = dpr;
    this.applySize();
  }

  /** The backing-store scale actually used: device pixel ratio capped by the quality setting. */
  renderScale(): number {
    const qs = VIZ_QUALITY[this.quality];
    let scale = Math.min(this.dpr || 1, qs.maxDpr);
    const px = this.cssW * this.cssH * scale * scale;
    if (px > qs.maxPixels) scale *= Math.sqrt(qs.maxPixels / px);
    return scale;
  }

  private applySize(): void {
    if (this.cssW === 0) return;
    const scale = this.renderScale();
    const w = Math.max(1, Math.round(this.cssW * scale));
    const h = Math.max(1, Math.round(this.cssH * scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.lastKey = '';
  }

  /**
   * Draw if anything changed since the last draw. Returns true if it drew.
   * `force` redraws regardless (after a context restore the caller need not care).
   */
  draw(u: HurricaneUniforms, force = false): boolean {
    const st = this.st;
    if (!st || this.lost) return false;
    const { gl, loc } = st;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const key = uniformKey(u, w, h);
    if (!force && key === this.lastKey) return false;
    const t0 = performance.now();
    gl.viewport(0, 0, w, h);
    gl.uniform2f(loc.u_res, w, h);
    gl.uniform1f(loc.u_radius, STORM_RADIUS_FRACTION * Math.min(w, h));
    gl.uniform1f(loc.u_rot, u.rotation);
    gl.uniform1f(loc.u_armN, u.armCount);
    gl.uniform1fv(loc.u_arm, padTo(u.armBrightness, VIZ_GEOMETRY.MAX_ARMS));
    gl.uniform1f(loc.u_wind, u.winding);
    gl.uniform1f(loc.u_bandN, u.bandCount);
    gl.uniform1fv(loc.u_band, padTo(u.bandBrightness, VIZ_GEOMETRY.MAX_BANDS));
    gl.uniform1f(loc.u_ring, u.ring);
    gl.uniform1f(loc.u_eye, u.eye);
    gl.uniform1f(loc.u_sym, u.symmetry);
    gl.uniform1f(loc.u_pulse, u.pulse);
    gl.uniform1f(loc.u_swell, u.swell);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.lastSubmitMs = performance.now() - t0;
    this.lastKey = key;
    this.drawCount++;
    return true;
  }

  /** Block until the GPU has finished, by reading back one pixel (for measuring frame cost in tests only). */
  finish(): void {
    const gl = this.st?.gl;
    if (!gl) return;
    const px = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    const st = this.st;
    if (st) {
      st.gl.deleteProgram(st.program);
      st.gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
    this.st = null;
  }
}

function padTo(a: number[], n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < Math.min(a.length, n); i++) out[i] = a[i];
  return out;
}

/** Exact key of everything that affects the picture. Float32 precision, as the GPU sees it. */
function uniformKey(u: HurricaneUniforms, w: number, h: number): string {
  const vals = [
    w, h, u.rotation, u.armCount, u.winding, u.bandCount, u.ring, u.eye, u.symmetry, u.pulse, u.swell,
    ...padTo(u.armBrightness, VIZ_GEOMETRY.MAX_ARMS), ...padTo(u.bandBrightness, VIZ_GEOMETRY.MAX_BANDS),
  ];
  return Array.from(new Float32Array(vals)).join(',');
}

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('createShader failed');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`Hurricane shader compile failed: ${log}`);
  }
  return sh;
}

function link(gl: WebGLRenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram();
  if (!p) throw new Error('createProgram failed');
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
    throw new Error(`Hurricane shader link failed: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}
