#!/bin/bash
set -euo pipefail

# Kullanım
if [[ $# -lt 2 ]]; then
    cat >&2 <<'EOF'
Kullanım:
  bash scripts/restore-db.sh <dump-file> <target-database-url>

Örnek:
  bash scripts/restore-db.sh backups/traktor-sektor-analizi_hetzner-storagebox_20260103-143022.dump "postgresql://..."

DİKKAT: Bu, hedef veritabanındaki tüm verileri değiştirir!
EOF
    exit 1
fi

DUMP_FILE="$1"
TARGET_URL="$2"

# Dump dosyasının var olup olmadığını kontrol et
if [[ ! -f "$DUMP_FILE" ]]; then
    echo "Hata: Yedek dosyası bulunamadı: $DUMP_FILE" >&2
    exit 1
fi

# pg_restore kontrolü
if ! command -v pg_restore &> /dev/null; then
    echo "Hata: pg_restore bulunamadı. PostgreSQL istemcisini yükleyin." >&2
    echo "Ubuntu: sudo apt install postgresql-client" >&2
    exit 1
fi

# Üretim sunucusu uyarısı
# railway.app veya rlwy.net içeren hostname'i tespit et
if [[ "$TARGET_URL" =~ (railway\.app|rlwy\.net) ]]; then
    if [[ "${I_UNDERSTAND_THIS_OVERWRITES:-}" != "yes" ]]; then
        cat >&2 <<'EOF'
UYARI: Hedef, üretim sunucusu gibi görünüyor!

Bu işlem TÜM VERİLERİ değiştirecektir.

Emin misiniz? Devam etmek için:
  I_UNDERSTAND_THIS_OVERWRITES=yes bash scripts/restore-db.sh ...
EOF
        exit 1
    fi
fi

echo "Geri yükleniyor: $DUMP_FILE"
pg_restore --clean --if-exists --no-owner --dbname "$TARGET_URL" "$DUMP_FILE"

echo "Başarılı!"
