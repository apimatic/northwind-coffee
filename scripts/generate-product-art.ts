/**
 * Generates the original product illustrations in public/images/products/.
 * Run with: npx tsx scripts/generate-product-art.ts
 * The output is committed; rerun only when you change the artwork.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Brand {
  name: string;
  short: string;
  primary: string;
  accent: string;
  ink: string;
}

const brands: Record<number, Brand> = {
  1: { name: "Northwind Roasters", short: "NORTHWIND", primary: "#1f4e5f", accent: "#f2c14e", ink: "#ffffff" },
  2: { name: "Contoso Coffee Co.", short: "CONTOSO", primary: "#8c2f39", accent: "#f4e1c1", ink: "#ffffff" },
  3: { name: "Fabrikam Farms", short: "FABRIKAM", primary: "#4a6b2a", accent: "#e9d8a6", ink: "#ffffff" },
  4: { name: "Tailspin Trading", short: "TAILSPIN", primary: "#23395d", accent: "#e07a24", ink: "#ffffff" },
};

type Kind = "bean" | "ground" | "capsules" | "dripper" | "press" | "grinder" | "kettle";

interface Product {
  file: string;
  title: string;
  label: string;
  brand: number;
  kind: Kind;
}

const products: Product[] = [
  {
    file: "house-blend-whole-bean",
    title: "House Blend whole bean coffee bag",
    label: "HOUSE BLEND",
    brand: 1,
    kind: "bean",
  },
  {
    file: "espresso-forte-whole-bean",
    title: "Espresso Forte whole bean coffee bag",
    label: "ESPRESSO FORTE",
    brand: 2,
    kind: "bean",
  },
  {
    file: "ethiopia-yirgacheffe-whole-bean",
    title: "Ethiopia Yirgacheffe whole bean coffee bag",
    label: "YIRGACHEFFE",
    brand: 3,
    kind: "bean",
  },
  {
    file: "sumatra-mandheling-whole-bean",
    title: "Sumatra Mandheling whole bean coffee bag",
    label: "SUMATRA",
    brand: 4,
    kind: "bean",
  },
  {
    file: "breakfast-blend-ground",
    title: "Breakfast Blend ground coffee bag",
    label: "BREAKFAST",
    brand: 1,
    kind: "ground",
  },
  {
    file: "swiss-water-decaf-ground",
    title: "Swiss Water Decaf ground coffee bag",
    label: "DECAF",
    brand: 2,
    kind: "ground",
  },
  {
    file: "colombia-huila-ground",
    title: "Colombia Huila ground coffee bag",
    label: "HUILA",
    brand: 3,
    kind: "ground",
  },
  {
    file: "french-roast-ground",
    title: "French Roast ground coffee bag",
    label: "FRENCH ROAST",
    brand: 4,
    kind: "ground",
  },
  { file: "lungo-capsules", title: "Box of Lungo coffee capsules", label: "LUNGO", brand: 1, kind: "capsules" },
  {
    file: "ristretto-capsules",
    title: "Box of Ristretto coffee capsules",
    label: "RISTRETTO",
    brand: 2,
    kind: "capsules",
  },
  { file: "organic-capsules", title: "Box of Organic coffee capsules", label: "ORGANIC", brand: 3, kind: "capsules" },
  { file: "vanilla-capsules", title: "Box of Vanilla coffee capsules", label: "VANILLA", brand: 4, kind: "capsules" },
  { file: "ceramic-pour-over-dripper", title: "Ceramic pour-over dripper", label: "", brand: 1, kind: "dripper" },
  { file: "french-press", title: "Glass French press", label: "", brand: 2, kind: "press" },
  { file: "conical-burr-grinder", title: "Conical burr grinder", label: "", brand: 3, kind: "grinder" },
  { file: "gooseneck-kettle", title: "Gooseneck kettle", label: "", brand: 4, kind: "kettle" },
];

const font = "font-family=\"'Segoe UI', Helvetica, Arial, sans-serif\"";

function bean(x: number, y: number, r: number, rot: number, fill: string): string {
  return `<g transform="translate(${x} ${y}) rotate(${rot})"><ellipse rx="${r}" ry="${r * 0.68}" fill="${fill}"/><path d="M${-r * 0.8} 0 C ${-r * 0.3} ${-r * 0.3}, ${r * 0.3} ${r * 0.3}, ${r * 0.8} 0" stroke="#000" stroke-opacity="0.35" stroke-width="${r * 0.14}" fill="none"/></g>`;
}

function bag(b: Brand, label: string, ground: boolean): string {
  const mark = ground
    ? `<path d="M168 286 Q200 252 232 286 Z" fill="#5b3a29"/><circle cx="185" cy="279" r="3" fill="#3b2418"/><circle cx="203" cy="272" r="3" fill="#3b2418"/><circle cx="218" cy="281" r="3" fill="#3b2418"/>`
    : `${bean(182, 272, 14, -25, "#5b3a29")}${bean(214, 278, 14, 20, "#6d4532")}`;
  const typeText = ground ? "GROUND COFFEE" : "WHOLE BEAN";
  return `
  <path d="M128 112 L272 112 L292 330 Q200 346 108 330 Z" fill="${b.primary}"/>
  <path d="M128 112 L272 112 L266 92 L134 92 Z" fill="${b.primary}" opacity="0.85"/>
  <rect x="134" y="86" width="132" height="10" rx="3" fill="${b.accent}"/>
  <path d="M272 112 L292 330 Q284 332 276 333 L258 112 Z" fill="#000" opacity="0.12"/>
  <rect x="140" y="150" width="120" height="152" rx="10" fill="${b.accent}"/>
  <text x="200" y="176" text-anchor="middle" ${font} font-size="13" font-weight="700" fill="${b.primary}" letter-spacing="1.5">${b.short}</text>
  <text x="200" y="205" text-anchor="middle" ${font} font-size="${label.length > 11 ? 13 : 16}" font-weight="800" fill="#2b1d16">${label}</text>
  <text x="200" y="226" text-anchor="middle" ${font} font-size="10" font-weight="600" fill="#2b1d16" letter-spacing="1">${typeText}</text>
  ${mark}`;
}

function capsules(b: Brand, label: string): string {
  const pods = [0, 1, 2]
    .map((i) => {
      const x = 152 + i * 48;
      return `<g transform="translate(${x} 300)"><path d="M-17 -6 L17 -6 L12 18 L-12 18 Z" fill="${b.accent}" stroke="#2b1d16" stroke-opacity="0.25"/><rect x="-20" y="-11" width="40" height="7" rx="3" fill="#c9c9c9"/></g>`;
    })
    .join("");
  return `
  <path d="M112 132 L288 132 L288 280 L112 280 Z" fill="${b.primary}"/>
  <path d="M112 132 L148 104 L324 104 L288 132 Z" fill="${b.primary}" opacity="0.75"/>
  <path d="M288 132 L324 104 L324 252 L288 280 Z" fill="#000" opacity="0.18"/>
  <rect x="130" y="150" width="140" height="22" rx="4" fill="${b.accent}"/>
  <text x="200" y="166" text-anchor="middle" ${font} font-size="12" font-weight="700" fill="${b.primary}" letter-spacing="1.5">${b.short}</text>
  <text x="200" y="210" text-anchor="middle" ${font} font-size="20" font-weight="800" fill="${b.ink}">${label}</text>
  <text x="200" y="234" text-anchor="middle" ${font} font-size="11" font-weight="600" fill="${b.ink}" letter-spacing="1.5">CAPSULES</text>
  ${pods}`;
}

function dripper(b: Brand): string {
  return `
  <rect x="120" y="300" width="160" height="16" rx="8" fill="#d9cbb8"/>
  <path d="M150 230 L250 230 L242 298 Q200 310 158 298 Z" fill="#ffffff" stroke="#c7b9a6" stroke-width="3"/>
  <path d="M120 120 L280 120 L232 222 L168 222 Z" fill="${b.primary}"/>
  <rect x="160" y="220" width="80" height="12" rx="4" fill="${b.primary}"/>
  <path d="M276 140 Q312 150 300 186 Q292 204 262 196" stroke="${b.primary}" stroke-width="12" fill="none" stroke-linecap="round"/>
  <path d="M136 132 L264 132" stroke="${b.accent}" stroke-width="6" stroke-linecap="round"/>
  <path d="M200 238 Q196 252 200 262 Q204 252 200 238 Z" fill="#5b3a29"/>`;
}

function press(b: Brand): string {
  return `
  <rect x="196" y="86" width="8" height="36" fill="#8f8f8f"/>
  <circle cx="200" cy="82" r="11" fill="${b.primary}"/>
  <rect x="136" y="116" width="128" height="18" rx="6" fill="#8f8f8f"/>
  <rect x="142" y="134" width="116" height="176" rx="10" fill="#e8f1f5" stroke="#9fb5bf" stroke-width="3"/>
  <rect x="146" y="196" width="108" height="110" rx="8" fill="#5b3a29"/>
  <rect x="146" y="190" width="108" height="10" fill="#8a5a40"/>
  <path d="M258 160 Q300 166 298 214 Q296 262 258 270" stroke="${b.primary}" stroke-width="14" fill="none" stroke-linecap="round"/>
  <rect x="132" y="306" width="136" height="16" rx="6" fill="${b.primary}"/>
  <rect x="142" y="150" width="116" height="10" fill="${b.accent}" opacity="0.9"/>`;
}

function grinder(b: Brand): string {
  return `
  <path d="M164 96 L236 96 L246 150 L154 150 Z" fill="#e8f1f5" stroke="#9fb5bf" stroke-width="3"/>
  ${bean(186, 128, 10, -20, "#5b3a29")}${bean(212, 132, 10, 25, "#6d4532")}${bean(198, 114, 9, 5, "#6d4532")}
  <rect x="146" y="150" width="108" height="158" rx="14" fill="${b.primary}"/>
  <rect x="160" y="176" width="80" height="20" rx="6" fill="${b.accent}"/>
  <circle cx="200" cy="232" r="22" fill="${b.accent}"/>
  <circle cx="200" cy="232" r="8" fill="${b.primary}"/>
  <rect x="164" y="266" width="72" height="34" rx="4" fill="#2b1d16" opacity="0.35"/>
  <rect x="140" y="306" width="120" height="14" rx="6" fill="#2b1d16" opacity="0.7"/>`;
}

function kettle(b: Brand): string {
  return `
  <path d="M136 176 Q132 300 150 312 L262 312 Q280 300 276 176 Z" fill="${b.primary}"/>
  <rect x="128" y="168" width="156" height="16" rx="8" fill="#8f8f8f"/>
  <path d="M176 168 Q206 140 236 168 Z" fill="#8f8f8f"/>
  <circle cx="206" cy="146" r="8" fill="${b.accent}"/>
  <path d="M276 200 Q316 204 314 250 Q312 280 276 288" stroke="${b.accent}" stroke-width="14" fill="none" stroke-linecap="round"/>
  <path d="M140 270 Q100 260 92 200 Q90 176 76 166" stroke="#8f8f8f" stroke-width="9" fill="none" stroke-linecap="round"/>
  <rect x="136" y="300" width="140" height="12" fill="#000" opacity="0.15"/>`;
}

function svg(p: Product): string {
  const b = brands[p.brand];
  if (!b) throw new Error(`Unknown brand ${p.brand}`);
  let body: string;
  switch (p.kind) {
    case "bean":
      body = bag(b, p.label, false);
      break;
    case "ground":
      body = bag(b, p.label, true);
      break;
    case "capsules":
      body = capsules(b, p.label);
      break;
    case "dripper":
      body = dripper(b);
      break;
    case "press":
      body = press(b);
      break;
    case "grinder":
      body = grinder(b);
      break;
    case "kettle":
      body = kettle(b);
      break;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400" role="img" aria-labelledby="t">
  <title id="t">${p.title} (${b.name})</title>
  <rect width="400" height="400" fill="#f7f1e8"/>
  <circle cx="200" cy="210" r="150" fill="${b.accent}" opacity="0.28"/>
  <ellipse cx="200" cy="336" rx="118" ry="12" fill="#2b1d16" opacity="0.12"/>
  ${body.trim()}
</svg>
`;
}

const outDir = join(import.meta.dirname, "..", "public", "images", "products");
mkdirSync(outDir, { recursive: true });
for (const p of products) {
  writeFileSync(join(outDir, `${p.file}.svg`), svg(p));
}
console.log(`Wrote ${products.length} illustrations to ${outDir}`);
