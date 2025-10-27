import { Program, Mesh, Triangle, Color } from "ogl";
import React, { useEffect, useRef, useMemo, useCallback } from "react";
import { createRenderer, subscribeTicker } from "./_sharedGL";

type Vec2 = [number, number];

export interface FaultyTerminalProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "color"> {
  scale?: number;
  gridMul?: Vec2;
  digitSize?: number;
  timeScale?: number;
  pause?: boolean;
  scanlineIntensity?: number;
  glitchAmount?: number;
  flickerAmount?: number;
  noiseAmp?: number;
  chromaticAberration?: number;
  dither?: number | boolean;
  curvature?: number;
  tint?: string;
  mouseReact?: boolean;
  mouseStrength?: number;
  pageLoadAnimation?: boolean;
  brightness?: number;
}

const vtx = `
attribute vec2 position;
attribute vec2 uv;
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position,0.,1.); }
`;

// (фрагмент шейдер — как у тебя; без изменений по логике)
const frg = `precision mediump float;
varying vec2 vUv;
uniform float iTime;
uniform vec3  iResolution;
uniform float uScale;
uniform vec2  uGridMul;
uniform float uDigitSize;
uniform float uScanlineIntensity;
uniform float uGlitchAmount;
uniform float uFlickerAmount;
uniform float uNoiseAmp;
uniform float uChromaticAberration;
uniform float uDither;
uniform float uCurvature;
uniform vec3  uTint;
uniform vec2  uMouse;
uniform float uMouseStrength;
uniform float uUseMouse;
uniform float uPageLoadProgress;
uniform float uUsePageLoadAnimation;
uniform float uBrightness;
float time;
float hash21(vec2 p){ p=fract(p*234.56); p+=dot(p,p+34.56); return fract(p.x*p.y); }
float noise(vec2 p){ return sin(p.x*10.)*sin(p.y*(3.+sin(time*0.090909)))+0.2; }
mat2 rotate(float a){ float c=cos(a),s=sin(a); return mat2(c,-s,s,c); }
float fbm(vec2 p){
  p*=1.1; float f=0., amp=0.5*uNoiseAmp;
  mat2 m0=rotate(time*0.02); f+=amp*noise(p); p=m0*p*2.; amp*=.454545;
  mat2 m1=rotate(time*0.02); f+=amp*noise(p); p=m1*p*2.; amp*=.454545;
  mat2 m2=rotate(time*0.08); f+=amp*noise(p);
  return f;
}
float pattern(vec2 p, out vec2 q, out vec2 r){
  vec2 o1=vec2(1.), o0=vec2(0.);
  mat2 r01=rotate(0.1*time), r1=rotate(0.1);
  q=vec2(fbm(p+o1), fbm(r01*p+o1));
  r=vec2(fbm(r1*q+o0), fbm(q+o0));
  return fbm(p+r);
}
float digit(vec2 p){
  vec2 grid=uGridMul*15.0;
  vec2 s=floor(p*grid)/grid;
  p=p*grid;
  vec2 q,r; float intensity=pattern(s*0.1,q,r)*1.3-0.03;
  if(uUseMouse>0.5){
    vec2 mouseWorld=uMouse*uScale;
    float dist=distance(s,mouseWorld);
    float mouseInf=exp(-dist*8.)*uMouseStrength*10.;
    intensity+=mouseInf;
    float ripple=sin(dist*20.-iTime*5.)*0.1*mouseInf;
    intensity+=ripple;
  }
  if(uUsePageLoadAnimation>0.5){
    float cellRandom=fract(sin(dot(s,vec2(12.9898,78.233)))*43758.5453);
    float cellDelay=cellRandom*0.8;
    float cellProgress=clamp((uPageLoadProgress-cellDelay)/0.2,0.,1.);
    float fadeAlpha=smoothstep(0.,1.,cellProgress);
    intensity*=fadeAlpha;
  }
  p=fract(p); p*=uDigitSize;
  float px5=p.x*5., py5=(1.-p.y)*5.;
  float x=fract(px5), y=fract(py5);
  float i=floor(py5)-2., j=floor(px5)-2.;
  float n=i*i+j*j; float f=n*0.0625;
  float isOn=step(0.1, intensity - f);
  float brightness=isOn*(0.2+y*0.8)*(0.75+x*0.25);
  return step(0.,p.x)*step(p.x,1.)*step(0.,p.y)*step(p.y,1.)*brightness;
}
float onOff(float a,float b,float c){ return step(c, sin(iTime + a*cos(iTime*b))) * uFlickerAmount; }
float displace(vec2 look){
  float y=look.y - mod(iTime*0.25,1.0);
  float window=1.0/(1.0+50.0*y*y);
  return sin(look.y*20.0+iTime)*0.0125*onOff(4.0,2.0,0.8)*(1.0+cos(iTime*60.0))*window;
}
vec3 getColor(vec2 p){
  float bar = step(mod(p.y+time*20.0,1.0),0.2)*0.4+1.0;
  bar*=uScanlineIntensity;
  float disp=displace(p);
  p.x+=disp;
  if(uGlitchAmount!=1.0){ float extra=disp*(uGlitchAmount-1.0); p.x+=extra; }
  float middle=digit(p);
  const float off=0.002;
  float sum = digit(p+vec2(-off,-off))+digit(p+vec2(0.,-off))+digit(p+vec2(off,-off))
            + digit(p+vec2(-off,0.))+digit(p+vec2(0.,0.))+digit(p+vec2(off,0.))
            + digit(p+vec2(-off,off))+digit(p+vec2(0.,off))+digit(p+vec2(off,off));
  vec3 base = vec3(0.9)*middle + sum*0.1*vec3(1.0)*bar;
  return base;
}
vec2 barrel(vec2 uv){
  vec2 c=uv*2.0-1.0;
  float r2=dot(c,c);
  c*=1.0 + uCurvature*r2;
  return c*0.5+0.5;
}
void main(){
  time = iTime*0.333333;
  vec2 uv=vUv;
  if(uCurvature!=0.0){ uv=barrel(uv); }
  vec2 p=uv*uScale;
  vec3 col=getColor(p);
  if(uChromaticAberration!=0.0){
    vec2 ca = vec2(uChromaticAberration)/iResolution.xy;
    col.r = getColor(p+ca).r;
    col.b = getColor(p-ca).b;
  }
  col*=uTint; col*=uBrightness;
  if(uDither>0.0){
    float rnd=hash21(gl_FragCoord.xy);
    col += (rnd-0.5) * (uDither*0.003922);
  }
  gl_FragColor = vec4(col,1.0);
}
`;

