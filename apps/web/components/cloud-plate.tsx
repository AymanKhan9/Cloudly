"use client";

import { useEffect, useRef, useState } from "react";

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

// A raymarched cloud volume printed as a chromolithograph: the march yields a
// tone, a sunlit-top weight and coverage, then an ordered dither resolves them
// into four flat inks (slate, mist, chalk, rose) with a crisp crayon grain.
// uGrowth raises the tower; uGenus blends cumulus (0), altocumulus (1) and
// cirrus (2); uStretch widens the volume for wide altitude strips.
const FRAG = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform float uGrowth;
uniform float uGenus;
uniform float uStretch;
uniform float uCamY;
uniform float uZenith;
out vec4 fragColor;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float noise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
float fbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) { s += a * noise(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= 0.5; }
  return s;
}
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

float top() { return mix(0.55, 1.45, uGrowth); }

float cumulus(vec3 p, float t) {
  float h = mix(0.3, 1.1, uGrowth);
  float body = length((p - vec3(0.0, 0.32 * h, 0.0)) * vec3(0.8, 1.0 / (0.48 + 0.5 * h), 0.95)) - 0.6;
  float turret = length(p - vec3(0.1, 0.58 * h + 0.2, 0.02)) - (0.16 + 0.24 * uGrowth);
  float flankL = length(p - vec3(-0.52, 0.2 * h, 0.08)) - 0.36;
  float flankR = length(p - vec3(0.5, 0.16 * h, -0.05)) - 0.3;
  float d = smin(smin(smin(body, turret, 0.26), flankL, 0.24), flankR, 0.22);
  float n = fbm(p * 2.4 + vec3(0.0, -t * 0.05, t * 0.02));
  // Flat condensation base: density cuts off hard at the lifting level.
  float base = smoothstep(-0.01, 0.05, p.y);
  return clamp((-d * 2.6 + n * 1.2 - 0.52) * base, 0.0, 1.0);
}
// Cellular distance in the layer's plane: each cell holds one cloudlet.
float worley(vec2 q) {
  vec2 i = floor(q), f = fract(q);
  float d = 1.0;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      vec2 o = vec2(hash(vec3(i + g, 1.0)), hash(vec3(i + g, 7.0)));
      d = min(d, length(g + o * 0.8 + 0.1 - f));
    }
  return d;
}
float altocumulus(vec3 p, float t) {
  // Separate rounded cloudlets in loose rows, sky between them.
  vec2 q = vec2(p.x * 3.2 + t * 0.03, p.z * 4.4);
  float cell = worley(q);
  float puff = smoothstep(0.46, 0.16, cell);
  float thick = 0.03 + 0.09 * puff;
  float slab = 1.0 - smoothstep(0.0, thick, abs(p.y - 0.42));
  float extent = 1.0 - smoothstep(1.0, 1.5, length(p.xz * vec2(0.8, 1.2)));
  float n = fbm(p * 5.0);
  return clamp(puff * slab * extent * (1.4 + n) * (0.8 + 0.4 * uGrowth), 0.0, 1.0);
}
float cirrus(vec3 p, float t) {
  // Thin hooked filaments: ridges of a warped noise field on a thin slab.
  vec2 q = vec2(p.x * 0.9 + t * 0.04, p.z * 2.2);
  q.y += 0.35 * sin(q.x * 1.6 + 0.8 * noise(vec3(q * 0.7, 3.0)));
  float ridge = 1.0 - abs(fbm(vec3(q.x * 0.5, q.y * 3.0, 2.0)) * 2.0 - 1.0);
  float filament = pow(clamp(ridge, 0.0, 1.0), 22.0);
  float hook = smoothstep(0.35, 0.75, noise(vec3(q * 1.3, 5.0)));
  float slab = 1.0 - smoothstep(0.0, 0.05, abs(p.y - 0.85));
  float extent = 1.0 - smoothstep(1.1, 1.6, length(p.xz * vec2(0.7, 1.4)));
  return clamp(filament * (0.4 + hook) * slab * extent * 1.6, 0.0, 1.0);
}
float density(vec3 q) {
  vec3 p = vec3(q.x / uStretch, q.y, q.z);
  float t = uTime;
  float wc = clamp(1.0 - uGenus, 0.0, 1.0);
  float wa = clamp(1.0 - abs(uGenus - 1.0), 0.0, 1.0);
  float wr = clamp(uGenus - 1.0, 0.0, 1.0);
  float d = 0.0;
  if (wc > 0.001) d += wc * cumulus(p, t);
  if (wa > 0.001) d += wa * altocumulus(p, t);
  if (wr > 0.001) d += wr * cirrus(p, t);
  return d;
}

