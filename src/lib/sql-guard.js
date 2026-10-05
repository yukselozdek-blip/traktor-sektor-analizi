'use strict';
// SQL allow-list guard for LLM-generated text-to-SQL, moved verbatim from server.js.

const SQL_ALLOWED_TABLES = new Set([
    'sales_view', 'sales_data', 'brands', 'provinces', 'tractor_models',
    'teknik_veri', 'tuik_veri', 'market_share'
]);
const SQL_DENY_PATTERN = /\b(pg_\w*|information_schema|current_setting|set_config|dblink\w*|lo_\w+|copy|users|payments?|subscriptions?|auth_audit|invoices?|usage_meters?|\w*password\w*|\w*token\w*|\w*secret\w*|\w*api_key\w*|into|pg|txid_\w*|version|current_user|session_user|current_database|inet_\w+|generate_series|unnest|lateral)\b/i;

// Fonksiyon allow-list'i: LLM'in üretebileceği salt-okunur analiz fonksiyonları. Listede olmayan her fonksiyon çağrısı
// (query_to_xml, table_to_xml, repeat, current_schema, regexp_*, array_agg(... ) vb.) reddedilir.
const SQL_ALLOWED_FUNCTIONS = new Set([
    'sum', 'count', 'avg', 'min', 'max', 'round', 'coalesce', 'nullif', 'greatest', 'least', 'abs', 'ceil', 'ceiling', 'floor',
    'power', 'sqrt', 'mod', 'sign', 'upper', 'lower', 'initcap', 'trim', 'ltrim', 'rtrim', 'btrim', 'replace', 'translate',
    'substring', 'substr', 'left', 'right', 'length', 'char_length', 'position', 'concat', 'concat_ws', 'split_part', 'overlay',
    'extract', 'date_trunc', 'date_part', 'to_char', 'to_date', 'to_number', 'age', 'make_date',
    'row_number', 'rank', 'dense_rank', 'percent_rank', 'cume_dist', 'ntile', 'lag', 'lead', 'first_value', 'last_value', 'nth_value',
    'percentile_cont', 'percentile_disc', 'stddev', 'stddev_pop', 'stddev_samp', 'variance', 'var_pop', 'var_samp', 'corr', 'mode',
    'bool_and', 'bool_or', 'string_agg',
    // tür adları (CAST(x AS numeric(12,2)), x::varchar(20))
    'cast', 'numeric', 'decimal', 'varchar', 'char', 'character', 'int', 'integer', 'bigint', 'smallint', 'float', 'double', 'real', 'text', 'date', 'timestamp'
]);
// '(' öncesinde fonksiyon olmayan SQL sözcükleri
const SQL_PAREN_KEYWORDS = new Set([
    'select', 'from', 'join', 'on', 'where', 'and', 'or', 'not', 'in', 'exists', 'any', 'all', 'some', 'as', 'with', 'union', 'intersect',
    'except', 'over', 'partition', 'order', 'by', 'group', 'having', 'filter', 'within', 'using', 'values', 'when', 'then', 'else', 'case',
    'end', 'between', 'like', 'ilike', 'is', 'limit', 'offset', 'distinct', 'asc', 'desc', 'nulls', 'rows', 'range', 'unbounded', 'preceding',
    'following', 'current', 'row', 'inner', 'left', 'right', 'full', 'outer', 'cross', 'natural', 'materialized', 'recursive', 'interval', 'array', 'similar', 'to', 'at', 'zone', 'by'
]);
const MAX_JOINS = 6;

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

    // Fonksiyon allow-list'i (query_to_xml, repeat, current_schema ... gibi deny listesinde olmayanları da engeller)
    const fnRe = /\b([a-z_][a-z0-9_]*)\s*\(/gi;
    let fm;
    while ((fm = fnRe.exec(stripped)) !== null) {
        const fn = fm[1].toLowerCase();
        if (SQL_PAREN_KEYWORDS.has(fn)) continue;
        if (!SQL_ALLOWED_FUNCTIONS.has(fn)) return false;
    }
    // Parantezli birleşim (FROM (a CROSS JOIN b)) tablo denetimini atlatıyordu: FROM/JOIN'den sonra yalnızca alt sorgu parantezi olabilir
    if (/\b(?:FROM|JOIN)\s*\(\s*(?!\(*\s*(?:SELECT|WITH|VALUES)\b)/i.test(stripped)) return false;
    // Kartezyen çarpım / aşırı birleşim = kaynak tüketme (DoS)
    if (/\bCROSS\s+JOIN\b/i.test(stripped)) return false;
    if ((stripped.match(/\bJOIN\b/gi) || []).length > MAX_JOINS) return false;

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
    let commaJoins = 0; // FROM a, b, c (örtük birleşim) JOIN sayacını atlıyordu
    while ((m = fromRe.exec(forTables)) !== null) {
        const parts = m[1].split(',');
        commaJoins += Math.max(0, parts.filter(p => p.trim()).length - 1);
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
    // Virgüllü (örtük) birleşimler de Kartezyen çarpım riskidir: en fazla 2, ve JOIN'lerle birlikte MAX_JOINS'i aşmaz
    const explicitJoins = (stripped.match(/\bJOIN\b/gi) || []).length;
    if (commaJoins > 2 || explicitJoins + commaJoins > MAX_JOINS) return false;
    // Satır içi alt sorgular için "FROM (" durumunda tablo yok sayılır; en az bir FROM yoksa da (ör. SELECT 1) sorun değil
    return true;
}

module.exports = { isSafeSql, SQL_ALLOWED_TABLES, SQL_DENY_PATTERN, SQL_ALLOWED_FUNCTIONS };
