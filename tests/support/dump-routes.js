'use strict';
// Preload script: `node -r tests/support/dump-routes.js server.js`
// Patches express' app.listen to print the registered route table
// (method, path, handler-name chain, middleware names) between markers and exit.
// Needs no database. Output is deterministic (no timestamps / absolute paths).
const express = require('express');

express.application.listen = function () {
    const out = [];
    for (const l of this._router.stack) {
        if (l.route) {
            const methods = Object.keys(l.route.methods).join(',').toUpperCase();
            out.push(`${methods} ${JSON.stringify(l.route.path)} [${l.route.stack.map(s => s.name || 'anon').join('>')}]`);
        } else {
            out.push(`MW ${l.name || 'anon'} ${String(l.regexp)}`);
        }
    }
    process.stdout.write('ROUTEDUMP_BEGIN\n' + out.join('\n') + '\nROUTEDUMP_END\n', () => process.exit(0));
};