float bayer4(vec2 p) {
  ivec2 i = ivec2(mod(p, 4.0));
  int idx = i.x + i.y * 4;
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(m[idx]) + 0.5) / 16.0;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / min(uRes.x * 0.8, uRes.y);
  // Layer clouds are read the way an observer sees them: from below, looking
  // up at the underside. Edge-on, a thin slab prints as a solid ribbon.
  float wc = clamp(1.0 - uGenus, 0.0, 1.0);
  float wa = clamp(1.0 - abs(uGenus - 1.0), 0.0, 1.0);
  float wr = clamp(uGenus - 1.0, 0.0, 1.0);
  float camY = wc * uCamY + wa * 0.02 + wr * 0.2;
  float tilt = wa * 0.24 + wr * 0.34;
  vec3 ro = vec3(0.0, camY, 2.85);
  vec3 rd = normalize(vec3(uv + vec2(0.04, tilt), -1.55));
  if (uZenith > 0.5) {
    // Looking straight up, the way layer cloud is photographed for an atlas.
    ro = vec3(0.0, -0.6, 0.0);
    rd = normalize(vec3(uv.x, 1.6, uv.y));
  }
  vec3 sun = normalize(vec3(0.6, 0.72, 0.34));

  vec3 bmin = vec3(-1.8 * uStretch, -0.05, -1.4), bmax = vec3(1.8 * uStretch, 1.7, 1.4);
  vec3 t0 = (bmin - ro) / rd, t1 = (bmax - ro) / rd;
  vec3 tmin = min(t0, t1), tmax = max(t0, t1);
  float tn = max(max(tmin.x, tmin.y), tmin.z);
  float tf = min(min(tmax.x, tmax.y), tmax.z);
  if (tf < max(tn, 0.0)) { fragColor = vec4(0.0); return; }

  const int STEPS = 56;
  float dt = (tf - max(tn, 0.0)) / float(STEPS);
  float t = max(tn, 0.0) + dt * hash(vec3(gl_FragCoord.xy, 0.0));
  float trans = 1.0;
  float tone = 0.0;
  float sunTop = 0.0;
  float ceiling = top();

  for (int i = 0; i < STEPS; i++) {
    vec3 p = ro + rd * t;
    float d = density(p);
    if (d > 0.01) {
      float ld = 0.0;
      for (int j = 1; j <= 5; j++) ld += density(p + sun * 0.1 * float(j));
      float light = exp(-ld * 1.15);
      float a = 1.0 - exp(-d * dt * 10.0);
      float lit = clamp(light * 0.92 + 0.08, 0.0, 1.0);
      float high = smoothstep(ceiling * 0.45, ceiling * 0.9, p.y);
      tone += trans * a * lit;
      sunTop += trans * a * lit * high;
      trans *= 1.0 - a;
      if (trans < 0.03) break;
    }
    t += dt;
  }

  float cover = 1.0 - trans;
  float th = bayer4(gl_FragCoord.xy);
  // Coverage resolves to ink or bare sky, with a stippled edge.
  if (cover < mix(0.12, 0.42, th)) { fragColor = vec4(0.0); return; }
  float v = tone / max(cover, 1e-3);
  float warm = sunTop / max(cover, 1e-3);

  vec3 slate = vec3(0.325, 0.384, 0.478);
  vec3 mist = vec3(0.624, 0.690, 0.800);
  vec3 chalk = vec3(0.933, 0.949, 0.969);
  vec3 rose = vec3(0.910, 0.725, 0.651);

  float s = v + (th - 0.5) * 0.22;
  vec3 ink = s < 0.34 ? slate : (s < 0.62 ? mist : chalk);
  // Rose is reserved for sunlit cumulus tops.
  if (s >= 0.62 && warm * wc + (th - 0.5) * 0.25 > 0.5) ink = rose;
  if (wr > 0.5) ink = cover + (th - 0.5) * 0.2 > 0.8 ? chalk : mist;
  fragColor = vec4(ink, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) ?? "shader compile failed");
  }
  return shader;
}

