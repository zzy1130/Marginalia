#!/bin/bash
set -e
cd "$(dirname "$0")/.."

APP_NAME="Marginalia"
echo "=== Packaging $APP_NAME ==="

# 1. Build (postBuild hook bundles Python automatically)
echo "[1/3] Building..."
bun install --silent 2>/dev/null
npx electrobun build env=canary 2>&1 | grep -v "generating a patch\|bucketUrl\|ConnectionRefused\|ERR_INVALID\|error:" || true

APP_DIR="build/canary/${APP_NAME}-canary.app"

# 2. Ad-hoc sign
echo "[2/3] Signing..."
codesign -s - --force --deep --timestamp=none "$APP_DIR" 2>/dev/null || true

# 3. Create DMG with Applications link
echo "[3/3] Creating DMG..."
rm -rf dist; mkdir -p dist/dmg-staging
cp -R "$APP_DIR" "dist/dmg-staging/${APP_NAME}.app"
ln -s /Applications dist/dmg-staging/Applications
hdiutil create -volname "$APP_NAME" -srcfolder dist/dmg-staging -ov -format UDBZ "dist/${APP_NAME}.dmg" 2>&1 | tail -1
codesign -s - --force --timestamp=none "dist/${APP_NAME}.dmg" 2>/dev/null || true
rm -rf dist/dmg-staging

echo ""
echo "=== Done: dist/${APP_NAME}.dmg ($(du -sh dist/${APP_NAME}.dmg | cut -f1)) ==="
echo "安装: 打开DMG → 拖到Applications → 右键打开(首次)"
echo "如提示损坏: xattr -cr /Applications/${APP_NAME}.app"
