const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const SKIP_NAMES = new Set(['node_modules', '.git', '.comment-backup']);
const PRESERVE_FILES = new Set(['LICENSE', 'README.md']);
const EXTENSIONS = new Set(['.js', '.jsx', '.css', '.html', '.md', '.py', '.sh']);

function shouldProcess(filePath) {
  const base = path.basename(filePath);
  if (PRESERVE_FILES.has(base)) return false;
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSIONS.has(ext);
}

function walk(dir, cb) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (SKIP_NAMES.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, cb);
    else cb(full);
  }
}

function processFile(file) {
  if (!shouldProcess(file)) return;
  let s;
  try { s = fs.readFileSync(file, 'utf8'); } catch (err) { return; }
  const lines = s.split(/\r?\n/);
  const out = [];
  let inBlock = false;
  let blockStartsWithDoc = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    if (!inBlock) {
      if (/^\/\*(?!\*)/.test(trimmed)) {
        inBlock = true;
        blockStartsWithDoc = false;
        if (trimmed.includes('*/')) {
          inBlock = false;
          continue;
        }
        continue;
      }
      if (/^\/\*\*/.test(trimmed)) {
        out.push(line);
        if (!trimmed.includes('*/')) {
          inBlock = true;
          blockStartsWithDoc = true;
        }
        continue;
      }
      if (/^<!--/.test(trimmed)) {
        if (!trimmed.includes('-->')) {
          inBlock = true;
          blockStartsWithDoc = false;
        }
        continue;
      }
      if (/^(\/\/|#)/.test(trimmed)) continue;

      if (/^\/\*/.test(trimmed)) {
      }

      out.push(line);
    } else {
      if (blockStartsWithDoc) {
        out.push(line);
        if (trimmed.includes('*/')) {
          inBlock = false;
          blockStartsWithDoc = false;
        }
      } else {
        if (trimmed.includes('*/') || trimmed.includes('-->')) {
          inBlock = false;
        }
      }
    }
  }

  const newContent = out.join('\n');
  if (newContent !== s) {
    fs.writeFileSync(file, newContent, 'utf8');
    console.log('Updated:', path.relative(ROOT, file));
  }
}

console.log('Scanning and cleaning comments (preserving JSDoc + LICENSE/README)...');
walk(ROOT, processFile);
console.log('Done.');
