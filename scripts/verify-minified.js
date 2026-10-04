// Usage: npm run build && node scripts/verify-minified.js
// Starts only the static layer check against a running server: BASE=http://localhost:3000
// (server must run with NODE_ENV=production or SERVE_MINIFIED=1).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const BASE = process.env.BASE || 'http://localhost:3000';
(async () => {
    let bad = 0;
    for (const f of ['app_v3.js', 'api_v3.js', 'brand_experience.js', 'report_registry.js', 'inline-actions.js', 'login.js', 'signup.js', 'reset-password.js']) {
        const orig = fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
        const res = await fetch(`${BASE}/${f}?v=check`);
        const body = await res.text();
        const tmp = path.join(os.tmpdir(), 'chk-' + f);
        fs.writeFileSync(tmp, body);
        let ok = body.length < orig.length;
        try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); } catch { ok = false; }
        console.log(`${ok ? 'OK ' : 'FAIL'} ${f}: ${orig.length} -> ${body.length}`);
        if (!ok) bad++;
    }
    process.exit(bad ? 1 : 0);
})();
