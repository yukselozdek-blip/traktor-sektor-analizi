'use strict';
// Test yardımcıları: ayrı bir geçici DB üzerinde sunucuyu child process olarak başlatır.
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const BASE_DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';
const SKIP_DB = !BASE_DB_URL;
const SKIP_REASON = 'TEST_DATABASE_URL/DATABASE_URL tanımlı değil: DB testleri atlandı';
if (SKIP_DB) console.log('# ' + SKIP_REASON);

const ROOT = path.join(__dirname, '..');
const TEST_PASSWORD = 'Test-Pass-123!';
const INSIGHTS_API_KEY = 'test-insights-key';
const JWT_SECRET = 'test-secret';

function withDb(url, dbName) {
    const u = new URL(url);
    u.pathname = '/' + dbName;
    return u.toString();
}

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

async function createDatabase(prefix) {
    const name = `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
    const admin = new Pool({ connectionString: BASE_DB_URL, max: 1 });
    try { await admin.query(`CREATE DATABASE ${name}`); } finally { await admin.end(); }
    return {
        name,
        url: withDb(BASE_DB_URL, name),
        async drop() {
            const a = new Pool({ connectionString: BASE_DB_URL, max: 1 });
            try { await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); } finally { await a.end(); }
        }
    };
}

async function startServer({ env = {} } = {}) {
    const db = await createDatabase('test_app');
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const childEnv = {
        ...process.env,
        DATABASE_URL: db.url,
        PORT: String(port),
        NODE_ENV: 'test',
        JWT_SECRET,
        INSIGHTS_API_KEY,
        SUPERUSER_EMAILS: 'super@test.local',
        ...env
    };
    // Dışarıdan gelebilecek ayarlar testi etkilemesin (env ile açıkça verilmedikçe)
    for (const k of ['WHATSAPP_QUERY_API_KEY', 'WHATSAPP_APP_SECRET', 'STRIPE_WEBHOOK_SECRET']) {
        if (!(k in env)) delete childEnv[k];
    }
    const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let logs = '';
    child.stdout.on('data', d => { logs += d; if (logs.length > 20000) logs = logs.slice(-10000); });
    child.stderr.on('data', d => { logs += d; if (logs.length > 20000) logs = logs.slice(-10000); });
    let exited = false;
    child.on('exit', () => { exited = true; });

    const pool = new Pool({ connectionString: db.url, max: 3 });
    pool.on('error', () => {});

    async function stop() {
        try { await pool.end(); } catch (_) { /* noop */ }
        if (!exited) {
            const done = new Promise(r => child.once('exit', r));
            child.kill('SIGTERM');
            const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* noop */ } }, 5000);
            await done;
            clearTimeout(t);
        }
        try { await db.drop(); } catch (e) { console.error('DB drop failed:', e.message); }
    }

    const deadline = Date.now() + 90000;
    let ready = false;
    while (Date.now() < deadline) {
        if (exited) { await stop(); throw new Error('Sunucu erken kapandı:\n' + logs.slice(-3000)); }
        try {
            const r = await fetch(baseUrl + '/health');
            if (r.status === 200) { ready = true; break; }
        } catch (_) { /* henüz hazır değil */ }
        await new Promise(r => setTimeout(r, 500));
    }
    if (!ready) { await stop(); throw new Error('Sunucu 90 sn içinde hazır olmadı:\n' + logs.slice(-3000)); }

    async function api(method, urlPath, { token, body, headers = {}, rawBody } = {}) {
        const h = { ...headers };
        if (token) h.Authorization = `Bearer ${token}`;
        let payload;
        if (rawBody !== undefined) payload = rawBody;
        else if (body !== undefined) { h['Content-Type'] = h['Content-Type'] || 'application/json'; payload = JSON.stringify(body); }
        const res = await fetch(baseUrl + urlPath, { method, headers: h, body: payload });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* json değil */ }
        return { status: res.status, headers: res.headers, text, json };
    }

    async function createUser({ role = 'brand_user', email, password = TEST_PASSWORD, active = true } = {}) {
        email = (email || `u_${crypto.randomBytes(5).toString('hex')}@test.local`).toLowerCase();
        const hash = await bcrypt.hash(password, 4);
        const r = await pool.query(
            `INSERT INTO users (email, password_hash, full_name, role, is_active) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
            [email, hash, 'Test User', role, active]
        );
        return { id: r.rows[0].id, email, password, role };
    }

    // Kullanıcıyı DB'de oluşturur ve /api/auth/login ile JWT alır (1 login çağrısı).
    async function createUserWithToken(opts = {}) {
        const user = await createUser(opts);
        const res = await api('POST', '/api/auth/login', { body: { email: user.email, password: user.password } });
        if (res.status !== 200 || !res.json?.token) throw new Error(`Login başarısız (${res.status}): ${res.text}`);
        return { ...user, token: res.json.token };
    }

    return { baseUrl, port, pool, api, stop, createUser, createUserWithToken, logs: () => logs, child };
}

module.exports = { startServer, createDatabase, SKIP_DB, SKIP_REASON, TEST_PASSWORD, INSIGHTS_API_KEY, JWT_SECRET, BASE_DB_URL };
