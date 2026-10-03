'use strict';
// PostgreSQL pool moved verbatim from server.js (DATABASE_URL read at require time;
// dotenv is loaded first by server.js).
const { Pool } = require('pg');

function shouldUseDatabaseSsl(connectionString) {
    if (process.env.NODE_ENV !== 'production' || !connectionString) return false;

    try {
        const hostname = (new URL(connectionString).hostname || '').toLowerCase();
        const localHosts = ['localhost', '127.0.0.1', 'postgres', 'host.docker.internal'];
        if (!hostname) return false;
        if (localHosts.includes(hostname)) return false;
        if (hostname.endsWith('.internal')) return false;
        return true;
    } catch {
        return false;
    }
}

// Database
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: shouldUseDatabaseSsl(process.env.DATABASE_URL)
        ? { rejectUnauthorized: false }
        : false
});

module.exports = { pool, shouldUseDatabaseSsl };
