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
  ["build/icon.png", 1024],
  ["resources/icon.png", 1024],
];
for (const [file, size] of jobs) {
  await sharp(svg, { density: 384 }).resize(size, size).png().toFile(out(file));
  console.log(file);
}
await sharp({ create: { width: 2732, height: 2732, channels: 4, background: "#0b0c0e" } })
  .composite([{ input: await sharp(svg, { density: 384 }).resize(600, 600).png().toBuffer(), gravity: "center" }])
  .png()
  .toFile(out("resources/splash.png"));
console.log("resources/splash.png");
