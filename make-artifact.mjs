// Turns the Vite build into a page fragment the Artifact publisher accepts.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const html = readFileSync('dist/index.html', 'utf8');
const pick = (re) => html.match(re)[1];
const title = pick(/<title>([\s\S]*?)<\/title>/);
const style = pick(/<style>([\s\S]*?)<\/style>/);
const script = pick(/<script type="module"[^>]*src="\.\/([^"]+)"/);
const body = pick(/<body>([\s\S]*?)<\/body>/);
mkdirSync('artifact', { recursive: true });
writeFileSync('artifact/skyline-heist.html', `<title>${title}</title>\n<style>${style}</style>\n${body}\n<script type="module" src="./${script}"></script>\n`);
console.log(script);
