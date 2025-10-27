import { Renderer, Program, Mesh, Triangle, Color } from "ogl";
import { useEffect, useRef } from "react";
import { createRenderer, subscribeTicker } from "./_sharedGL";

const vertexShader = `
attribute vec2 uv;
attribute vec2 position;
varying vec2 vUv;
void main(){ vUv=uv; gl_Position=vec4(position,0.,1.); }
`;

const fragmentShader = `/* твой шейдер без изменений логики — как присылал ранее */ 
precision highp float;
uniform float uTime;
uniform vec3  uResolution;
uniform vec2  uFocal;
uniform vec2  uRotation;
uniform float uStarSpeed;
uniform float uDensity;
uniform float uHueShift;
uniform float uSpeed;
uniform vec2  uMouse;
uniform float uGlowIntensity;
uniform float uSaturation;
uniform bool  uMouseRepulsion;
uniform float uTwinkleIntensity;
uniform float uRotationSpeed;
uniform float uRepulsionStrength;
uniform float uMouseActiveFactor;
uniform float uAutoCenterRepulsion;
uniform bool  uTransparent;
varying vec2 vUv;
#define NUM_LAYER 4.0
#define STAR_COLOR_CUTOFF 0.2
#define MAT45 mat2(0.7071,-0.7071,0.7071,0.7071)
#define PERIOD 3.0
/* ... весь твой код Star/StarLayer/... без изменений ... */
float Hash21(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float tri(float x){ return abs(fract(x)*2.0-1.0); }
float tris(float x){ float t=fract(x); return 1.0-smoothstep(0.0,1.0,abs(2.0*t-1.0)); }
float trisn(float x){ float t=fract(x); return 2.0*(1.0-smoothstep(0.0,1.0,abs(2.0*t-1.0)))-1.0; }
vec3 hsv2rgb(vec3 c){ vec4 K=vec4(1.0,2.0/3.0,1.0/3.0,3.0); vec3 p=abs(fract(c.xxx+K.xyz)*6.0-K.www); return c.z*mix(K.xxx, clamp(p-K.xxx,0.0,1.0), c.y); }
float Star(vec2 uv,float flare){ float d=length(uv); float m=(0.05*uGlowIntensity)/d; float rays=smoothstep(0.0,1.0,1.0-abs(uv.x*uv.y*1000.0)); m+=rays*flare*uGlowIntensity; uv*=MAT45; rays=smoothstep(0.0,1.0,1.0-abs(uv.x*uv.y*1000.0)); m+=rays*0.3*flare*uGlowIntensity; m*=smoothstep(1.0,0.2,d); return m; }
vec3 StarLayer(vec2 uv){
  vec3 col=vec3(0.0);
  vec2 gv=fract(uv)-0.5; vec2 id=floor(uv);
  for(int y=-1;y<=1;y++){ for(int x=-1;x<=1;x++){
    vec2 offset=vec2(float(x),float(y)); vec2 si=id+offset;
    float seed=Hash21(si);
    float size=fract(seed*345.32);
    float glossLocal=tri(uStarSpeed/(PERIOD*seed+1.0));
    float flareSize=smoothstep(0.9,1.0,size)*glossLocal;
    float red=smoothstep(STAR_COLOR_CUTOFF,1.0,Hash21(si+1.0))+STAR_COLOR_CUTOFF;
    float blu=smoothstep(STAR_COLOR_CUTOFF,1.0,Hash21(si+3.0))+STAR_COLOR_CUTOFF;
    float grn=min(red,blu)*seed;
    vec3 base=vec3(red,grn,blu);
    float hue=atan(base.g-base.r, base.b-base.r)/(2.0*3.14159)+0.5;
    hue=fract(hue + uHueShift/360.0);
    float sat=length(base - vec3(dot(base, vec3(0.299,0.587,0.114))))*uSaturation;
    float val=max(max(base.r,base.g),base.b);
    base=hsv2rgb(vec3(hue,sat,val));
    vec2 pad=vec2(tris(seed*34.0 + uTime*uSpeed/10.0), tris(seed*38.0 + uTime*uSpeed/30.0)) - 0.5;
    float star=Star(gv - offset - pad, flareSize);
    vec3 color=base;
    float tw=trisn(uTime*uSpeed + seed*6.2831)*0.5 + 1.0;
    tw = mix(1.0, tw, uTwinkleIntensity);
    star*=tw; col += star*size*color;
  }}
  return col;
}
void main(){
  vec2 focalPx = uFocal * uResolution.xy;
  vec2 uv = (vUv*uResolution.xy - focalPx)/uResolution.y;
  vec2 mouseNorm = uMouse - vec2(0.5);
  if(uAutoCenterRepulsion>0.0){
    vec2 c=vec2(0.0); float d=length(uv-c);
    vec2 rep=normalize(uv-c)*(uAutoCenterRepulsion/(d+0.1)); uv += rep*0.05;
  } else if (uMouseRepulsion){
    vec2 mp=(uMouse*uResolution.xy - focalPx)/uResolution.y;
    float d=length(uv-mp);
    vec2 rep=normalize(uv-mp)*(uRepulsionStrength/(d+0.1)); uv += rep*0.05*uMouseActiveFactor;
  } else {
    vec2 mo=mouseNorm*0.1*uMouseActiveFactor; uv+=mo;
  }
  float a = uTime * uRotationSpeed;
  mat2 rot = mat2(cos(a), -sin(a), sin(a), cos(a)); uv = rot*uv;
  uv = mat2(uRotation.x, -uRotation.y, uRotation.y, uRotation.x) * uv;
  vec3 col=vec3(0.0);
  for(float i=0.0;i<1.0;i+=1.0/NUM_LAYER){
    float depth=fract(i + uStarSpeed*uSpeed);
    float scale=mix(20.0*uDensity, 0.5*uDensity, depth);
    float fade = depth*smoothstep(1.0,0.9,depth);
    col += StarLayer(uv*scale + i*453.32) * fade;
  }
  if (uTransparent){
    float alpha=length(col); alpha=smoothstep(0.0,0.3,alpha); alpha=min(alpha,1.0);
    gl_FragColor = vec4(col, alpha);
  } else { gl_FragColor=vec4(col,1.0); }
}
`;

