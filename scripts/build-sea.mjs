#!/usr/bin/env node
// Builds the API server as a single executable (Node "single executable
// application", SEA) for the machine it runs on. Replaces `pkg`, which is
// abandoned and stuck on Node 18.
//
//   node scripts/build-sea.mjs            -> bin/music-server-<target-triple>[.exe]
//   node scripts/build-sea.mjs --out <f>  -> a custom output path
//
// Steps: bundle server.js with esbuild into one CommonJS file, turn it into a
// SEA blob with the running Node, copy that Node binary and inject the blob
// with postject. On macOS the copy is re-signed ad hoc so it can run.
//
// The output name carries the Rust target triple because Tauri's externalBin
// expects `<name>-<triple>`. It also stages ffmpeg and yt-dlp next to it under
// the same convention (bin/ffmpeg-<triple>, bin/yt-dlp-<triple>) when it can
// find them, so the desktop bundle ships everything the server needs. A SEA
// runs only on the OS/arch it was built on: build on each platform (CI does).
import { execFileSync } from 'node:child_process';
import { copyFileSync, chmodSync, existsSync, mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';
const exe = isWindows ? '.exe' : '';

const TRIPLES = {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'win32-x64': 'x86_64-pc-windows-msvc',
    'win32-arm64': 'aarch64-pc-windows-msvc',
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'linux-arm64': 'aarch64-unknown-linux-gnu'
};
// The postject sentinel Node looks for; fixed by Node, documented in the SEA guide.
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

function log(msg) { console.log(`[build-sea] ${msg}`); }

function run(cmd, args, opts = {}) {
    execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });
}

function parseArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--out') args.out = argv[++i];
        else throw new Error(`Unknown argument: ${argv[i]}`);
    }
    return args;
}

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
    throw new Error(`Node ${process.versions.node} is too old: the server needs node:sqlite (Node >= 22.13).`);
}

const triple = TRIPLES[`${process.platform}-${process.arch}`];
if (!triple) throw new Error(`Unsupported platform ${process.platform}-${process.arch}`);

const args = parseArgs(process.argv.slice(2));
const binDir = path.join(root, 'bin');
const outFile = path.resolve(root, args.out || path.join('bin', `music-server-${triple}${exe}`));
const work = path.join(root, 'build', 'sea');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(path.dirname(outFile), { recursive: true });

// 1. Bundle. ffmpeg-static stays external: its binary lives in node_modules,
//    which does not ship; services/paths.js never requires it when packaged.
log('bundling server.js');
const esbuild = require('esbuild');
const bundle = path.join(work, 'server.cjs');
await esbuild.build({
    entryPoints: [path.join(root, 'server.js')],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: ['ffmpeg-static'],
    legalComments: 'external',
    logLevel: 'warning'
});

// 2. SEA blob from the bundle.
log('generating SEA blob');
const blob = path.join(work, 'sea-prep.blob');
const config = path.join(work, 'sea-config.json');
writeFileSync(config, JSON.stringify({
    main: bundle,
    output: blob,
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: false
}, null, 2));
run(process.execPath, ['--experimental-sea-config', config]);

// 3. Copy this Node binary and inject the blob.
log(`writing ${path.relative(root, outFile)}`);
rmSync(outFile, { force: true });
copyFileSync(process.execPath, outFile);
chmodSync(outFile, 0o755);
if (isMac) run('codesign', ['--remove-signature', outFile]);

const postject = path.join(root, 'node_modules', 'postject', 'dist', 'cli.js');
const postjectArgs = [postject, outFile, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', SEA_FUSE];
if (isMac) postjectArgs.push('--macho-segment-name', 'NODE_SEA');
run(process.execPath, postjectArgs);

// Ad-hoc signature: unsigned binaries are killed on Apple Silicon. A release
// build re-signs with a Developer ID (see docs/packaging.md).
if (isMac) run('codesign', ['--sign', '-', outFile]);

// 4. Stage the helper binaries for Tauri's externalBin, when available.
function stage(name, sources) {
    const target = path.join(binDir, `${name}-${triple}${exe}`);
    const source = sources.find((p) => p && existsSync(p));
    if (!source) {
        log(`WARNING: no ${name} found to stage as ${path.relative(root, target)} (set ${name === 'ffmpeg' ? 'FFMPEG_PATH' : 'YTDLP_PATH'})`);
        return;
    }
    if (path.resolve(source) !== path.resolve(target)) copyFileSync(source, target);
    chmodSync(target, 0o755);
    log(`staged ${path.relative(root, target)} from ${source}`);
}

let ffmpegStatic = null;
try { ffmpegStatic = require('ffmpeg-static'); } catch { /* not installed */ }
stage('ffmpeg', [process.env.FFMPEG_PATH, ffmpegStatic]);
stage('yt-dlp', [
    process.env.YTDLP_PATH,
    path.join(binDir, isWindows ? 'yt-dlp.exe' : isMac ? 'yt-dlp_macos' : 'yt-dlp')
]);

const mb = (statSync(outFile).size / 1024 / 1024).toFixed(1);
log(`done: ${path.relative(root, outFile)} (${mb} MB)`);
