#!/bin/bash
# Geri yükleme tatbikatı: yedeği (şifreliyse çözerek) GEÇİCİ bir veritabanına yükler ve
# içeriği doğrular. Üretim veritabanına ASLA dokunmaz.
#
# Kullanım:
#   BACKUP_PASSPHRASE=... bash scripts/restore-drill.sh <dump veya dump.gpg> <geçici-hedef-db-url>
set -euo pipefail

if [[ $# -lt 2 ]]; then
    echo "Kullanım: bash scripts/restore-drill.sh <dump|dump.gpg> <hedef-database-url>" >&2
    exit 1
fi
FILE="$1"; TARGET_URL="$2"
MIN_TABLES="${MIN_TABLES:-50}"

if [[ "$TARGET_URL" =~ (railway\.app|rlwy\.net) ]]; then
    echo "Hata: Hedef üretim sunucusu gibi görünüyor; tatbikat yalnızca geçici veritabanına yapılır." >&2
    exit 1
fi
[[ -f "$FILE" ]] || { echo "Hata: dosya yok: $FILE" >&2; exit 1; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
DUMP="$FILE"
if [[ "$FILE" == *.gpg ]]; then
    : "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE gerekli (.gpg dosyası)}"
    DUMP="$WORK/restore.dump"
    printf '%s' "$BACKUP_PASSPHRASE" | gpg --batch --yes --pinentry-mode loopback --passphrase-fd 0 -d -o "$DUMP" "$FILE"
fi

LISTED=$(pg_restore --list "$DUMP" | grep -c "TABLE DATA" || true)
echo "Yedekteki veri tablosu: $LISTED"
[[ "$LISTED" -ge "$MIN_TABLES" ]] || { echo "Hata: beklenenden az tablo ($LISTED < $MIN_TABLES)" >&2; exit 1; }

START=$(date +%s)
pg_restore --no-owner --exit-on-error --dbname "$TARGET_URL" "$DUMP"
echo "Geri yükleme süresi: $(( $(date +%s) - START )) sn"

q() { psql "$TARGET_URL" -tAc "$1"; }
TABLES=$(q "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")
echo "Geri yüklenen tablo sayısı: $TABLES"
fail=0
for t in ${REQUIRED_TABLES:-users brands provinces subscription_plans schema_migrations}; do
    n=$(q "SELECT count(*) FROM $t" 2>/dev/null || echo ERR)
    echo "  $t: $n"
    if [[ "$n" == "ERR" || "$n" -lt 1 ]]; then echo "  ::HATA:: $t boş/yok" >&2; fail=1; fi
done
[[ "$fail" -eq 0 ]] || { echo "Tatbikat BAŞARISIZ" >&2; exit 1; }
echo "Tatbikat BAŞARILI: yedek geri yüklenebiliyor ve temel tablolar dolu."
