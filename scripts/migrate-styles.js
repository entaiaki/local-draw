import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function safeFilename(name) {
  return name.replace(/[<>:"\/\\|?*]/g, '_').replace(/\s+/g, ' ').trim();
}

const stylesFile = path.join(root, 'web', 'styles.json');
const thumbSrcDir = path.join(root, 'web', 'style_thumbnails');
const stylesDir = path.join(root, 'web', 'styles');

const styles = JSON.parse(fs.readFileSync(stylesFile, 'utf-8'));
console.log('Total styles:', styles.length);

fs.mkdirSync(stylesDir, { recursive: true });

let copied = 0, skipped = 0, missingThumb = 0;

for (const s of styles) {
  if (!s.tags || !s.image) { skipped++; continue; }
  const srcThumb = path.join(thumbSrcDir, s.image);
  if (!fs.existsSync(srcThumb)) { console.log('  SKIP (no thumbnail):', s.tags); missingThumb++; continue; }
  const ext = path.extname(s.image) || '.webp';
  const destName = safeFilename(s.tags) + ext;
  const destFile = path.join(stylesDir, destName);
  if (fs.existsSync(destFile)) { skipped++; continue; }
  fs.copyFileSync(srcThumb, destFile);
  copied++;
  if (copied <= 3 || copied % 20 === 0) console.log('  COPY:', s.tags, '->', destName);
}

console.log('\nDone. Copied:', copied, 'Skipped:', skipped, 'Missing thumb:', missingThumb);
