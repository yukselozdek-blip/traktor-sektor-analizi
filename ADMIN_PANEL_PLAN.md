# Yönetim (Admin) Paneli ve Kurumsal Sözleşme Planı

> Durum: **Faz 1 uygulanıyor** (2026-10-17). Bu belge hem ürün planı hem de uygulayan ajanlar için **bağlayıcı teknik sözleşmedir** (tablo/sütun/rota/fonksiyon adları buradan alınır).

## 1. Amaç

1. Uygulama sahibi (superuser) çalışan ekibine **rol bazlı yetki** verir; ekip uygulamayı yönetir.
2. Ekip müşteri hesaplarını, abonelikleri, özellikleri ve limitleri yönetir.
3. **Kurumsal sözleşme (B2B)**: kredi kartı dışında, bir kuruma (ör. John Deere) belirli bir plan + **kullanıcı kotası (koltuk)** + **sözleşme tarihleri** verilir. Kurumsal e-posta uzantısı (ör. `@deere.com`) olan kişiler kota dolana kadar davet kodu olmadan kayıt olur ve kurumun planından yararlanır.
4. Müşteri tarafında **kurum yöneticisi** (org_admin) kendi kurumunun koltuklarını görür, üye davet eder/çıkarır.

## 2. Kavramlar

| Kavram | Açıklama |
|---|---|
| **Superuser (sahip)** | `users.is_superuser = true`. Her yetki her zaman açık. Yalnızca superuser `super_admin` rolü verebilir ve rol yetkilerini düzenleyebilir. |
| **Ekip üyesi (staff)** | `users.role = 'admin'` + `users.staff_role` (rol anahtarı). `role='admin'` olup `staff_role` NULL olan eski yöneticiler **super_admin** sayılır (geriye uyumluluk; migration mevcut adminlere açıkça `super_admin` yazar). |
| **Rol (staff_roles)** | Yetki listesi taşıyan şablon. Sistem rolleri silinemez; superuser özel rol ekleyebilir. |
| **Kurum (organizations)** | Sözleşmeli müşteri. Bir marka (`brand_id`, zorunlu), bir plan (`plan_id`), koltuk sayısı (`seat_limit`), sözleşme başlangıç/bitiş, durum, özellik/limit istisnaları. |
| **Kurum alan adı** | `organization_domains.domain` (ör. `deere.com`). Bir alan adı yalnızca tek kuruma bağlanır. |
| **Üye (organization_members)** | Kullanıcının kuruma bağlılığı. Bir kullanıcı en fazla **bir** kuruma üye olur. `member_role`: `member` veya `org_admin`. Her üye satırı bir koltuk kullanır. |
| **Kurum daveti (organization_invitations)** | Alan adı dışı (ör. danışman, `@gmail.com`) kişileri kuruma almak için e-posta izin listesi. Davetli e-posta kayıt olunca üye olur. |
| **Özellik bayrağı (feature_flags)** | Özelliğin **küresel** açık/kapalı anahtarı (acil kapatma / kademeli devreye alma). Kapalı özellik admin dışı herkese kapanır. |

## 3. Yetki (permission) kataloğu

| Anahtar | Ne sağlar |
|---|---|
| `dashboard.view` | Panel genel bakış |
| `orgs.read` | Kurum listesi/detayı, planlar, markalar |
| `orgs.write` | Kurum oluştur/düzenle, sözleşme, plan, koltuk, durum, alan adı, özellik/limit istisnası |
| `members.write` | Kuruma üye ekle/çıkar, kurum yöneticisi ata, kurum davetleri |
| `users.read` | Kullanıcı listesi/detayı |
| `users.write` | Kullanıcı aktif/pasif, elle (kartsız) abonelik tanımlama |
| `features.manage` | Küresel özellik bayraklarını aç/kapat |
| `staff.manage` | Ekip üyesi ekle/çıkar, rol ata (super_admin atama ve rol düzenleme yalnızca superuser) |
| `audit.read` | Yönetim denetim kaydı |

Sistem rolleri (migration ile tohumlanır):

| Rol anahtarı | Ad | Yetkiler |
|---|---|---|
| `super_admin` | Süper Yönetici | `*` (hepsi) |
| `account_manager` | Müşteri Yöneticisi | dashboard.view, orgs.read, orgs.write, members.write, users.read, audit.read |
| `support` | Destek | dashboard.view, orgs.read, users.read, users.write, members.write, audit.read |
| `finance` | Finans | dashboard.view, orgs.read, users.read, audit.read |
| `viewer` | Salt Okunur | dashboard.view, orgs.read, users.read, audit.read |

