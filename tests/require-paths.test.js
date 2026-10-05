'use strict';
// Dosya bölme sırasında satır içi (lazy) göreli require yollarının kayması çalışma zamanında
// patlar; bu test src/ ve server.js içindeki tüm göreli require yollarının çözüldüğünü doğrular.
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e =>
        e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []);
}

// Bölmeden önce de var olmayan dosya (POST /api/admin/seed-model-images her zaman 500 döner).
const KNOWN_MISSING = new Set(['src/routes/seed-admin.js: ../../scripts/seed-model-images']);

it('göreli require yolları çözülür', () => {
    const files = [path.join(ROOT, 'server.js'), ...walk(path.join(ROOT, 'src'))];
    const bad = [];
    for (const f of files) {
        const src = fs.readFileSync(f, 'utf8');
        for (const m of src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]*)['"]\s*\)/g)) {
            try { require.resolve(path.resolve(path.dirname(f), m[1])); } catch { bad.push(`${path.relative(ROOT, f)}: ${m[1]}`); }
        }
    }
    assert.deepEqual(bad.filter(b => !KNOWN_MISSING.has(b)), []);
});
