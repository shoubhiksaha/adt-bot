// Rebrands the installable apps from a brand kit exported in Settings → Appearance.
//   npm run brand path/to/brand-kit.json
// Updates the app name, icons (desktop, PWA, Android, iOS) and the default theme, then tells you
// what to rebuild. Run it from a clean checkout so you can review the changes with git.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
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
const name = String(kit.name || "ADT Bot").trim();

// 1. Default brand inside the app.
writeFileSync(root("src/brand.json"), `${JSON.stringify({ name, logo: kit.logo || "", logoAsAvatar: Boolean(kit.logoAsAvatar), theme: kit.theme }, null, 2)}\n`);

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
if (kit.logo?.startsWith("data:image")) {
  const logo = Buffer.from(kit.logo.split(",")[1], "base64");
  const background = kit.theme?.background || "#ffffff";
  const icon = async (file, size, padding = 0.16) => {
    const inner = Math.round(size * (1 - padding * 2));
    const art = await sharp(logo).resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    await sharp({ create: { width: size, height: size, channels: 4, background } })
      .composite([{ input: art, gravity: "center" }])
      .png()
      .toFile(root(file));
  };
  await icon("build/icon.png", 1024);
  await icon("resources/icon.png", 1024);
  await icon("public/icon-192.png", 192);
  await icon("public/icon-512.png", 512);
  await icon("public/apple-touch-icon.png", 180);
  await sharp({ create: { width: 2732, height: 2732, channels: 4, background } })
    .composite([{ input: await sharp(logo).resize(600, 600, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer(), gravity: "center" }])
    .png()
    .toFile(root("resources/splash.png"));
  console.log("Icons generated from the logo.");
  try {
    execSync(
      `npx --yes @capacitor/assets generate --iconBackgroundColor '${background}' --splashBackgroundColor '${background}'`,
      { cwd: root(""), stdio: "ignore" },
    );
    execSync("rm -rf icons public/manifest.webmanifest", { cwd: root("") });
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
