// Renders public/icon.svg into the PNG icons used by the PWA, desktop installers and mobile apps.
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const svg = fileURLToPath(new URL("../public/icon.svg", import.meta.url));
const out = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
mkdirSync(out("build"), { recursive: true });
mkdirSync(out("resources"), { recursive: true });

const jobs = [
  ["public/icon-192.png", 192],
  ["public/icon-512.png", 512],
  ["public/apple-touch-icon.png", 180],
  ["resources/icon.png", 1024],
];
for (const [file, size] of jobs) {
  await sharp(svg, { density: 384 }).resize(size, size).png().toFile(out(file));
  console.log(file);
}
// Desktop icon: the tile with the standard macOS margin (824 px artwork on a 1024 px canvas).
await sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: await sharp(svg, { density: 384 }).resize(824, 824).png().toBuffer(), gravity: "center" }])
  .png()
  .toFile(out("build/icon.png"));
console.log("build/icon.png");
await sharp({ create: { width: 2732, height: 2732, channels: 4, background: "#0A0A0A" } })
  .composite([{ input: await sharp(svg, { density: 384 }).resize(600, 600).png().toBuffer(), gravity: "center" }])
  .png()
  .toFile(out("resources/splash.png"));
console.log("resources/splash.png");
