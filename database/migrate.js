'use strict';
// Basit, güvenli SQL migration çalıştırıcı.
// - schema_migrations tablosunda uygulanan sürümleri tutar
// - pg_advisory_lock ile çoklu replika yarışını önler
// - her dosya kendi transaction'ında çalışır (hata -> ROLLBACK + throw)
const fs = require('fs');
const path = require('path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const LOCK_KEY = 727401; // keyfi sabit advisory-lock anahtarı

async function runMigrations(pool, { logger = console, dir = MIGRATIONS_DIR } = {}) {
    const client = await pool.connect();
    let locked = false;
    try {
        await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
        locked = true;
        await client.query(`
            CREATE TABLE IF NOT EXISTS schema_migrations (
                version TEXT PRIMARY KEY,
                name TEXT,
                applied_at TIMESTAMPTZ DEFAULT NOW()
            )`);
        const files = fs.readdirSync(dir).filter(f => /\.sql$/i.test(f)).sort();
        const applied = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map(r => r.version));
        let count = 0;
        for (const file of files) {
            const version = file.split('_')[0];
            if (applied.has(version)) continue;
            const sql = fs.readFileSync(path.join(dir, file), 'utf8');
            try {
                await client.query('BEGIN');
                await client.query(sql);
                await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [version, file]);
                await client.query('COMMIT');
                count++;
                logger.log(`✅ Migration uygulandı: ${file}`);
            } catch (err) {
                try { await client.query('ROLLBACK'); } catch (_) { /* noop */ }
                logger.error(`❌ MIGRATION BAŞARISIZ: ${file} — ${err.message}. Sonraki migration'lar uygulanmadı.`);
                const e = new Error(`Migration ${file} failed: ${err.message}`);
                e.cause = err;
                throw e;
            }
        }
        if (count === 0) logger.log('✅ Veritabanı şeması güncel (bekleyen migration yok)');
        return { applied: count };
    } finally {
        if (locked) { try { await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]); } catch (_) { /* noop */ } }
        client.release();
    }
}

module.exports = { runMigrations };

if (require.main === module) {
    try { require('dotenv').config(); } catch (_) { /* optional */ }
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    runMigrations(pool)
        .then(() => pool.end())
        .catch(async (err) => { console.error(err.message); await pool.end().catch(() => {}); process.exit(1); });
}
