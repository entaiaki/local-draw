import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function loadConfig() {
  const here = path.join(root, 'web');
  const configPath = path.join(root, 'node-server', 'config.json');
  if (fs.existsSync(configPath)) {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (cfg.workflows_dir) return cfg.workflows_dir;
  }
  // Default
  return 'C:/Users/acofo/Desktop/ComfyUI-WorkFisher-V2/ComfyUI/user/default/workflows';
}

const workflowsDir = loadConfig();
const tagsDir = path.join(workflowsDir, 'tags');

const categories = new Set();

for (const subdir of ['WAI', 'ANIMA']) {
  const dir = path.join(workflowsDir, subdir);
  if (!fs.existsSync(dir)) continue;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) categories.add(entry.name);
  }
}

fs.mkdirSync(tagsDir, { recursive: true });

let created = 0;
for (const cat of categories) {
  const catPath = path.join(tagsDir, cat);
  if (!fs.existsSync(catPath)) {
    fs.mkdirSync(catPath);
    console.log('  CREATE:', cat);
    created++;
  } else {
    console.log('  EXISTS:', cat);
  }
}

console.log(`\nDone. ${categories.size} categories, ${created} created.`);