interface CloudPlateProps {
  growth: number;
  genus: number;
  label?: string;
  /** Widen the volume for wide strips (aspect / 1.6 is a good start). */
  stretch?: number;
  camY?: number;
  /** Ink dot size in CSS pixels; 2 gives a lithographic crayon grain. */
  grain?: number;
  /** Look straight up at the layer instead of across it (wide layer strips). */
  zenith?: boolean;
}

export function CloudPlate({ growth, genus, label = "Cloud", stretch = 1, camY = 0.46, grain = 2, zenith = false }: CloudPlateProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const target = useRef({ growth, genus });
  const [failed, setFailed] = useState(false);

  target.current = { growth, genus };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, alpha: true, antialias: false });
    if (!gl) {
      setFailed(true);
      return;
    }

    let program: WebGLProgram;
    try {
      program = gl.createProgram()!;
      gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
      gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "link failed");
    } catch (err) {
      console.error("cloud plate:", err);
      setFailed(true);
      return;
    }

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.useProgram(program);

    const u = (name: string) => gl.getUniformLocation(program, name);
    const uRes = u("uRes");
    const uTime = u("uTime");
    const uGrowth = u("uGrowth");
    const uGenus = u("uGenus");
    gl.uniform1f(u("uStretch"), stretch);
    gl.uniform1f(u("uCamY"), camY);
    gl.uniform1f(u("uZenith"), zenith ? 1 : 0);

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const current = { ...target.current };
    let visible = true;
    let raf = 0;
    let last = performance.now();
    let time = 12.0;

    const resize = () => {
      const w = Math.max(1, Math.round(canvas.clientWidth / grain));
      const h = Math.max(1, Math.round(canvas.clientHeight / grain));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
    };

    const draw = () => {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, time);
      gl.uniform1f(uGrowth, current.growth);
      gl.uniform1f(uGenus, current.genus);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    // The print redraws a few times a second rather than every frame: the
    // drift is slow, and a lithograph that shimmers at 60fps stops reading as ink.
    let sinceDraw = 1;
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!reduced) time += dt;
      const k = 1 - Math.exp(-dt * 2.4);
      current.growth += (target.current.growth - current.growth) * k;
      current.genus += (target.current.genus - current.genus) * k;
      sinceDraw += dt;
      const settling =
        Math.abs(target.current.growth - current.growth) > 0.002 ||
        Math.abs(target.current.genus - current.genus) > 0.002;
      if (sinceDraw > (settling ? 1 / 24 : 1 / 8)) {
        resize();
        draw();
        sinceDraw = 0;
      }
      if (visible && (!reduced || settling)) raf = requestAnimationFrame(frame);
      else raf = 0;
    };

    const start = () => {
      if (!raf && visible && !document.hidden) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };

    const io = new IntersectionObserver(([entry]) => {
      visible = Boolean(entry?.isIntersecting);
      if (visible) start();
    });
    io.observe(canvas);

    const onVisibility = () => (document.hidden ? (cancelAnimationFrame(raf), (raf = 0)) : start());
    document.addEventListener("visibilitychange", onVisibility);

    // A still frame without rAF: background tabs, link-preview renderers and
    // reduced motion never get animation frames but should still show a cloud.
    const drawStill = () => {
      current.growth = target.current.growth;
      current.genus = target.current.genus;
      resize();
      draw();
    };
    let lastDrawn = "";
    const poke = window.setInterval(() => {
      if (raf) return;
      const key = `${target.current.growth.toFixed(3)}:${target.current.genus}`;
      if (document.hidden || reduced) {
        if (key !== lastDrawn) {
          drawStill();
          lastDrawn = key;
        }
      } else {
        start();
      }
    }, 400);

    drawStill();
    start();
    return () => {
      cancelAnimationFrame(raf);
      window.clearInterval(poke);
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      gl.deleteProgram(program);
      gl.deleteBuffer(buf);
    };
  }, [stretch, camY, grain, zenith]);

  return (
    <>
      <canvas ref={canvasRef} role="img" aria-label={label} className="litho" />
      {failed ? <div className="plate-fallback">This plate needs WebGL 2.</div> : null}
    </>
  );
}