Güvenlik kuralları:
- Mevcut `adminOnly` rotaları (reseed, import, davet kodu, WhatsApp onayı vb.) yalnızca **superuser veya `super_admin`** (ya da `staff_role` NULL eski admin) için açıktır. Diğer ekip rolleri yalnızca yönetim konsolu yetkileriyle çalışır.
- Kimse kendi rolünü/aktifliğini değiştiremez; superuser pasife alınamaz, rolü düşürülemez.
- Her yazma işlemi `admin_audit_log`'a yazılır.

## 4. Veri modeli — `database/migrations/010_admin_console.sql`

```sql
CREATE TABLE IF NOT EXISTS staff_roles (
    key VARCHAR(50) PRIMARY KEY,            -- ^[a-z][a-z0-9_]{1,49}$
    name VARCHAR(100) NOT NULL,
    description TEXT,
    permissions JSONB NOT NULL DEFAULT '[]'::jsonb,   -- ["orgs.read", ...] veya ["*"]
    is_system BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
-- 5 sistem rolü: INSERT ... ON CONFLICT (key) DO NOTHING
ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_role VARCHAR(50) REFERENCES staff_roles(key) ON DELETE SET NULL;
UPDATE users SET staff_role = 'super_admin' WHERE role = 'admin' AND staff_role IS NULL;

CREATE TABLE IF NOT EXISTS organizations (
    id SERIAL PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    slug VARCHAR(100) NOT NULL UNIQUE,
    brand_id INTEGER NOT NULL REFERENCES brands(id),
    plan_id INTEGER NOT NULL REFERENCES subscription_plans(id),
    seat_limit INTEGER NOT NULL DEFAULT 5 CHECK (seat_limit >= 0 AND seat_limit <= 100000),
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('trial','active','suspended','expired')),
    contract_start DATE,
    contract_end DATE,                      -- NULL = süresiz; bu tarih dahil geçerlidir
    billing_type VARCHAR(20) NOT NULL DEFAULT 'contract' CHECK (billing_type IN ('contract','invoice','card','free')),
    contract_ref VARCHAR(100),
    contact_name VARCHAR(200),
    contact_email VARCHAR(254),
    notes TEXT,
    auto_join BOOLEAN NOT NULL DEFAULT true,  -- alan adı eşleşen e-postalar davet kodsuz katılabilir
    feature_overrides JSONB NOT NULL DEFAULT '{"add":[],"remove":[]}'::jsonb,
    limit_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,   -- {"ai_queries_monthly": 500, ...}
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS organization_domains (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    domain VARCHAR(253) NOT NULL UNIQUE,    -- küçük harf, '@' yok
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS organization_members (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    member_role VARCHAR(20) NOT NULL DEFAULT 'member' CHECK (member_role IN ('member','org_admin')),
    added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    joined_via VARCHAR(20) NOT NULL DEFAULT 'admin' CHECK (joined_via IN ('admin','domain','invitation','org_admin')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_org_members_org ON organization_members(organization_id);
CREATE TABLE IF NOT EXISTS organization_invitations (
    id SERIAL PRIMARY KEY,
    organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email VARCHAR(254) NOT NULL,            -- küçük harf
    member_role VARCHAR(20) NOT NULL DEFAULT 'member' CHECK (member_role IN ('member','org_admin')),
    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','revoked')),
    invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    accepted_at TIMESTAMPTZ,
    UNIQUE (organization_id, email)
);
CREATE INDEX IF NOT EXISTS idx_org_invitations_email ON organization_invitations(email) WHERE status = 'pending';
CREATE TABLE IF NOT EXISTS feature_flags (
    key VARCHAR(100) PRIMARY KEY,
    name VARCHAR(200) NOT NULL,
    description TEXT,
    is_enabled BOOLEAN NOT NULL DEFAULT true,
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
-- PLAN_FEATURE_CATALOG'daki tüm anahtarlar Türkçe adlarıyla tohumlanır (ON CONFLICT DO NOTHING), hepsi açık.
CREATE TABLE IF NOT EXISTS admin_audit_log (
    id BIGSERIAL PRIMARY KEY,
    actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(80) NOT NULL,            -- ör. 'org.create', 'org.member.add', 'staff.role.set', 'feature.toggle'
    target_type VARCHAR(40),
    target_id VARCHAR(80),
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip_address VARCHAR(45),
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_log(created_at DESC);
```

