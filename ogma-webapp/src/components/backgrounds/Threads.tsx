import React, { useEffect, useRef } from "react";
import { Program, Mesh, Triangle, Color } from "ogl";
import { createRenderer, subscribeTicker } from "./_sharedGL";

interface ThreadsProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "color"> {
  color?: [number, number, number];
  amplitude?: number;
  distance?: number;
  enableMouseInteraction?: boolean;
}

const vtx = `
attribute vec2 position;
attribute vec2 uv;
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position,0.,1.); }
`;

const frg = `
precision highp float;

uniform float iTime;
uniform vec3  iResolution; // (w,h,aspect)
uniform vec3  uColor;
uniform float uAmplitude;
uniform float uDistance;
uniform vec2  uMouse;

#define PI 3.1415926538
const int   u_line_count = 40;
const float u_line_width = 7.0;
const float u_line_blur  = 10.0;

// Перлин (как было)
float Perlin2D(vec2 P){
  vec2 Pi = floor(P);
  vec4 Pf = P.xyxy - vec4(Pi, Pi + 1.0);
  vec4 Pt = vec4(Pi.xy, Pi.xy + 1.0);
  Pt = Pt - floor(Pt*(1.0/71.0))*71.0;
  Pt += vec2(26.0,161.0).xyxy; Pt*=Pt; Pt=Pt.xzxz*Pt.yyww;
  vec4 hx=fract(Pt*(1.0/951.135664));
  vec4 hy=fract(Pt*(1.0/642.949883));
  vec4 gx=hx-0.49999; vec4 gy=hy-0.49999;
  vec4 gr = inversesqrt(gx*gx+gy*gy) * (gx*Pf.xzxz + gy*Pf.yyww);
  gr *= 1.41421356237;
  vec2 b = Pf.xy*Pf.xy*Pf.xy*(Pf.xy*(Pf.xy*6.0-15.0)+10.0);
  vec4 b2=vec4(b, vec2(1.0-b));
  return dot(gr, b2.zxzx*b2.wwyy);
}

float pixel(float c, vec2 res){ return (1.0/max(res.x,res.y))*c; }

float lineFn(vec2 st, float width, float perc, float offset, vec2 mouse, float time, float amplitude, float distance){
  float split_offset = (perc*0.4);
  float split_point  = 0.1 + split_offset;

  float amplitude_normal = smoothstep(split_point,0.7,st.x);
  float amplitude_strength = 0.5;
  float finalAmp = amplitude_normal * amplitude_strength * amplitude * (1.0 + (mouse.y-0.5)*0.2);

  float t = time/10.0 + (mouse.x-0.5)*1.0;
  float blur = smoothstep(split_point, split_point+0.05, st.x) * perc;

  float xnoise = mix(
    Perlin2D(vec2(t, st.x+perc)*2.5),
    Perlin2D(vec2(t, st.x+t)*3.5)/1.5,
    st.x*0.3
  );

  float y = 0.5 + (perc-0.5)*distance + xnoise/2.0*finalAmp;

  float ls = smoothstep( y + (width/2.0) + (u_line_blur*pixel(1.0,iResolution.xy)*blur), y, st.y );
  float le = smoothstep( y, y - (width/2.0) - (u_line_blur*pixel(1.0,iResolution.xy)*blur), st.y );

  return clamp( (ls-le)*(1.0 - smoothstep(0.0,1.0,pow(perc,0.3))), 0.0, 1.0 );
}

void mainImage(out vec4 fragColor, in vec2 fragCoord){
  vec2 uv = fragCoord / iResolution.xy;
  float line_strength = 1.0;
  for(int i=0;i<u_line_count;i++){
    float p = float(i)/float(u_line_count);
    line_strength *= (1.0 - lineFn(
      uv,
      u_line_width * pixel(1.0,iResolution.xy)*(1.0-p),
      p,
      (PI*1.0)*p,
      uMouse,
      iTime,
      uAmplitude,
      uDistance
    ));
  }
  float colorVal = 1.0 - line_strength;
  fragColor = vec4(uColor * colorVal, colorVal);
}

void main(){ mainImage(gl_FragColor, gl_FragCoord.xy); }
`;

const Threads: React.FC<ThreadsProps> = ({
  color = [1,1,1],
  amplitude = 1,
  distance = 0,
  enableMouseInteraction = false,
  className,
  style,
  ...rest
}) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const { renderer, gl, cleanup } = createRenderer(el, { transparent: true, dprCap: 2 });
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const geometry = new Triangle(gl);

    const iResolution = new Color(gl.drawingBufferWidth, gl.drawingBufferHeight, gl.drawingBufferWidth/Math.max(1, gl.drawingBufferHeight));
    const uMouse = new Float32Array([0.5, 0.5]);

    const program = new Program(gl, {
      vertex: vtx,
      fragment: frg,
      uniforms: {
        iTime:  { value: 0 },
        iResolution: { value: iResolution },
        uColor: { value: new Color(...color) },
        uAmplitude: { value: amplitude },
        uDistance:  { value: distance },
        uMouse: { value: uMouse },
      },
      transparent: true,
    });

    const mesh = new Mesh(gl, { geometry, program });

    const unsub = subscribeTicker((now) => {
      (program.uniforms.iTime.value as number) = now * 0.001;
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      if (iResolution.r !== w || iResolution.g !== h) {
        iResolution.r = w; iResolution.g = h; iResolution.b = w/Math.max(1,h);
      }
      renderer.render({ scene: mesh });
    });

    const onMove = (e: MouseEvent) => {
      if (!enableMouseInteraction) return;
      const r = el.getBoundingClientRect();
      uMouse[0] = (e.clientX - r.left)/r.width;
      uMouse[1] = 1 - (e.clientY - r.top)/r.height;
    };
    const onLeave = () => { uMouse[0]=0.5; uMouse[1]=0.5; };
    if (enableMouseInteraction) {
      el.addEventListener("mousemove", onMove);
      el.addEventListener("mouseleave", onLeave);
    }

    return () => {
      unsub();
      if (enableMouseInteraction) {
        el.removeEventListener("mousemove", onMove);
        el.removeEventListener("mouseleave", onLeave);
      }
      cleanup();
    };
  }, [color, amplitude, distance, enableMouseInteraction]);

  return <div ref={ref} className={`w-full h-full relative ${className??""}`} style={style} {...rest} />;
};

export default Threads;