// Rebrands the installable apps from a brand kit exported in Settings → Appearance.
//   npm run brand path/to/brand-kit.json
// Updates the app name, icons (desktop, PWA, Android, iOS) and the default theme, then tells you
// what to rebuild. Run it from a clean checkout so you can review the changes with git.
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import sharp from "sharp";

const root = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const kitPath = process.argv[2];
if (!kitPath) {
  console.error("Usage: npm run brand path/to/brand-kit.json");
  process.exit(1);
}
const kit = JSON.parse(readFileSync(kitPath, "utf8"));
if (kit.app !== "adt-bot-brand") {
  console.error("That file isn't a brand kit. Export one from Settings → Appearance → Brand kit.");
  process.exit(1);
}
// A kit is a file someone shared: every field is checked before it's used (it reaches file
// contents and a command line).
const HEX = /^#[0-9a-f]{6}$/i;
const name = String(kit.name || "ADT Bot").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60) || "ADT Bot";
const theme = kit.theme && typeof kit.theme === "object" ? kit.theme : {};
const clean = {
  ...(typeof theme.preset === "string" && /^[\w-]{1,40}$/.test(theme.preset) ? { preset: theme.preset } : {}),
  ...(HEX.test(String(theme.accent ?? "")) ? { accent: theme.accent } : {}),
  ...(HEX.test(String(theme.background ?? "")) ? { background: theme.background } : {}),
  ...(typeof theme.font === "string" ? { font: theme.font.replace(/[^\w -]/g, "").slice(0, 60) } : {}),
  ...(Number.isFinite(Number(theme.radius)) ? { radius: Math.max(0, Math.min(32, Number(theme.radius))) } : {}),
};
for (const key of ["accent", "background"]) {
  if (theme[key] !== undefined && theme[key] !== "" && !(key in clean)) {
    console.error(`The kit's ${key} colour (${JSON.stringify(theme[key]).slice(0, 60)}) isn't a #rrggbb colour.`);
    process.exit(1);
  }
}
const logo = typeof kit.logo === "string" && /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(kit.logo) ? kit.logo : "";

// 1. Default brand inside the app.
writeFileSync(root("src/brand.json"), `${JSON.stringify({ name, logo, logoAsAvatar: Boolean(kit.logoAsAvatar), theme: clean }, null, 2)}\n`);

// 2. App name for installers and mobile apps.
const pkg = JSON.parse(readFileSync(root("package.json"), "utf8"));
pkg.productName = name;
pkg.build.productName = name;
writeFileSync(root("package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
const cap = JSON.parse(readFileSync(root("capacitor.config.json"), "utf8"));
cap.appName = name;
writeFileSync(root("capacitor.config.json"), `${JSON.stringify(cap, null, 2)}\n`);
const xmlName = name.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const strings = root("android/app/src/main/res/values/strings.xml");
if (existsSync(strings)) {
  writeFileSync(
    strings,
    readFileSync(strings, "utf8").replace(/(<string name="(?:app_name|title_activity_main)">)[^<]*(<\/string>)/g, `$1${xmlName}$2`),
  );
}
const plist = root("ios/App/App/Info.plist");
if (existsSync(plist)) {
  writeFileSync(plist, readFileSync(plist, "utf8").replace(/(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/, `$1${xmlName}$2`));
}

// 3. Icons from the logo, on the brand's background.
if (logo) {
  const art = Buffer.from(logo.split(",")[1], "base64");
  const background = clean.background || "#ffffff";
  const icon = async (file, size, padding = 0.16) => {
    const inner = Math.round(size * (1 - padding * 2));
    const scaled = await sharp(art).resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    await sharp({ create: { width: size, height: size, channels: 4, background } })
      .composite([{ input: scaled, gravity: "center" }])
      .png()
      .toFile(root(file));
  };
  await icon("build/icon.png", 1024);
  await icon("resources/icon.png", 1024);
  await icon("public/icon-192.png", 192);
  await icon("public/icon-512.png", 512);
  await icon("public/apple-touch-icon.png", 180);
  await sharp({ create: { width: 2732, height: 2732, channels: 4, background } })
    .composite([{ input: await sharp(art).resize(600, 600, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer(), gravity: "center" }])
    .png()
    .toFile(root("resources/splash.png"));
  console.log("Icons generated from the logo.");
  try {
    // Arguments, not a shell command line: nothing in the kit can become a command.
    execFileSync("npx", ["--yes", "@capacitor/assets", "generate", "--iconBackgroundColor", background, "--splashBackgroundColor", background], {
      cwd: root(""),
      stdio: "ignore",
      shell: process.platform === "win32",
    });
    rmSync(root("icons"), { recursive: true, force: true });
    rmSync(root("public/manifest.webmanifest"), { force: true });
    console.log("Android and iOS icons updated.");
  } catch {
    console.log("Couldn't update Android/iOS icons automatically; run `npx @capacitor/assets generate` later.");
  }
}

console.log(`\nRebranded as “${name}”. Now rebuild:
  npm run dist:mac | dist:win | dist:linux   (desktop installers)
  npm run cap:sync && npm run android:apk     (Android)
  npm run ios                                 (iOS, then Run in Xcode)
  npm run build && npm start                  (web)`);
