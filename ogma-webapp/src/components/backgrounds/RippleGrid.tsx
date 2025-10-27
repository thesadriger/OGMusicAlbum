import { useRef, useEffect } from 'react';
import { Renderer, Program, Triangle, Mesh } from 'ogl';

type Props = {
  enableRainbow?: boolean;
  className?: string;
  gridColor?: string;
  rippleIntensity?: number;
  gridSize?: number;
  gridThickness?: number;
  fadeDistance?: number;
  vignetteStrength?: number;
  glowIntensity?: number;
  opacity?: number;
  gridRotation?: number;
  mouseInteraction?: boolean;
  mouseInteractionRadius?: number;
};

const RippleGrid: React.FC<Props> = ({
  enableRainbow = false,
  className = "",
  gridColor = '#ffffff',
  rippleIntensity = 0.05,
  gridSize = 10.0,
  gridThickness = 15.0,
  fadeDistance = 1.5,
  vignetteStrength = 2.0,
  glowIntensity = 0.1,
  opacity = 1.0,
  gridRotation = 0,
  mouseInteraction = true,
  mouseInteractionRadius = 1,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const mousePositionRef = useRef({ x: 0.5, y: 0.5 });
  const targetMouseRef = useRef({ x: 0.5, y: 0.5 });
  const mouseInfluenceRef = useRef(0);
  const uniformsRef = useRef<any>(null);
  const rafRef = useRef<number | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const hexToRgb = (hex: string): [number, number, number] => {
      const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
      return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : [1, 1, 1];
    };

    // ⬅️ Делам канвас НЕпрозрачным, чтобы исключить исчезновение из-за альфа
    const renderer = new Renderer({
      dpr: Math.min(window.devicePixelRatio || 1, 2),
      alpha: false,
      premultipliedAlpha: false,
      powerPreference: 'high-performance',
    });
    const gl = renderer.gl;
    // При непрозрачном контексте смешивание не нужно — отключаем
    gl.disable(gl.BLEND);
    gl.canvas.style.width = '100%';
    gl.canvas.style.height = '100%';
    container.appendChild(gl.canvas);

    // диагностическая информация о GPU (помогает ловить offscreen/software)
    try {
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      if (info) {
        const vendor = gl.getParameter(info.UNMASKED_VENDOR_WEBGL);
        const rendererName = gl.getParameter(info.UNMASKED_RENDERER_WEBGL);
        console.debug('[RippleGrid] GL:', gl instanceof WebGL2RenderingContext ? 'WebGL2' : 'WebGL1', '| GPU:', vendor, rendererName);
      }
    } catch { /* безопасно игнорируем */ }

    // отлов потери контекста (часто случается при лимите контекстов)
    const onLost = (e: Event) => { e.preventDefault(); console.warn('[RippleGrid] context lost'); };
    const onRestored = () => { console.info('[RippleGrid] context restored'); };
    gl.canvas.addEventListener('webglcontextlost', onLost as EventListener, { passive: false });
    gl.canvas.addEventListener('webglcontextrestored', onRestored as EventListener);

    const vert = `
attribute vec2 position;
varying vec2 vUv;
void main() {
  vUv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

    const frag = `precision highp float;
uniform float iTime;
uniform vec2  iResolution;
uniform bool  enableRainbow;
uniform vec3  gridColor;
uniform float rippleIntensity;
uniform float gridSize;
uniform float gridThickness;
uniform float fadeDistance;
uniform float vignetteStrength;
uniform float glowIntensity;
uniform float opacity;
uniform float gridRotation;
uniform bool  mouseInteraction;
uniform vec2  mousePosition;
uniform float mouseInfluence;
uniform float mouseInteractionRadius;
varying vec2 vUv;

const float pi = 3.141592;

mat2 rotate(float a){
  float s = sin(a), c = cos(a);
  return mat2(c,-s,s,c);
}

void main(){
  vec2 uv = vUv * 2.0 - 1.0;
  uv.x *= iResolution.x / iResolution.y;

  if (gridRotation != 0.0) uv = rotate(gridRotation * pi / 180.0) * uv;

  float dist = length(uv);
  float func = sin(pi * (iTime - dist));
  vec2 rippleUv = uv + uv * func * rippleIntensity;

  if (mouseInteraction && mouseInfluence > 0.0) {
    vec2 mouseUv = mousePosition * 2.0 - 1.0;
    mouseUv.x *= iResolution.x / iResolution.y;
    float mouseDist = length(uv - mouseUv);
    float influence = mouseInfluence * exp(-mouseDist*mouseDist/(mouseInteractionRadius*mouseInteractionRadius));
    float mouseWave = sin(pi * (iTime*2.0 - mouseDist*3.0)) * influence;
    rippleUv += normalize(uv - mouseUv) * mouseWave * rippleIntensity * 0.3;
  }

  vec2 a = sin(gridSize * 0.5 * pi * rippleUv - pi/2.0);
  vec2 b = abs(a);

  float aaWidth = 0.5;
  vec2 smoothB = vec2(smoothstep(0.0, aaWidth, b.x),
                      smoothstep(0.0, aaWidth, b.y));

  vec3 color = vec3(0.0);
  color += exp(-gridThickness * smoothB.x * (0.8 + 0.5 * sin(pi*iTime)));
  color += exp(-gridThickness * smoothB.y);
  color += 0.5 * exp(-(gridThickness/4.0) * sin(smoothB.x));
  color += 0.5 * exp(-(gridThickness/3.0) * smoothB.y);

  if (glowIntensity > 0.0){
    color += glowIntensity * exp(-gridThickness * 0.5 * smoothB.x);
    color += glowIntensity * exp(-gridThickness * 0.5 * smoothB.y);
  }

  float ddd = exp(-2.0 * clamp(pow(dist, fadeDistance), 0.0, 1.0));
  vec2 vg = vUv - 0.5;
  float vignette = clamp(1.0 - pow(length(vg) * 2.0, vignetteStrength), 0.0, 1.0);

  vec3 tint = enableRainbow
    ? (vec3(uv.x*0.5 + 0.5*sin(iTime),
            uv.y*0.5 + 0.5*cos(iTime),
            pow(cos(iTime),4.0)) + 0.5)
    : gridColor;

  float finalFade = ddd * vignette;
  // canvas теперь непрозрачный → альфа можно держать =1.0
  gl_FragColor = vec4(color * tint * finalFade * opacity, 1.0);
}
`;

    const uniforms = {
      iTime: { value: 0 },
      iResolution: { value: [1, 1] },
      // ⬇️ bool-параметры отдаём как 0/1 (uniform1i)
      enableRainbow: { value: enableRainbow ? 1 : 0 },
      gridColor: { value: hexToRgb(gridColor) },
      rippleIntensity: { value: rippleIntensity },
      gridSize: { value: gridSize },
      gridThickness: { value: gridThickness },
      fadeDistance: { value: fadeDistance },
      vignetteStrength: { value: vignetteStrength },
      glowIntensity: { value: glowIntensity },
      opacity: { value: opacity },
      gridRotation: { value: gridRotation },
      mouseInteraction: { value: mouseInteraction ? 1 : 0 },
      mousePosition: { value: [0.5, 0.5] },
      mouseInfluence: { value: 0 },
      mouseInteractionRadius: { value: mouseInteractionRadius },
    };

    uniformsRef.current = uniforms;

    const geometry = new Triangle(gl);
    const program = new Program(gl, { vertex: vert, fragment: frag, uniforms });
    const mesh = new Mesh(gl, { geometry, program });

    const resize = () => {
      const w = Math.max(1, container.clientWidth);
      const h = Math.max(1, container.clientHeight);
      renderer.setSize(w, h);
      uniforms.iResolution.value = [w, h];
    };

    // реагируем и на реальные изменения контейнера
    roRef.current = new ResizeObserver(resize);
    roRef.current.observe(container);
    window.addEventListener('resize', resize);
    // двойной тик — на случай отложенной раскладки
    requestAnimationFrame(resize);

    const render = (t: number) => {
      uniforms.iTime.value = t * 0.001;

      // плавное обновление мыши
      const k = 0.1;
      mousePositionRef.current.x += (targetMouseRef.current.x - mousePositionRef.current.x) * k;
      mousePositionRef.current.y += (targetMouseRef.current.y - mousePositionRef.current.y) * k;

      const inf = uniforms.mouseInfluence.value;
      uniforms.mouseInfluence.value += (mouseInfluenceRef.current - inf) * 0.05;

      uniforms.mousePosition.value = [mousePositionRef.current.x, mousePositionRef.current.y];

      renderer.render({ scene: mesh });
      rafRef.current = requestAnimationFrame(render);
    };
    rafRef.current = requestAnimationFrame(render);

    const handleMouseMove = (e: MouseEvent) => {
      if (!mouseInteraction || !container) return;
      const r = container.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = 1.0 - (e.clientY - r.top) / r.height;
      targetMouseRef.current = { x, y };
    };
    const handleMouseEnter = () => { if (mouseInteraction) mouseInfluenceRef.current = 1.0; };
    const handleMouseLeave = () => { if (mouseInteraction) mouseInfluenceRef.current = 0.0; };

    if (mouseInteraction) {
      container.addEventListener('mousemove', handleMouseMove);
      container.addEventListener('mouseenter', handleMouseEnter);
      container.addEventListener('mouseleave', handleMouseLeave);
    }

    return () => {
      window.removeEventListener('resize', resize);
      if (roRef.current) { roRef.current.disconnect(); roRef.current = null; }
      if (mouseInteraction) {
        container.removeEventListener('mousemove', handleMouseMove);
        container.removeEventListener('mouseenter', handleMouseEnter);
        container.removeEventListener('mouseleave', handleMouseLeave);
      }
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      gl.canvas.removeEventListener('webglcontextlost', onLost as EventListener);
      gl.canvas.removeEventListener('webglcontextrestored', onRestored as EventListener);

      // корректно освобождаем GPU-ресурсы
      try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* noop */ }
      if (gl.canvas.parentElement === container) container.removeChild(gl.canvas);
    };
  }, []);

  // обновление uniforms при изменении пропсов
  useEffect(() => {
    const u = uniformsRef.current;
    if (!u) return;

    const hexToRgb = (hex: string): [number, number, number] => {
      const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
      return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : [1, 1, 1];
    };

    u.enableRainbow.value = enableRainbow ? 1 : 0;
    u.gridColor.value = hexToRgb(gridColor);
    u.rippleIntensity.value = rippleIntensity;
    u.gridSize.value = gridSize;
    u.gridThickness.value = gridThickness;
    u.fadeDistance.value = fadeDistance;
    u.vignetteStrength.value = vignetteStrength;
    u.glowIntensity.value = glowIntensity;
    u.opacity.value = opacity;
    u.gridRotation.value = gridRotation;
    u.mouseInteraction.value = mouseInteraction ? 1 : 0;
    u.mouseInteractionRadius.value = mouseInteractionRadius;
  }, [
    enableRainbow, gridColor, rippleIntensity, gridSize, gridThickness,
    fadeDistance, vignetteStrength, glowIntensity, opacity, gridRotation,
    mouseInteraction, mouseInteractionRadius,
  ]);

  return (
    <div ref={containerRef} className={`w-full h-full relative overflow-hidden [&_canvas]:block ${className}`} />
  );
};

export default RippleGrid;