interface GalaxyProps extends React.HTMLAttributes<HTMLDivElement> {
  focal?: [number, number];
  rotation?: [number, number];
  starSpeed?: number;
  density?: number;
  hueShift?: number;
  disableAnimation?: boolean;
  speed?: number;
  mouseInteraction?: boolean;
  glowIntensity?: number;
  saturation?: number;
  mouseRepulsion?: boolean;
  twinkleIntensity?: number;
  rotationSpeed?: number;
  repulsionStrength?: number;
  autoCenterRepulsion?: number;
  transparent?: boolean;
}

export default function Galaxy({
  focal = [0.5, 0.5],
  rotation = [1.0, 0.0],
  starSpeed = 0.5,
  density = 1,
  hueShift = 140,
  disableAnimation = false,
  speed = 1.0,
  mouseInteraction = true,
  glowIntensity = 0.3,
  saturation = 0.0,
  mouseRepulsion = true,
  repulsionStrength = 2,
  twinkleIntensity = 0.3,
  rotationSpeed = 0.1,
  autoCenterRepulsion = 0,
  transparent = true,
  className,
  style,
  ...rest
}: GalaxyProps) {
  const ref = useRef<HTMLDivElement>(null);
  const targetMouse = useRef({ x: 0.5, y: 0.5 });
  const smoothMouse = useRef({ x: 0.5, y: 0.5 });
  const targetActive = useRef(0.0);
  const smoothActive = useRef(0.0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const { renderer, gl, cleanup } = createRenderer(el, { transparent, dprCap: 2 });
    if (transparent) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }

    const geometry = new Triangle(gl);
    const program = new Program(gl, {
      vertex: vertexShader,
      fragment: fragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uResolution: { value: new Color(gl.drawingBufferWidth, gl.drawingBufferHeight, gl.drawingBufferWidth/Math.max(1, gl.drawingBufferHeight)) },
        uFocal: { value: new Float32Array(focal) },
        uRotation: { value: new Float32Array(rotation) },
        uStarSpeed: { value: starSpeed },
        uDensity: { value: density },
        uHueShift: { value: hueShift },
        uSpeed: { value: speed },
        uMouse: { value: new Float32Array([smoothMouse.current.x, smoothMouse.current.y]) },
        uGlowIntensity: { value: glowIntensity },
        uSaturation: { value: saturation },
        uMouseRepulsion: { value: mouseRepulsion },
        uTwinkleIntensity: { value: twinkleIntensity },
        uRotationSpeed: { value: rotationSpeed },
        uRepulsionStrength: { value: repulsionStrength },
        uMouseActiveFactor: { value: 0.0 },
        uAutoCenterRepulsion: { value: autoCenterRepulsion },
        uTransparent: { value: transparent },
      },
      transparent,
    });

    const mesh = new Mesh(gl, { geometry, program });

    const unsub = subscribeTicker((now) => {
      if (!disableAnimation) {
        (program.uniforms.uTime.value as number) = now * 0.001;
        program.uniforms.uStarSpeed.value = (now * 0.001 * starSpeed) / 10.0;
      }
      // сглаживание мыши
      const k = 0.08;
      smoothMouse.current.x += (targetMouse.current.x - smoothMouse.current.x) * k;
      smoothMouse.current.y += (targetMouse.current.y - smoothMouse.current.y) * k;
      smoothActive.current   += (targetActive.current   - smoothActive.current  ) * k;

      const um = program.uniforms.uMouse.value as Float32Array;
      um[0] = smoothMouse.current.x;
      um[1] = smoothMouse.current.y;
      program.uniforms.uMouseActiveFactor.value = smoothActive.current;

      const res = program.uniforms.uResolution.value as Color;
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight, asp = w/Math.max(1,h);
      if (res.r !== w || res.g !== h) { res.r = w; res.g = h; res.b = asp; }

      renderer.render({ scene: mesh });
    });

    const onMove = (e: MouseEvent) => {
      if (!mouseInteraction) return;
      const r = el.getBoundingClientRect();
      targetMouse.current.x = (e.clientX - r.left)/r.width;
      targetMouse.current.y = 1 - (e.clientY - r.top)/r.height;
      targetActive.current = 1.0;
    };
    const onLeave = () => { targetActive.current = 0.0; };

    if (mouseInteraction) {
      el.addEventListener("mousemove", onMove);
      el.addEventListener("mouseleave", onLeave);
    }

    return () => {
      unsub();
      if (mouseInteraction) {
        el.removeEventListener("mousemove", onMove);
        el.removeEventListener("mouseleave", onLeave);
      }
      cleanup();
    };
  }, [
    focal, rotation, starSpeed, density, hueShift, disableAnimation, speed,
    mouseInteraction, glowIntensity, saturation, mouseRepulsion,
    twinkleIntensity, rotationSpeed, repulsionStrength, autoCenterRepulsion, transparent,
  ]);

  return <div ref={ref} className={`w-full h-full relative ${className??""}`} style={style} {...rest} />;
}