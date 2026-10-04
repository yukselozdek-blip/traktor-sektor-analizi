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
const intEnv = (name, fallback) => {
    const n = parseInt(process.env[name] || '', 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
};

// Havuz: Railway Postgres varsayılanı ~100 bağlantı; tek uygulama örneği için 20 güvenli.
// statement_timeout takılan/ağır bir sorgunun bağlantıyı sonsuza dek tutmasını engeller
// (0 = kapalı). Seed/içe aktarma işleri de bu havuzu kullandığı için varsayılan cömert (2 dk).
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: shouldUseDatabaseSsl(process.env.DATABASE_URL)
        ? { rejectUnauthorized: false }
        : false,
    max: intEnv('PG_POOL_MAX', 20),
    idleTimeoutMillis: intEnv('PG_IDLE_TIMEOUT_MS', 30000),
    connectionTimeoutMillis: intEnv('PG_CONNECT_TIMEOUT_MS', 10000),
    statement_timeout: intEnv('PG_STATEMENT_TIMEOUT_MS', 120000)
});

// Boştaki bir bağlantı koptuğunda (Postgres yeniden başlarsa) süreç düşmesin; havuz yenisini açar.
pool.on('error', err => console.error('[pg] boşta bağlantı hatası:', err.message));

module.exports = { pool, shouldUseDatabaseSsl };
