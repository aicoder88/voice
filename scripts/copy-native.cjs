#!/usr/bin/env node
// Stage koffi's native binary so electron-builder can ship it.
//
// koffi 3.x publishes its compiled `koffi.node` as a per-platform optional
// package (e.g. @koromix/koffi-darwin-arm64). Under pnpm's symlinked store,
// electron-builder's dependency walker does not reliably copy that optional
// package into the app bundle, so the packaged app throws
// "Cannot find the native Koffi module".
//
// We resolve the binary through Node's own module resolution (so it keeps
// working across koffi version bumps and on every platform) and copy it to
// build/native/<triplet>/koffi.node. package.json's `extraResources` then
// drops build/native into Contents/Resources/koffi, which is exactly where
// koffi's loader probes via process.resourcesPath at runtime.
const fs = require("node:fs");
const path = require("node:path");

const triplet = `${process.platform}_${process.arch}`; // e.g. darwin_arm64, win32_x64
const pkg = `@koromix/koffi-${process.platform}-${process.arch}`; // hyphenated package name
const rel = `${pkg}/${triplet}/koffi.node`;

// The native package is an optional dependency of koffi, so anchor resolution to
// koffi's own directory. realpath follows pnpm's top-level symlink into the
// virtual store; that covers pnpm (binary is a sibling there) and flat npm
// layouts alike. (koffi's package.json "exports" block forbids require.resolve.)
const koffiDir = fs.realpathSync(
  path.join(__dirname, "..", "node_modules", "koffi")
);
const candidates = [
  // pnpm: @koromix sits next to koffi inside .pnpm/koffi@x/node_modules
  path.join(koffiDir, "..", rel),
  // npm: nested under or hoisted above koffi
  path.join(koffiDir, "node_modules", rel),
];
let src = candidates.find((p) => fs.existsSync(p));
if (!src) {
  // Last resort: Node's resolver starting from koffi's dir.
  try {
    src = require.resolve(rel, { paths: [koffiDir] });
  } catch {
    /* fall through to the error below */
  }
}
if (!src) {
  console.error(
    `[copy-native] Could not locate ${rel}.\n` +
      `Run "pnpm install" on this platform so the matching koffi binary is present, ` +
      `then rebuild.`
  );
  process.exit(1);
}

const destDir = path.join(__dirname, "..", "build", "native", triplet);
const dest = path.join(destDir, "koffi.node");
fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(src, dest);
console.log(`[copy-native] ${triplet}: ${src} -> ${dest}`);
