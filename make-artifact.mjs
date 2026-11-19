// Turns the Vite build into a page fragment the Artifact publisher accepts.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
// DIST, OUT and TITLE let a second page be made from a second build (the blockout map)
const DIST = process.env.DIST || 'dist', OUT = process.env.OUT || 'artifact/skyline-heist.html';
const html = readFileSync(`${DIST}/index.html`, 'utf8');
const pick = (re) => html.match(re)[1];
const title = process.env.TITLE || pick(/<title>([\s\S]*?)<\/title>/);
const style = pick(/<style>([\s\S]*?)<\/style>/);
const script = pick(/<script type="module"[^>]*src="\.\/([^"]+)"/);
const body = pick(/<body>([\s\S]*?)<\/body>/);
mkdirSync('artifact', { recursive: true });
writeFileSync(OUT, `<title>${title}</title>\n<style>${style}</style>\n${body}\n<script type="module" src="./${script}"></script>\n`);
console.log(script);
