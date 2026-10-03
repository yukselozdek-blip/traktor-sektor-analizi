'use strict';
// Runs server.js with the dump-routes preload and returns the route table text.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

function dumpRoutes() {
    const r = spawnSync(process.execPath, ['-r', './tests/support/dump-routes.js', 'server.js'], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 60000,
        env: {
            ...process.env,
            DATABASE_URL: 'postgres://x:x@127.0.0.1:1/x',
            PORT: '0',
            NODE_ENV: 'test',
            JWT_SECRET: 'route-dump-secret'
        }
    });
    const m = /ROUTEDUMP_BEGIN\n([\s\S]*?)\nROUTEDUMP_END/.exec(r.stdout || '');
    if (!m) throw new Error('route dump not found. stdout:\n' + (r.stdout || '') + '\nstderr:\n' + (r.stderr || ''));
    return m[1] + '\n';
}

module.exports = { dumpRoutes, ROOT };
