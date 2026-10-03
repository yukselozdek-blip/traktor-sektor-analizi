#!/bin/bash
set -euo pipefail

# Türkçe kullanım mesajı
usage_tr() {
    cat >&2 <<'EOF'
Hata: Veritabanı URL'si ayarlanmamış.

Kullanım:
  export DATABASE_URL_BACKUP="postgresql://..."
  bash scripts/backup-db.sh

Veya:
  export DATABASE_PUBLIC_URL="postgresql://..."
  bash scripts/backup-db.sh

URL'i Railway'de bulun:
  Railway.app → Postgres → Variables → DATABASE_PUBLIC_URL

Güvenlik: URL'i hiçbir yere yazmayın, commit etmeyin.
EOF
    exit 1
}

# URL'yi kontrol et
if [[ -z "${DATABASE_URL_BACKUP:-}" ]]; then
    if [[ -z "${DATABASE_PUBLIC_URL:-}" ]]; then
        usage_tr
    else
        DATABASE_URL="$DATABASE_PUBLIC_URL"
    fi
else
    DATABASE_URL="$DATABASE_URL_BACKUP"
fi

# pg_dump kontrolü
if ! command -v pg_dump &> /dev/null; then
    echo "Hata: pg_dump bulunamadı. PostgreSQL istemcisini yükleyin." >&2
    echo "Ubuntu: sudo apt install postgresql-client" >&2
    exit 1
fi

# Yedek dizinini oluştur
BACKUP_DIR="./backups"
mkdir -p "$BACKUP_DIR"

# Yedek dosya adı (YYYYMMDD-HHMMSS formatı)
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
DUMP_FILE="$BACKUP_DIR/traktor-sektor-analizi_hetzner-storagebox_$TIMESTAMP.dump"

# Yedek al
echo "Yedekleniyor: $DUMP_FILE"
pg_dump --format=custom --no-owner --no-privileges --file "$DUMP_FILE" "$DATABASE_URL"

# Dosya boyutu
SIZE=$(du -h "$DUMP_FILE" | cut -f1)
echo "Başarılı. Dosya boyutu: $SIZE"

# Son 8 yedek dışındakileri sil
echo "Eski yedekler temizleniyor (son 8 tutulacak)..."
ls -t "$BACKUP_DIR"/traktor-sektor-analizi_hetzner-storagebox_*.dump 2>/dev/null | tail -n +9 | xargs -r rm -v

echo "Hazır!"
