#!/bin/sh
# Builds the Mac helper (electron/native/mac-helper.swift) for Apple silicon and Intel into
# build/native/adt-mac-helper. electron-builder copies it into the app and signs it.
set -e
[ "$(uname)" = "Darwin" ] || { echo "Skipping the Mac helper (not on macOS)."; exit 0; }
cd "$(dirname "$0")/.."
out=build/native
mkdir -p "$out"
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos12" electron/native/mac-helper.swift -o "$out/adt-mac-helper-$arch"
done
lipo -create "$out/adt-mac-helper-arm64" "$out/adt-mac-helper-x86_64" -output "$out/adt-mac-helper"
rm "$out/adt-mac-helper-arm64" "$out/adt-mac-helper-x86_64"
echo "Built $out/adt-mac-helper"
