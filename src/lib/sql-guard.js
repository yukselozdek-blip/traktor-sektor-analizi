'use strict';
// SQL allow-list guard for LLM-generated text-to-SQL, moved verbatim from server.js.

const SQL_ALLOWED_TABLES = new Set([
    'sales_view', 'sales_data', 'brands', 'provinces', 'tractor_models',
    'teknik_veri', 'tuik_veri', 'market_share'
]);
const SQL_DENY_PATTERN = /\b(pg_\w*|information_schema|current_setting|set_config|dblink\w*|lo_\w+|copy|users|payments?|subscriptions?|auth_audit|invoices?|usage_meters?|\w*password\w*|\w*token\w*|\w*secret\w*|\w*api_key\w*|into|pg|txid_\w*|version|current_user|session_user|current_database|inet_\w+|generate_series|unnest|lateral)\b/i;

function isSafeSql(sql) {
    if (typeof sql !== 'string') return false;
    let text = sql.trim();
    if (!text) return false;
    // Tek ifade: sadece sondaki ';' serbest
    text = text.replace(/;\s*$/, '');
    // Metin sabitlerini çıkar (analiz için)
    const stripped = text.replace(/'(?:[^']|'')*'/g, ' 0 ');
    if (stripped.includes(';')) return false;
    if (stripped.includes('--') || stripped.includes('/*') || stripped.includes('*/')) return false;
    if (stripped.includes('"') || stripped.includes('$') || stripped.includes('\\')) return false;
    if (/'/.test(stripped)) return false; // kapanmamış tırnak

    const upper = stripped.toUpperCase();
    const dangerous = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'CREATE', 'GRANT', 'REVOKE', 'EXEC', 'EXECUTE', 'COPY', 'CALL', 'DO', 'VACUUM', 'ANALYZE', 'LOCK', 'LISTEN', 'NOTIFY', 'SET', 'RESET', 'SHOW', 'BEGIN', 'COMMIT', 'ROLLBACK'];
    for (const keyword of dangerous) {
        if (new RegExp(`\\b${keyword}\\b`, 'i').test(upper)) return false;
    }
    if (!/^\s*\(*\s*(SELECT|WITH)\b/i.test(stripped)) return false;
    if (/\bFOR\s+(UPDATE|SHARE|NO\s+KEY)/i.test(stripped)) return false;
    if (SQL_DENY_PATTERN.test(stripped)) return false;

    // CTE adlarını topla (izinli)
    const cteNames = new Set();
    const cteRe = /(?:\bWITH\s+(?:RECURSIVE\s+)?|,\s*)([a-z_][a-z0-9_]*)\s+AS\s*(?:NOT\s+MATERIALIZED\s*|MATERIALIZED\s*)?\(/gi;
    let m;
    while ((m = cteRe.exec(stripped)) !== null) cteNames.add(m[1].toLowerCase());

    // FROM içindeki fonksiyon-benzeri kullanımları (EXTRACT(... FROM ...)) analizden çıkar
    const forTables = stripped
        .replace(/\bIS\s+(?:NOT\s+)?DISTINCT\s+FROM\b/gi, ' ')
        .replace(/\b(EXTRACT|SUBSTRING|TRIM|OVERLAY|POSITION)\s*\([^()]*\)/gi, ' 0 ');

    const fromRe = /\b(?:FROM|JOIN)\s+([^()]*?)(?=\bWHERE\b|\bGROUP\b|\bORDER\b|\bLIMIT\b|\bHAVING\b|\bJOIN\b|\bON\b|\bUNION\b|\bINTERSECT\b|\bEXCEPT\b|\bINNER\b|\bLEFT\b|\bRIGHT\b|\bFULL\b|\bCROSS\b|\bNATURAL\b|\bWINDOW\b|\bOFFSET\b|\bFETCH\b|\)|$)/gi;
    let found = 0;
    while ((m = fromRe.exec(forTables)) !== null) {
        const parts = m[1].split(',');
        for (const part of parts) {
            const tok = part.trim().split(/\s+/)[0];
            if (!tok) continue;
            found++;
            let name = tok.toLowerCase();
            if (name.startsWith('public.')) name = name.slice(7);
            if (name.includes('.')) return false;
            if (!SQL_ALLOWED_TABLES.has(name) && !cteNames.has(name)) return false;
        }
    }
    // Satır içi alt sorgular için "FROM (" durumunda tablo yok sayılır; en az bir FROM yoksa da (ör. SELECT 1) sorun değil
    return true;
}

module.exports = { isSafeSql, SQL_ALLOWED_TABLES, SQL_DENY_PATTERN };