## 5. Yetkilendirme (entitlement) kuralı

`src/lib/org-entitlements.js` — tek doğru kaynak.

- **Geçerli kurum**: `status IN ('trial','active')` VE (`contract_start` NULL veya `<= CURRENT_DATE`) VE (`contract_end` NULL veya `>= CURRENT_DATE`). Sözleşme bitince erişim **otomatik** kapanır (zamanlanmış iş gerekmez).
- `getUserActiveSubscription(userId)` (server.js): önce kullanıcının **geçerli kurum üyeliği** aranır; varsa kurumdan türetilmiş abonelik nesnesi döner; yoksa mevcut kişisel abonelik mantığı aynen çalışır. Kurum sözleşmesi kişisel kartlı aboneliğe **önceliklidir**.
- Türetilmiş nesne: `{ id: null, source: 'organization', organization_id, organization_name, member_role, user_id, plan_id, plan_slug, plan_name, tier_rank, status: 'active', current_period_start: contract_start, current_period_end: contract_end (gün sonu), cancel_at_period_end: false, feature_keys: <birleşik dizi>, plan_limits: <birleşik nesne>, features, has_ai_insights, has_competitor_analysis, has_weather_data, has_export }`.
- Özellikler: `plan.feature_keys ∪ overrides.add − overrides.remove`. Limitler: `{...plan.plan_limits, ...limit_overrides}` (yalnızca sayısal değerler; -1 = sınırsız).
- `getPlanLimits`: abonelik nesnesinde `plan_limits` varsa (kurum) doğrudan onu kullanır.
- **Küresel bayrak**: `requireFeature` admin olmayan kullanıcı için, istenen anahtarların **hepsi** küresel kapalıysa `403 { code: 'FEATURE_DISABLED' }` döner; açık olanlardan biri planda varsa geçer. `/api/subscription` yanıtındaki `feature_keys` kapalı bayrakları içermez. Kapalı bayrak listesi 30 sn bellek önbelleği (`invalidateFeatureFlagCache()` ile anında temizlenir).
- Kurum kaynaklı abonelikte kullanıcı **kartla ödeme / iptal / plan değiştirme yapamaz**: `/api/billing/checkout`, `/api/billing/change-plan`, `/api/billing/cancel` → `409 { code: 'ORG_MANAGED', error: 'Aboneliğiniz kurumsal sözleşmeniz kapsamında yönetiliyor.' }`.

## 6. Kayıt (signup) akışı

`/api/auth/signup` (şifre) ve Google kayıt uçlarında, **davet kodu boşsa**:
1. E-postanın alan adı (`@` sonrası, küçük harf) veya e-postanın kendisi için uygun kurum aranır: (a) `organization_invitations` içinde `pending` davet, yoksa (b) `organization_domains` eşleşmesi + `auto_join = true`. Kurum geçerli olmalıdır (§5).
2. Uygun kurum yoksa eski davranış: `400 INVITE_ERROR`.
3. Aynı transaction'da kurum satırı `FOR UPDATE` kilitlenir, üye sayısı `< seat_limit` değilse `403 { code: 'ORG_SEATS_FULL', error: 'Kurumunuzun kullanıcı kotası dolu. Kurum yöneticinizle iletişime geçin.' }`.
4. Kullanıcı `brand_id = org.brand_id` ile oluşturulur; `organization_members` satırı eklenir (`joined_via` = `invitation`/`domain`); davet `accepted` olur. Kişisel `pending` abonelik **açılmaz**.
5. E-posta doğrulaması zorunluluğu aynen geçerlidir (sahte `@deere.com` kaydı doğrulanmadan giriş yapamaz). Doğrulanmamış kayıt da koltuk tutar; yönetici panelde "doğrulanmadı" olarak görür ve çıkarabilir.
6. Davet kodu verilmişse eski davet kodu akışı aynen çalışır (kurum araması yapılmaz).
- Mevcut kullanıcıyı kuruma eklemek yönetim panelinden yapılır ("Üye ekle": kullanıcı varsa doğrudan bağlanır, yoksa kurum daveti oluşur). "Alan adındaki mevcut kullanıcıları bağla" işlemi koltuk kotasına kadar bağlar.

