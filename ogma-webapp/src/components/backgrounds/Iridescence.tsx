//home/ogma/ogma/ogma-webapp/src/components/backgrounds/Iridescence.tsx
import { Program, Mesh, Triangle } from "ogl";
import React, { useEffect, useRef } from "react";
import { createRenderer, subscribeTicker } from "./_sharedGL";

const vertexShader = `
attribute vec2 uv;
attribute vec2 position;
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position,0.,1.);
}
`;

const fragmentShader = `
precision highp float;
uniform float uTime;
uniform vec3  uColor;
uniform vec3  uResolution; // (w,h,aspect)
uniform vec2  uMouse;
uniform float uAmplitude;
uniform float uSpeed;
varying vec2 vUv;
void main(){
  float mr = min(uResolution.x, uResolution.y);
  vec2 uv = (vUv*2. - 1.) * uResolution.xy / mr;
  uv += (uMouse - vec2(0.5)) * uAmplitude;

  float d = -uTime*0.5*uSpeed;
  float a = 0.;
  for(float i=0.; i<8.; i+=1.){
    a += cos(i - d - a*uv.x);
    d += sin(uv.y*i + a);
  }
  d += uTime*0.5*uSpeed;

  vec3 col = vec3( cos(uv*vec2(d,a))*0.6 + 0.4, cos(a+d)*0.5+0.5 );
  col = cos(col * cos(vec3(d,a,2.5))*0.5 + 0.5) * uColor;
  gl_FragColor = vec4(col,1.0);
}
`;

export interface IridescenceProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, "color"> {
  color?: [number, number, number];
  speed?: number;
  amplitude?: number;
  mouseReact?: boolean;
}

export default function Iridescence({
  color = [1, 1, 1],
  speed = 1,
  amplitude = 0.1,
  mouseReact = true,
  className,
  style,
  ...rest
}: IridescenceProps) {
  const ctnRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctn = ctnRef.current;
    if (!ctn) return;

    const { renderer, gl, cleanup } = createRenderer(ctn, { transparent: true, dprCap: 2 });
    const geometry = new Triangle(gl);

    const uColor = new Float32Array(color);
    const uResolution = new Float32Array([gl.drawingBufferWidth, gl.drawingBufferHeight, gl.drawingBufferWidth / Math.max(1, gl.drawingBufferHeight)]);
    const uMouse = new Float32Array([0.5, 0.5]);

    const program = new Program(gl, {
      vertex: vertexShader,
      fragment: fragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: uColor },
        uResolution: { value: uResolution },
        uMouse: { value: uMouse },
        uAmplitude: { value: amplitude },
        uSpeed: { value: speed },
      },
      transparent: true,
    });

    const mesh = new Mesh(gl, { geometry, program });

    // обновление uniforms без пересозданий
    const unsub = subscribeTicker((_, now) => {
      (program.uniforms.uTime.value as number) = now;
      // обновляем резолюцию только если реально поменялась (ogl сам трекает dpr в setSize)
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      if (uResolution[0] !== w || uResolution[1] !== h) {
        uResolution[0] = w;
        uResolution[1] = h;
        uResolution[2] = w / Math.max(1, h);
      }
      renderer.render({ scene: mesh });
    });

    const onMove = (e: MouseEvent) => {
      if (!mouseReact) return;
      const rect = ctn.getBoundingClientRect();
      uMouse[0] = (e.clientX - rect.left) / rect.width;
      uMouse[1] = 1 - (e.clientY - rect.top) / rect.height;
    };
    if (mouseReact) ctn.addEventListener("mousemove", onMove);

    return () => {
      unsub();
      if (mouseReact) ctn.removeEventListener("mousemove", onMove);
      cleanup();
    };
  }, [color, speed, amplitude, mouseReact]);

  return (
    <div
      ref={ctnRef}
      className={`w-full h-full relative ${className ?? ""}`}
      style={style}
      {...rest}
    />
  );
}