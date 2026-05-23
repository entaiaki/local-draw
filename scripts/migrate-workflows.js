import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const workflowsDir = 'C:/Users/acofo/Desktop/ComfyUI-WorkFisher-V2/ComfyUI/user/default/workflows';
const metaFile = path.join(root, 'web', 'workflow_meta.json');
const thumbDir = path.join(root, 'web', 'thumbnails');

function safeName(s) {
  return s.replace(/[<>:"\/\\|?*]/g, ' - ').replace(/\s+/g, ' ').trim();
}

const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
console.log('Total meta entries:', meta.length);

for (const entry of meta) {
  const wfPath = entry.workflow;
  const parts = wfPath.split('/');
  if (parts.length < 2) continue;
  const subDir = parts[0];
  const wfName = parts.slice(1).join('/');
  const category = safeName(entry.category || '\u672a\u5206\u7c7b');

  const srcFile = path.join(workflowsDir, subDir, wfName);
  const destDir = path.join(workflowsDir, subDir, category);
  const destFile = path.join(destDir, wfName);

  if (!fs.existsSync(srcFile)) {
    console.log('  SKIP (not found):', srcFile);
    continue;
  }

  fs.mkdirSync(destDir, { recursive: true });
  fs.renameSync(srcFile, destFile);
  console.log('  MOVE:', subDir + '/' + wfName, '->', subDir + '/' + category + '/' + wfName);

  if (entry.thumbnail) {
    const thumbSrc = path.join(thumbDir, entry.thumbnail);
    if (fs.existsSync(thumbSrc)) {
      const baseName = wfName.replace(/\.json$/i, '');
      const thumbExt = path.extname(entry.thumbnail) || '.png';
      const thumbDest = path.join(destDir, baseName + thumbExt);
      fs.copyFileSync(thumbSrc, thumbDest);
      console.log('  THUMB:', baseName + thumbExt);
    }
  }
}

console.log('\nDone.');
