import fs from "node:fs";
import path from "node:path";

const outDir = path.resolve("src/components/backgrounds");
fs.mkdirSync(outDir, { recursive: true });

// _common.tsx (база для всех фонов)
const commonFile = path.join(outDir, "_common.tsx");
if (!fs.existsSync(commonFile)) {
  fs.writeFileSync(commonFile, `import React from "react";

export type BackgroundProps = { className?: string };

export const BaseBackground: React.FC<BackgroundProps> = ({ className }) => (
  <div className={\`absolute inset-0 pointer-events-none \${className ?? ""}\`} />
);

export function makeBg(displayName: string) {
  const C: React.FC<BackgroundProps> = ({ className }) => (
    <BaseBackground className={className} />
  );
  C.displayName = displayName;
  return C;
}
`, "utf8");
  console.log("created", commonFile);
}

const names = [
  "LiquidChrome","Squares","LetterGlitch","Orb","Ballpit","GridDistortion",
  "Waves","Iridescence","Hyperspeed","Threads","DotGrid","RippleGrid",
  "FaultyTerminal","Dither","Galaxy","PrismaticBurst","Lightning","Beams",
  "GradientBlinds","Particles","Plasma","Aurora","PixelBlast","LightRays",
  "Silk","DarkVeil","Prism","LiquidEther"
];

const fileTpl = (name) => `import { makeBg } from "./_common";
const ${name} = makeBg("${name}");
export default ${name};
`;

for (const name of names) {
  const file = path.join(outDir, \`\${name}.tsx\`);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, fileTpl(name), "utf8");
    console.log("created", file);
  } else {
    console.log("exists ", file);
  }
}

console.log("Done.");