## 7. API sözleşmesi

Tüm yanıtlar JSON; 500'lerde `logRouteError` zorunlu; girdiler doğrulanır (id'ler pozitif tam sayı, metin uzunlukları sınırlı, e-posta `SAFE_EMAIL`).

### 7.1 Yönetim konsolu — `src/routes/admin-console.js` (zincir: `authMiddleware, requirePermission('<izin>')`)

| Yöntem | Yol | İzin | Gövde / açıklama |
|---|---|---|---|
| GET | `/api/admin/console/me` | (yalnızca `role='admin'`, izin yok) | `{ user:{id,email,full_name}, is_superuser, staff_role, role_name, permissions:[...] }` |
| GET | `/api/admin/console/overview` | dashboard.view | sayılar: kullanıcılar (toplam/aktif/son 30 gün yeni), aktif kişisel abonelikler, kurumlar (durumlara göre), toplam koltuk/kullanılan, 30 gün içinde bitecek sözleşmeler listesi, son 10 denetim kaydı |
| GET | `/api/admin/console/organizations` | orgs.read | `?q=&status=` → `[{id,name,slug,brand_name,plan_slug,plan_name,seat_limit,seats_used,status,contract_start,contract_end,is_effective,domains:[...] }]` |
| POST | `/api/admin/console/organizations` | orgs.write | `{name, slug?, brand_id, plan_slug, seat_limit, status?, contract_start?, contract_end?, billing_type?, contract_ref?, contact_name?, contact_email?, notes?, auto_join?, domains?:[...]}` → 201 |
| GET | `/api/admin/console/organizations/:id` | orgs.read | kurum + `domains`, `members` (id,email,full_name,member_role,email_verified,is_active,last_login,joined_via,created_at), `invitations` (pending), `seats_used`, `is_effective`, `effective_features`, `effective_limits` |
| PUT | `/api/admin/console/organizations/:id` | orgs.write | §7.1 POST alanlarının herhangi biri + `feature_overrides {add,remove}`, `limit_overrides {}`; koltuk sayısı mevcut üye sayısının altına inemez (`400`) |
| POST | `/api/admin/console/organizations/:id/domains` | orgs.write | `{domain}`; alan adı biçimi `^[a-z0-9.-]+\.[a-z]{2,}$`, genel e-posta sağlayıcıları reddedilir (gmail.com, hotmail.com, outlook.com, yahoo.com, icloud.com, yandex.com, live.com, msn.com, proton.me, protonmail.com); başka kurumdaysa `409` |
| DELETE | `/api/admin/console/organizations/:id/domains/:domainId` | orgs.write | |
| POST | `/api/admin/console/organizations/:id/members` | members.write | `{email, member_role?}` → kullanıcı varsa bağlanır (`{result:'added'}`; başka kurumdaysa `409`; koltuk doluysa `403 ORG_SEATS_FULL`; kullanıcının `brand_id`'si kurum markasına çekilir), yoksa davet oluşturulur (`{result:'invited'}`) |
| PUT | `/api/admin/console/organizations/:id/members/:userId` | members.write | `{member_role}` |
| DELETE | `/api/admin/console/organizations/:id/members/:userId` | members.write | üyelik silinir (kullanıcı silinmez) |
| DELETE | `/api/admin/console/organizations/:id/invitations/:invId` | members.write | davet `revoked` |
| POST | `/api/admin/console/organizations/:id/link-domain-users` | members.write | alan adı eşleşen, kurumsuz, admin olmayan mevcut kullanıcıları koltuk dolana kadar bağlar → `{linked, skipped_no_seat}` |
| GET | `/api/admin/console/users` | users.read | `?q=&status=active|inactive&kind=staff|customer&page=1` (sayfa 50) → `{items:[{id,email,full_name,role,staff_role,is_superuser,is_active,email_verified,brand_name,organization_id,organization_name,plan_slug,last_login,created_at}], total, page}` |
| GET | `/api/admin/console/users/:id` | users.read | kullanıcı + kurum + abonelikler (son 10) + son 20 auth_audit olayı |
| POST | `/api/admin/console/users/:id/status` | users.write | `{is_active:boolean}`; kendisi/superuser değiştirilemez; `invalidatePasswordChangedCache(id)` çağrılır |
| POST | `/api/admin/console/users/:id/subscription` | users.write | `{plan_slug, period_end: 'YYYY-MM-DD'}` → kartsız elle abonelik: önceki active/trialing/pending satırları `cancelled`, yeni `active` satır (`provider='manual'`) |
| GET | `/api/admin/console/staff` | staff.manage | ekip üyeleri (role='admin') |
| POST | `/api/admin/console/staff` | staff.manage | `{email, staff_role}` → kayıtlı ve doğrulanmış kullanıcı `role='admin'` + rol; kayıtlı değilse `404` (kişi önce kayıt olmalı) |
| PUT | `/api/admin/console/staff/:userId` | staff.manage | `{staff_role}` |
| DELETE | `/api/admin/console/staff/:userId` | staff.manage | `role='brand_user'`, `staff_role=NULL` |
| GET | `/api/admin/console/roles` | staff.manage | roller + `permission_catalog` (anahtar, Türkçe ad, açıklama) |
| POST | `/api/admin/console/roles` | **yalnızca superuser** | `{key, name, description?, permissions:[...]}` (yalnızca katalogdaki izinler; `*` yasak) |
| PUT | `/api/admin/console/roles/:key` | **yalnızca superuser** | `{name?, description?, permissions?}`; `super_admin` değiştirilemez |
| DELETE | `/api/admin/console/roles/:key` | **yalnızca superuser** | sistem rolü silinemez; kullanan varsa `409` |
| GET | `/api/admin/console/features` | orgs.read | bayraklar + her bayrağın hangi planlarda olduğu |
| PUT | `/api/admin/console/features/:key` | features.manage | `{is_enabled:boolean}` → `invalidateFeatureFlagCache()` |
| GET | `/api/admin/console/plans` | orgs.read | aktif planlar (slug, name, tier_rank, price_monthly, feature_keys, plan_limits) |
| GET | `/api/admin/console/brands` | orgs.read | `[{id,name,slug}]` aktif markalar |
| GET | `/api/admin/console/audit` | audit.read | `?action=&actor=&page=` (sayfa 50) |

Staff ataması kuralları: `super_admin` rolünü yalnızca superuser verir/alır; kimse kendi kaydını değiştiremez; superuser hedef olamaz.

### 7.2 Kurum self-servis — `src/routes/org-self.js` (zincir: `authMiddleware`)

| Yöntem | Yol | Kim | Açıklama |
|---|---|---|---|
| GET | `/api/org/me` | herhangi kurum üyesi | `{organization:{id,name,plan_name,seat_limit,seats_used,contract_end,status,is_effective}, member_role}`; üye değilse `{organization:null}` |
| GET | `/api/org/members` | org_admin | üyeler + bekleyen davetler |
| POST | `/api/org/members` | org_admin | `{email}` → davet (her zaman `member`); koltuk + bekleyen davet sayısı `seat_limit`'i aşamaz; davet e-postası gönderilir (hata akışı bozmaz) |
| DELETE | `/api/org/members/:userId` | org_admin | kendisi çıkarılamaz |
| DELETE | `/api/org/invitations/:id` | org_admin | |

Org_admin olmayan → `403`. Her yazma `admin_audit_log`'a (`org_self.*`) yazılır.

## 8. Arayüz

- **`/admin`** → `public/admin.html` + `public/admin.js` + `public/admin.css` (ana SPA'dan bağımsız, profesyonel konsol düzeni: sol menü, üst bar, içerik). Giriş yoksa `/login.html`'e; admin değilse "Yetkiniz yok" ekranı. Menü öğeleri `permissions`'a göre gösterilir.
  - Genel Bakış · Kurumlar (liste + oluştur + detay sekmeleri: Bilgiler/Sözleşme, Üyeler, Alan adları, Özellik & Limit istisnaları) · Kullanıcılar · Ekip & Roller · Özellikler · Denetim Kaydı · (bağlantılar: mevcut Yönetişim, Davet kodları, WhatsApp onayları ana uygulamada)
- **`/kurum`** → `public/kurum.html` + `public/kurum.js` (admin.css'i kullanır): kurum yöneticisi koltuk kullanımı, üyeler, davetler.
- Ana uygulama menüsüne (index.html) admin için "Yönetim Paneli" bağlantısı.
- Kayıt formlarında davet kodu artık zorunlu değil: "Kurumsal e-posta ile kayıt oluyorsanız boş bırakabilirsiniz".
- CSP: satır içi script yok; tüm metin `escapeHtml` ile; `data-on-click` yerine `addEventListener`.

## 9. Faz 2 (sonraki öneriler)

- SSO (SAML/OIDC, Azure AD) ile kurumsal giriş; alan adı doğrulama (DNS TXT).
- Kurum bazlı kullanım raporu (AI sorgu, export) ve kota havuzu (kişi başı yerine kurum toplamı).
- Sözleşme bitişine 30/7 gün kala otomatik e-posta (kuruma ve hesap yöneticisine).
- Fatura/ödeme takibi (havale, e-fatura entegrasyonu) ve sözleşme PDF'i yükleme.
- Ekip üyeleri için zorunlu 2FA, IP kısıtlama; "kullanıcı adına görüntüle" (impersonation, denetimli).
- Planları panelden düzenleme (şu an planlar her açılışta `src/init-db.js` tarafından koddan yeniden yazılıyor; düzenleme için önce bu tohumlama değiştirilmeli).

## 10. Modül arayüzleri (uygulayıcılar için bağlayıcı)

`src/lib/org-entitlements.js` (CommonJS, yalnızca `db` parametresi alır: pool veya transaction client):
- `ORG_EFFECTIVE_SQL` — `o` takma adlı kurum için geçerlilik koşulu SQL parçası (§5).
- `parseJsonish(value, fallback)` — JSONB/string/dizi güvenli ayrıştırma.
- `mergeFeatureKeys(planKeys, overrides)` → dizi (tekrarsız). `mergeLimits(planLimits, overrides)` → nesne (yalnızca sonlu sayılar alınır).
- `emailDomain(email)` → küçük harf alan adı veya `null`. `normalizeDomain(input)` → geçerli alan adı veya `null` (başında `@` kabul edilir, atılır). `PUBLIC_EMAIL_DOMAINS` (Set).
- `getUserOrgMembership(db, userId)` → `{ organization_id, member_role, joined_via, org: {…satır}, is_effective }` veya `null`.
- `getOrgSubscriptionForUser(db, userId)` → §5'teki türetilmiş abonelik nesnesi (yalnızca geçerli kurumda) veya `null`.
- `countSeatsUsed(db, orgId)` → sayı.
- `findSignupOrganization(db, email)` → `{ organization_id, invitation_id, member_role, joined_via }` veya `null` (önce bekleyen davet, sonra `auto_join` alan adı; yalnızca geçerli kurum).
- `addMemberWithSeatCheck(client, orgId, userId, { memberRole='member', joinedVia='admin', addedBy=null })` → `{ ok: true }` | `{ ok: false, code: 'ORG_NOT_FOUND' | 'ALREADY_MEMBER' | 'ORG_SEATS_FULL' }`. Transaction içinde çağrılır; kurum satırını `FOR UPDATE` kilitler, koltuk denetler, üyelik ekler, `users.brand_id = org.brand_id` yapar, kullanıcının e-postasına ait bekleyen daveti `accepted` yapar.
- `getDisabledFeatureKeys(db)` → `Set` (30 sn önbellek). `invalidateFeatureFlagCache()`.

`src/lib/admin-audit.js`:
- `logAdminAudit(db, req, action, targetType, targetId, details = {})` — hata fırlatmaz (yalnızca `console.warn`); IP `req.ip`.

`src/middleware/permissions.js` (kendi `require('../db').pool`'unu kullanır, `auth.js` gibi):
- `PERMISSIONS` — `[{ key, name, description }]` (§3 kataloğu, Türkçe).
- `getStaffContext(db, userId)` → `{ is_admin, is_active, is_superuser, staff_role, role_name, permissions: [...] }` (`*` katalog anahtarlarına açılır; `role='admin'` + `staff_role` NULL → super_admin sayılır).
- `requirePermission(permKey | null)` — Express ara katmanı (adı: `requirePermission`); `authMiddleware`'den sonra. Admin değil/aktif değil/izin yok → `403 { error: 'Yetkisiz erişim' }`. Başarıda `req.staff = getStaffContext(...)`.
- `requireSuperuser` — ara katman; superuser değilse `403`.
- `isFullAdmin(staffCtx)` → boolean (superuser veya super_admin).
