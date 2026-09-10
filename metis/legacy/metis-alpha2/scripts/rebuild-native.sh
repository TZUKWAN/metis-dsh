#!/usr/bin/env bash
# rebuild-native.sh — Patch and rebuild native modules for Electron v42
#
# Patches:
#   1. better-sqlite3: V8 API compatibility (External::New, External::Value, SetNativeDataProperty)
#   2. node-pty: Disable SpectreMitigation (requires VS Spectre libs not installed)
#
# Usage: bash scripts/rebuild-native.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ELECTRON_VER="${ELECTRON_VER:-42.3.3}"

echo "=== Rebuilding native modules for Electron $ELECTRON_VER ==="

# ─── Patch better-sqlite3 ───────────────────────────────────────
echo "[1/4] Patching better-sqlite3 V8 APIs..."

BSQL="$ROOT/node_modules/better-sqlite3"

# External::New(isolate, addon) → External::New(isolate, addon, tag)
sed -i 's/v8::External::New(isolate, addon)/v8::External::New(isolate, addon, v8::kExternalPointerTypeTagDefault)/' \
  "$BSQL/src/better_sqlite3.cpp"

# External->Value() → External->Value(tag)  (OnlyAddon macro in macros.cpp)
sed -i 's/->As<v8::External>()->Value())/->As<v8::External>()->Value(v8::kExternalPointerTypeTagDefault))/g' \
  "$BSQL/src/util/macros.cpp"

# SetNativeDataProperty(... 0, ...) → SetNativeDataProperty(... nullptr, ...)
sed -i 's/SetNativeDataProperty(\n\?\s*InternalizedFromLatin1([^)]*),\n\?\s*func,\n\?\s*0,/\n&/; s/,\n\?\s*0,\n\?\s*data/, nullptr, data/' \
  "$BSQL/src/util/helpers.cpp" 2>/dev/null || \
  sed -i '/SetNativeDataProperty/,/data$/ s/\b0,/nullptr,/' "$BSQL/src/util/helpers.cpp"

echo "[1/4] better-sqlite3 patched."

# ─── Patch node-pty ─────────────────────────────────────────────
echo "[2/4] Patching node-pty SpectreMitigation..."

NPTY="$ROOT/node_modules/node-pty"

# Disable SpectreMitigation in main binding.gyp
sed -i "s/'SpectreMitigation': 'Spectre'/'SpectreMitigation': 'false'/g" \
  "$NPTY/binding.gyp"

# Disable SpectreMitigation in winpty sub-project
if [ -f "$NPTY/deps/winpty/src/winpty.gyp" ]; then
  sed -i "s/'SpectreMitigation': 'Spectre'/'SpectreMitigation': 'false'/g" \
    "$NPTY/deps/winpty/src/winpty.gyp"
fi

echo "[2/4] node-pty patched."

# ─── Rebuild better-sqlite3 ──────────────────────────────────────
echo "[3/4] Rebuilding better-sqlite3..."
npx @electron/rebuild -f -w better-sqlite3 -v "$ELECTRON_VER" 2>&1 | tail -3
echo "[3/4] better-sqlite3 rebuilt."

# ─── Rebuild node-pty ───────────────────────────────────────────
echo "[4/4] Rebuilding node-pty..."

# Ensure Electron node.lib is available
ELECTRON_GYP="$HOME/.electron-gyp/$ELECTRON_VER"
mkdir -p "$ELECTRON_GYP/Release"
if [ -f "$ELECTRON_GYP/x64/node.lib" ] && [ ! -f "$ELECTRON_GYP/Release/node.lib" ]; then
  cp "$ELECTRON_GYP/x64/node.lib" "$ELECTRON_GYP/Release/node.lib"
fi

# Configure → patch vcxproj → build
cd "$NPTY"
npx node-gyp configure --target="$ELECTRON_VER" --runtime=electron --nodedir="$ELECTRON_GYP" 2>&1 | tail -1

# Patch any remaining SpectreMitigation in generated vcxproj
find build -name "*.vcxproj" -exec sed -i 's/<SpectreMitigation>Spectre<\/SpectreMitigation>/<SpectreMitigation>false<\/SpectreMitigation>/g' {} + 2>/dev/null || true

npx node-gyp build --target="$ELECTRON_VER" --runtime=electron 2>&1 | tail -3
cd "$ROOT"
echo "[4/4] node-pty rebuilt."

echo ""
echo "=== All native modules rebuilt successfully ==="
echo "  better-sqlite3: $(ls -1 "$BSQL/build/Release/better_sqlite3.node" 2>/dev/null && echo OK || echo MISSING)"
echo "  node-pty:       $(ls -1 "$NPTY/build/Release/pty.node" 2>/dev/null && echo OK || echo MISSING)"
