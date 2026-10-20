#!/bin/sh
# Builds the Mac helpers (electron/native/mac-helper.swift, speech-helper.swift) for Apple silicon
# and Intel into build/native/. electron-builder copies them into the app and signs them.
set -e
[ "$(uname)" = "Darwin" ] || { echo "Skipping the Mac helper (not on macOS)."; exit 0; }
cd "$(dirname "$0")/.."
out=build/native
mkdir -p "$out"
for name in mac speech; do
  for arch in arm64 x86_64; do
    swiftc -O -target "$arch-apple-macos12" "electron/native/$name-helper.swift" -o "$out/adt-$name-helper-$arch"
  done
  lipo -create "$out/adt-$name-helper-arm64" "$out/adt-$name-helper-x86_64" -output "$out/adt-$name-helper"
  rm "$out/adt-$name-helper-arm64" "$out/adt-$name-helper-x86_64"
  echo "Built $out/adt-$name-helper"
done
