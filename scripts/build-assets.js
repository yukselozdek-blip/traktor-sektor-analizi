// Minifies front-end assets into public/dist/*.min.(js|css).
// Semantics-preserving: no bundling, no identifier renaming (inline onclick="..."
// handlers reference globals by name), whitespace + syntax minification only.
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

const PUBLIC = path.join(__dirname, '..', 'public');
const DIST = path.join(PUBLIC, 'dist');

const JS = ['app_v3.js', 'api_v3.js', 'brand_experience.js', 'report_registry.js'];
const CSS = ['style.css', 'billing.css', 'media-watch.css'];

async function main() {
    fs.rmSync(DIST, { recursive: true, force: true });
    fs.mkdirSync(DIST, { recursive: true });
    for (const f of [...JS, ...CSS]) {
        const isJs = f.endsWith('.js');
        const out = path.join(DIST, f.replace(/\.(js|css)$/, '.min.$1'));
        await esbuild.build({
            entryPoints: [path.join(PUBLIC, f)],
            outfile: out,
            bundle: false,
            minifyWhitespace: true,
            minifySyntax: true,
            minifyIdentifiers: false,
            target: isJs ? 'es2019' : 'chrome80',
            charset: 'utf8',
            legalComments: 'none',
            logLevel: 'warning'
        });
        const a = fs.statSync(path.join(PUBLIC, f)).size;
        const b = fs.statSync(out).size;
        console.log(`${f}: ${a} -> ${b} bytes`);
    }
}

main().catch(err => { console.error(err); process.exit(1); });
