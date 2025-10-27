//home/ogma/ogma/ogma-webapp/src/components/backgrounds/LiquidChrome.tsx
import React, { useEffect, useRef } from "react";
import { Program, Mesh, Triangle } from "ogl";
import { createRenderer, subscribeTicker } from "./_sharedGL";

interface LiquidChromeProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "color"> {
  baseColor?: [number, number, number];
  speed?: number;
  amplitude?: number;
  frequencyX?: number;
  frequencyY?: number;
  interactive?: boolean;
}

const vtx = `
attribute vec2 position;
attribute vec2 uv;
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position,0.,1.); }
`;

/* Шейдер c стабилизацией яркости и адаптивным суперсэмплингом */
const frg = `
precision highp float;
uniform float uTime;
uniform vec3  uRes;     // (w,h,aspect)
uniform vec3  uBase;    // базовый цвет
uniform float uAmp;
uniform float uFx;
uniform float uFy;
uniform vec2  uMouse;
uniform int   uQuality; // 1, 3 или 9

varying vec2 vUv;

vec4 renderImage(vec2 uvCoord){
  vec2 frag = uvCoord * uRes.xy;
  vec2 uv = (2.0 * frag - uRes.xy) / min(uRes.x, uRes.y);

  for(float i=1.0;i<10.0;i+=1.0){
    uv.x += uAmp/i * cos(i*uFx*uv.y + uTime + uMouse.x*3.14159);
    uv.y += uAmp/i * cos(i*uFy*uv.x + uTime + uMouse.y*3.14159);
  }

  vec2 diff = (uvCoord - uMouse);
  float dist = length(diff);
  float fall = exp(-dist*20.0);
  float rip  = sin(10.0*dist - uTime*2.0) * 0.03;
  uv += (diff/(dist+0.0001)) * rip * fall;

  float denom = max(abs(sin(uTime - uv.y - uv.x)), 0.15);
  vec3  col   = uBase / denom;
  col = clamp(col, 0.0, 2.2);

  return vec4(col, 1.0);
}

void main(){
  if (uQuality <= 1) {
    gl_FragColor = renderImage(vUv);
    return;
  }

  vec4 sum = vec4(0.0);
  float off = 1.0 / min(uRes.x, uRes.y);

  if (uQuality == 3) {
    sum += renderImage(vUv);
    sum += renderImage(vUv + vec2(+off, +off));
    sum += renderImage(vUv + vec2(-off, -off));
    gl_FragColor = sum / 3.0;
  } else {
    for(int i=-1;i<=1;i++){
      for(int j=-1;j<=1;j++){
        vec2 o = vec2(float(i), float(j)) * off;
        sum += renderImage(vUv + o);
      }
    }
    gl_FragColor = sum / 9.0;
  }
}
`;

export const LiquidChrome: React.FC<LiquidChromeProps> = ({
  baseColor = [0.1, 0.1, 0.1],
  speed = 0.2,
  amplitude = 0.5,
  frequencyX = 3,
  frequencyY = 2,
  interactive = true,
  className,
  style,
  ...props
}) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const { renderer, gl, cleanup } = createRenderer(el, { transparent: true, dprCap: 2 });
    const geometry = new Triangle(gl);

    const uRes = new Float32Array([
      gl.drawingBufferWidth,
      gl.drawingBufferHeight,
      gl.drawingBufferWidth / Math.max(1, gl.drawingBufferHeight),
    ]);
    const uBase = new Float32Array(baseColor);
    const uMouse = new Float32Array([0.5, 0.5]);
    const uQuality = { value: 1 };

    const program = new Program(gl, {
      vertex: vtx,
      fragment: frg,
      uniforms: {
        uTime: { value: 0 },
        uRes: { value: uRes },
        uBase: { value: uBase },
        uAmp: { value: amplitude },
        uFx: { value: frequencyX },
        uFy: { value: frequencyY },
        uMouse: { value: uMouse },
        uQuality,
      },
      transparent: true,
    });

    const mesh = new Mesh(gl, { geometry, program });

    // видимость — не рендерим, когда вне вьюпорта
    let visible = true;
    const io = new IntersectionObserver((entries) => {
      visible = entries[0]?.isIntersecting ?? true;
    }, { threshold: 0 });
    io.observe(el);

    // сглаживание мыши
    let targetMouseX = 0.5, targetMouseY = 0.5;
    const onMove = (e: MouseEvent) => {
      if (!interactive) return;
      const r = el.getBoundingClientRect();
      targetMouseX = (e.clientX - r.left) / Math.max(1, r.width);
      targetMouseY = 1 - (e.clientY - r.top) / Math.max(1, r.height);
    };
    if (interactive) el.addEventListener("mousemove", onMove);

    // эвристика качества
    const reduced = matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    const chooseQuality = () => {
      if (reduced) return 1;
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const minSide = Math.min(w, h);
      const isHiDPR = (window.devicePixelRatio || 1) > 1.5;
      if (minSide <= 480 || isHiDPR) return 1;
      if (minSide <= 900) return 3;
      return 9;
    };
    uQuality.value = chooseQuality();

    let lastW = uRes[0], lastH = uRes[1];
    let t0 = 0;

    const unsub = subscribeTicker((_, now) => {
      if (!visible) return;
      if (!t0) t0 = now;
      program.uniforms.uTime.value = (now - t0) * speed;

      // плавная мышь
      const k = 0.12;
      uMouse[0] += (targetMouseX - uMouse[0]) * k;
      uMouse[1] += (targetMouseY - uMouse[1]) * k;

      // резолюция только при реальном изменении
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      if (w !== lastW || h !== lastH) {
        lastW = w; lastH = h;
        uRes[0] = w; uRes[1] = h; uRes[2] = w / Math.max(1, h);
        uQuality.value = chooseQuality();
      }

      renderer.render({ scene: mesh });
    });

    return () => {
      unsub();
      io.disconnect();
      if (interactive) el.removeEventListener("mousemove", onMove);
      cleanup();
    };
  }, [baseColor, speed, amplitude, frequencyX, frequencyY, interactive]);

  return <div ref={ref} className={`w-full h-full relative ${className ?? ""}`} style={style} {...props} />;
};

export default LiquidChrome;