function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const num = parseInt(h, 16);
  return [((num>>16)&255)/255, ((num>>8)&255)/255, (num&255)/255];
}

export default function FaultyTerminal({
  scale = 1,
  gridMul = [2, 1],
  digitSize = 1.5,
  timeScale = 0.3,
  pause = false,
  scanlineIntensity = 0.3,
  glitchAmount = 1,
  flickerAmount = 1,
  noiseAmp = 1,
  chromaticAberration = 0,
  dither = 0,
  curvature = 0.2,
  tint = "#ffffff",
  mouseReact = true,
  mouseStrength = 0.2,
  pageLoadAnimation = true,
  brightness = 1,
  className,
  style,
  ...rest
}: FaultyTerminalProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const { renderer, gl, cleanup } = createRenderer(el, { transparent: true, dprCap: 2 });
    const geometry = new Triangle(gl);

    const tintVec = hexToRgb(tint);
    const ditherValue = typeof dither === "boolean" ? (dither ? 1 : 0) : dither;

    const iResolution = new Color(gl.drawingBufferWidth, gl.drawingBufferHeight, gl.drawingBufferWidth/Math.max(1, gl.drawingBufferHeight));
    const uMouse = new Float32Array([0.5, 0.5]);

    const program = new Program(gl, {
      vertex: vtx,
      fragment: frg,
      uniforms: {
        iTime: { value: 0 },
        iResolution: { value: iResolution },
        uScale: { value: scale },
        uGridMul: { value: new Float32Array(gridMul) },
        uDigitSize: { value: digitSize },
        uScanlineIntensity: { value: scanlineIntensity },
        uGlitchAmount: { value: glitchAmount },
        uFlickerAmount: { value: flickerAmount },
        uNoiseAmp: { value: noiseAmp },
        uChromaticAberration: { value: chromaticAberration },
        uDither: { value: ditherValue },
        uCurvature: { value: curvature },
        uTint: { value: new Color(tintVec[0], tintVec[1], tintVec[2]) },
        uMouse: { value: uMouse },
        uMouseStrength: { value: mouseStrength },
        uUseMouse: { value: mouseReact ? 1 : 0 },
        uPageLoadProgress: { value: pageLoadAnimation ? 0 : 1 },
        uUsePageLoadAnimation: { value: pageLoadAnimation ? 1 : 0 },
        uBrightness: { value: brightness },
      },
      transparent: true,
    });

    const mesh = new Mesh(gl, { geometry, program });

    let startProgressTs = 0;
    const unsub = subscribeTicker((now) => {
      // время
      const t = now * 0.001 * timeScale;
      (program.uniforms.iTime.value as number) = pause ? (program.uniforms.iTime.value as number) : t;

      // страничная анимация появления
      if (pageLoadAnimation) {
        if (!startProgressTs) startProgressTs = now;
        const dur = 2000;
        const progress = Math.min((now - startProgressTs) / dur, 1);
        (program.uniforms.uPageLoadProgress.value as number) = progress;
      }

      // резолюция
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      if (iResolution.r !== w || iResolution.g !== h) {
        iResolution.r = w; iResolution.g = h; iResolution.b = w/Math.max(1,h);
      }

      renderer.render({ scene: mesh });
    });

    const onMove = (e: MouseEvent) => {
      if (!mouseReact) return;
      const r = el.getBoundingClientRect();
      uMouse[0] = (e.clientX - r.left)/r.width;
      uMouse[1] = 1 - (e.clientY - r.top)/r.height;
    };
    if (mouseReact) el.addEventListener("mousemove", onMove);

    return () => {
      unsub();
      if (mouseReact) el.removeEventListener("mousemove", onMove);
      cleanup();
    };
  }, [
    scale, gridMul, digitSize, timeScale, pause,
    scanlineIntensity, glitchAmount, flickerAmount, noiseAmp,
    chromaticAberration, dither, curvature, tint, mouseReact, mouseStrength,
    pageLoadAnimation, brightness,
  ]);

  return <div ref={ref} className={`w-full h-full relative ${className??""}`} style={style} {...rest} />;
}