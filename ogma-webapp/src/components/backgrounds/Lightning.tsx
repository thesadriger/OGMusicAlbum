import React, { useEffect, useRef } from "react";
import { Program, Mesh, Triangle } from "ogl";
import { createRenderer, subscribeTicker } from "./_sharedGL";

interface LightningProps extends React.HTMLAttributes<HTMLDivElement> {
  hue?: number;
  xOffset?: number;
  speed?: number;
  intensity?: number;
  size?: number;
}

const vtx = `
attribute vec2 position; attribute vec2 uv; varying vec2 vUv;
void main(){ vUv=uv; gl_Position=vec4(position,0.,1.); }
`;

const frg = `
precision mediump float;
uniform vec2  iResolution;
uniform float iTime;
uniform float uHue;
uniform float uXOffset;
uniform float uSpeed;
uniform float uIntensity;
uniform float uSize;
varying vec2 vUv;

#define OCTAVE_COUNT 10
vec3 hsv2rgb(vec3 c){ vec3 rgb=clamp(abs(mod(c.x*6.0+vec3(0.0,4.0,2.0),6.0)-3.0)-1.0,0.0,1.0); return c.z*mix(vec3(1.0),rgb,c.y); }
float hash11(float p){ p=fract(p*.1031); p*=p+33.33; p*=p+p; return fract(p); }
float hash12(vec2 p){ vec3 p3=fract(vec3(p.xyx)*.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
mat2 rotate2d(float t){ float c=cos(t),s=sin(t); return mat2(c,-s,s,c); }
float noise(vec2 p){ vec2 ip=floor(p), fp=fract(p);
  float a=hash12(ip), b=hash12(ip+vec2(1.,0.)), c=hash12(ip+vec2(0.,1.)), d=hash12(ip+vec2(1.,1.));
  vec2 t=smoothstep(0.,1.,fp);
  return mix(mix(a,b,t.x), mix(c,d,t.x), t.y);
}
float fbm(vec2 p){ float v=0., a=0.5; for(int i=0;i<OCTAVE_COUNT;i++){ v+=a*noise(p); p*=rotate2d(0.45); p*=2.0; a*=0.5; } return v; }

void main(){
  vec2 fragCoord = vUv * iResolution;
  vec2 uv = fragCoord / iResolution;
  uv = 2.0*uv - 1.0;
  uv.x *= iResolution.x/iResolution.y;
  uv.x += uXOffset;
  uv += 2.0 * fbm(uv*uSize + 0.8*iTime*uSpeed) - 1.0;
  float dist = abs(uv.x);
  vec3 baseColor = hsv2rgb(vec3(uHue/360.0, 0.7, 0.8));
  vec3 col = baseColor * pow(mix(0.0, 0.07, hash11(iTime*uSpeed)) / dist, 1.0) * uIntensity;
  gl_FragColor = vec4(col,1.0);
}
`;

const Lightning: React.FC<LightningProps> = ({
  hue = 230, xOffset = 0, speed = 1, intensity = 1, size = 1, className, style, ...rest
}) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const { renderer, gl, cleanup } = createRenderer(el, { transparent: true, dprCap: 2 });
    const geometry = new Triangle(gl);

    const iResolution = new Float32Array([gl.drawingBufferWidth, gl.drawingBufferHeight]);
    const program = new Program(gl, {
      vertex: vtx,
      fragment: frg,
      uniforms: {
        iResolution: { value: iResolution },
        iTime: { value: 0 },
        uHue: { value: hue },
        uXOffset: { value: xOffset },
        uSpeed: { value: speed },
        uIntensity: { value: intensity },
        uSize: { value: size },
      },
      transparent: true,
    });

    const mesh = new Mesh(gl, { geometry, program });

    const unsub = subscribeTicker((now) => {
      (program.uniforms.iTime.value as number) = now * 0.001;
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      if (iResolution[0] !== w || iResolution[1] !== h) { iResolution[0]=w; iResolution[1]=h; }
      renderer.render({ scene: mesh });
    });

    return () => { unsub(); cleanup(); };
  }, [hue, xOffset, speed, intensity, size]);

  return <div ref={ref} className={`w-full h-full relative ${className??""}`} style={style} {...rest} />;
};

export default Lightning;