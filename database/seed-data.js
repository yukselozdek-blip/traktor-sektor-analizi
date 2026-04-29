// ============================================
// TRAKTÖR SEKTÖR ANALİZİ - SEED DATA
// ============================================

// Marka kurumsal renk paleti — RESMI KAYNAKLI doğrulama
// Her primary/secondary/accent için kaynak referansı .claude/skills/marka-kurumsal-renk-anayasasi/SKILL.md içinde.
// Doğrulama kaynakları: brandcolorcode.com (brand book derlemeleri), usbrandcolors.com,
// kioti.eu brand-guideline (resmi), Pantone karşılıkları belirtildi.
const brands = [
    // Türk markalar (resmi web sitesi: logo + hero band'den)
    { name: 'BAŞAK', slug: 'basak', primary_color: '#D32F2F', secondary_color: '#B71C1C', accent_color: '#FFC107', text_color: '#FFFFFF', country_of_origin: 'Türkiye', parent_company: 'BAŞAK Traktör' },
    { name: 'TÜMOSAN', slug: 'tumosan', primary_color: '#E30613', secondary_color: '#B30510', accent_color: '#F39200', text_color: '#FFFFFF', country_of_origin: 'Türkiye', parent_company: 'Tümosan Motor' },
    { name: 'ERKUNT', slug: 'erkunt', primary_color: '#1565C0', secondary_color: '#0D47A1', accent_color: '#42A5F5', text_color: '#FFFFFF', country_of_origin: 'Türkiye', parent_company: 'Erkunt Traktör' },
    { name: 'HATTAT', slug: 'hattat', primary_color: '#E65100', secondary_color: '#BF360C', accent_color: '#FF8A65', text_color: '#FFFFFF', country_of_origin: 'Türkiye', parent_company: 'Hattat Holding' },
    { name: 'KARATAŞ', slug: 'karatas', primary_color: '#37474F', secondary_color: '#263238', accent_color: '#78909C', text_color: '#FFFFFF', country_of_origin: 'Türkiye', parent_company: 'Karataş Traktör' },
    // CNH Industrial (CASE IH, New Holland, Fiat) — brandcolorcode.com
    { name: 'CASE IH', slug: 'case-ih', primary_color: '#D0002D', secondary_color: '#9E0021', accent_color: '#000000', text_color: '#FFFFFF', country_of_origin: 'ABD', parent_company: 'CNH Industrial' },
    { name: 'NEW HOLLAND', slug: 'new-holland', primary_color: '#003F7D', secondary_color: '#002A57', accent_color: '#FECD1A', text_color: '#FFFFFF', country_of_origin: 'İtalya/ABD', parent_company: 'CNH Industrial' },
    { name: 'FIAT', slug: 'fiat', primary_color: '#B11116', secondary_color: '#8B0E12', accent_color: '#1F1F1F', text_color: '#FFFFFF', country_of_origin: 'İtalya', parent_company: 'CNH Industrial' },
    // SDF Group (Deutz-Fahr, Same, Lamborghini, Hürlimann) — brandcolorcode.com
    { name: 'DEUTZ-FAHR', slug: 'deutz-fahr', primary_color: '#76B824', secondary_color: '#5C9418', accent_color: '#185081', text_color: '#FFFFFF', country_of_origin: 'Almanya', parent_company: 'SDF Group' },
    { name: 'SAME', slug: 'same', primary_color: '#00712F', secondary_color: '#004D1E', accent_color: '#A5D6A7', text_color: '#FFFFFF', country_of_origin: 'İtalya', parent_company: 'SDF Group' },
    // AGCO Corporation (Massey Ferguson, Fendt, Valtra) — brandcolorcode.com
    { name: 'MASSEY FERGUSON', slug: 'massey-ferguson', primary_color: '#C71121', secondary_color: '#8E0E18', accent_color: '#606163', text_color: '#FFFFFF', country_of_origin: 'ABD', parent_company: 'AGCO Corporation' },
    { name: 'FENDT', slug: 'fendt', primary_color: '#004713', secondary_color: '#003510', accent_color: '#006225', text_color: '#FFFFFF', country_of_origin: 'Almanya', parent_company: 'AGCO Corporation' },
    { name: 'VALTRA', slug: 'valtra', primary_color: '#DC0029', secondary_color: '#9A001D', accent_color: '#BDBDBD', text_color: '#FFFFFF', country_of_origin: 'Finlandiya', parent_company: 'AGCO Corporation' },
    // John Deere — usbrandcolors.com (Pantone 364 + 109)
    { name: 'JOHN DEERE', slug: 'john-deere', primary_color: '#367C2B', secondary_color: '#1B5E20', accent_color: '#FFDE00', text_color: '#FFFFFF', country_of_origin: 'ABD', parent_company: 'Deere & Company' },
    // CLAAS — brandcolorcode.com (Pantone 583 lime green + Pantone 2347 red)
    { name: 'CLAAS', slug: 'claas', primary_color: '#B4C618', secondary_color: '#8FA014', accent_color: '#FE0000', text_color: '#000000', country_of_origin: 'Almanya', parent_company: 'CLAAS Group' },
    // Kubota — brand identity orange (resmi web sitesi)
    { name: 'KUBOTA', slug: 'kubota', primary_color: '#FF7900', secondary_color: '#CC5F00', accent_color: '#FFB74D', text_color: '#FFFFFF', country_of_origin: 'Japonya', parent_company: 'Kubota Corporation' },
    // ARGO Tractors (Landini, McCormick) — resmi web siteleri
    { name: 'LANDINI', slug: 'landini', primary_color: '#003E7E', secondary_color: '#002A57', accent_color: '#0070C0', text_color: '#FFFFFF', country_of_origin: 'İtalya', parent_company: 'ARGO Tractors' },
    { name: 'McCORMICK', slug: 'mccormick', primary_color: '#B81F23', secondary_color: '#7E1417', accent_color: '#E53935', text_color: '#FFFFFF', country_of_origin: 'İtalya', parent_company: 'ARGO Tractors' },
    // Diğer
    { name: 'ANTONIO CARRARO', slug: 'antonio-carraro', primary_color: '#FF8F00', secondary_color: '#E65100', accent_color: '#FFB300', text_color: '#FFFFFF', country_of_origin: 'İtalya', parent_company: 'Antonio Carraro S.p.A.' },
    { name: 'YANMAR', slug: 'yanmar', primary_color: '#DC1E37', secondary_color: '#B5172E', accent_color: '#FF6659', text_color: '#FFFFFF', country_of_origin: 'Japonya', parent_company: 'Yanmar Holdings' },
    { name: 'SOLIS', slug: 'solis', primary_color: '#00853F', secondary_color: '#005C2A', accent_color: '#F39200', text_color: '#FFFFFF', country_of_origin: 'Hindistan', parent_company: 'International Tractors Ltd' },
    { name: 'FERRARI', slug: 'ferrari-tractors', primary_color: '#FF6F00', secondary_color: '#E65100', accent_color: '#FFA726', text_color: '#FFFFFF', country_of_origin: 'İtalya', parent_company: 'BCS Group' },
    // KIOTI — resmi brand guideline (kioti.eu) — TURUNCU değil kırmızı (DÜZELTME!)
    { name: 'KIOTI', slug: 'kioti', primary_color: '#DE4826', secondary_color: '#B53A1F', accent_color: '#8D9093', text_color: '#FFFFFF', country_of_origin: 'Güney Kore', parent_company: 'Daedong Corporation' },
    { name: 'TAFE', slug: 'tafe', primary_color: '#1565C0', secondary_color: '#0D47A1', accent_color: '#42A5F5', text_color: '#FFFFFF', country_of_origin: 'Hindistan', parent_company: 'TAFE Limited' }
];

// Türkiye'nin 81 ili
const provinces = [
    { name: 'Adana', plate_code: '01', region: 'Akdeniz', lat: 37.0000, lng: 35.3213, pop: 2274106 },
    { name: 'Adıyaman', plate_code: '02', region: 'Güneydoğu Anadolu', lat: 37.7648, lng: 38.2786, pop: 635169 },
    { name: 'Afyonkarahisar', plate_code: '03', region: 'Ege', lat: 38.7507, lng: 30.5567, pop: 747555 },
    { name: 'Ağrı', plate_code: '04', region: 'Doğu Anadolu', lat: 39.7191, lng: 43.0503, pop: 510626 },
    { name: 'Amasya', plate_code: '05', region: 'Karadeniz', lat: 40.6499, lng: 35.8353, pop: 339000 },
    { name: 'Ankara', plate_code: '06', region: 'İç Anadolu', lat: 39.9334, lng: 32.8597, pop: 5747325 },
    { name: 'Antalya', plate_code: '07', region: 'Akdeniz', lat: 36.8969, lng: 30.7133, pop: 2619832 },
    { name: 'Artvin', plate_code: '08', region: 'Karadeniz', lat: 41.1828, lng: 41.8183, pop: 174010 },
    { name: 'Aydın', plate_code: '09', region: 'Ege', lat: 37.8560, lng: 27.8416, pop: 1134031 },
    { name: 'Balıkesir', plate_code: '10', region: 'Marmara', lat: 39.6484, lng: 27.8826, pop: 1247149 },
    { name: 'Bilecik', plate_code: '11', region: 'Marmara', lat: 40.0567, lng: 30.0665, pop: 228673 },
    { name: 'Bingöl', plate_code: '12', region: 'Doğu Anadolu', lat: 38.8854, lng: 40.4966, pop: 281205 },
    { name: 'Bitlis', plate_code: '13', region: 'Doğu Anadolu', lat: 38.4004, lng: 42.1095, pop: 353988 },
    { name: 'Bolu', plate_code: '14', region: 'Karadeniz', lat: 40.7360, lng: 31.6106, pop: 316126 },
    { name: 'Burdur', plate_code: '15', region: 'Akdeniz', lat: 37.7203, lng: 30.2908, pop: 273716 },
    { name: 'Bursa', plate_code: '16', region: 'Marmara', lat: 40.1826, lng: 29.0665, pop: 3147818 },
    { name: 'Çanakkale', plate_code: '17', region: 'Marmara', lat: 40.1553, lng: 26.4142, pop: 559383 },
    { name: 'Çankırı', plate_code: '18', region: 'İç Anadolu', lat: 40.6013, lng: 33.6134, pop: 195789 },
    { name: 'Çorum', plate_code: '19', region: 'Karadeniz', lat: 40.5506, lng: 34.9556, pop: 536483 },
    { name: 'Denizli', plate_code: '20', region: 'Ege', lat: 37.7765, lng: 29.0864, pop: 1040915 },
    { name: 'Diyarbakır', plate_code: '21', region: 'Güneydoğu Anadolu', lat: 37.9144, lng: 40.2306, pop: 1804880 },
    { name: 'Edirne', plate_code: '22', region: 'Marmara', lat: 41.6818, lng: 26.5623, pop: 413903 },
    { name: 'Elazığ', plate_code: '23', region: 'Doğu Anadolu', lat: 38.6810, lng: 39.2264, pop: 591497 },
    { name: 'Erzincan', plate_code: '24', region: 'Doğu Anadolu', lat: 39.7500, lng: 39.5000, pop: 236034 },
    { name: 'Erzurum', plate_code: '25', region: 'Doğu Anadolu', lat: 39.9000, lng: 41.2700, pop: 758279 },
    { name: 'Eskişehir', plate_code: '26', region: 'İç Anadolu', lat: 39.7767, lng: 30.5206, pop: 898369 },
    { name: 'Gaziantep', plate_code: '27', region: 'Güneydoğu Anadolu', lat: 37.0662, lng: 37.3833, pop: 2130432 },
    { name: 'Giresun', plate_code: '28', region: 'Karadeniz', lat: 40.9128, lng: 38.3895, pop: 453912 },
    { name: 'Gümüşhane', plate_code: '29', region: 'Karadeniz', lat: 40.4386, lng: 39.5086, pop: 164521 },
    { name: 'Hakkari', plate_code: '30', region: 'Doğu Anadolu', lat: 37.5833, lng: 43.7333, pop: 280514 },
    { name: 'Hatay', plate_code: '31', region: 'Akdeniz', lat: 36.4018, lng: 36.3498, pop: 1659320 },
    { name: 'Isparta', plate_code: '32', region: 'Akdeniz', lat: 37.7648, lng: 30.5566, pop: 445325 },
    { name: 'Mersin', plate_code: '33', region: 'Akdeniz', lat: 36.8121, lng: 34.6415, pop: 1868757 },
    { name: 'İstanbul', plate_code: '34', region: 'Marmara', lat: 41.0082, lng: 28.9784, pop: 15907951 },
    { name: 'İzmir', plate_code: '35', region: 'Ege', lat: 38.4189, lng: 27.1287, pop: 4425789 },
    { name: 'Kars', plate_code: '36', region: 'Doğu Anadolu', lat: 40.6167, lng: 43.1000, pop: 285410 },
    { name: 'Kastamonu', plate_code: '37', region: 'Karadeniz', lat: 41.3887, lng: 33.7827, pop: 383373 },
    { name: 'Kayseri', plate_code: '38', region: 'İç Anadolu', lat: 38.7312, lng: 35.4787, pop: 1421455 },
    { name: 'Kırklareli', plate_code: '39', region: 'Marmara', lat: 41.7333, lng: 27.2167, pop: 363886 },
    { name: 'Kırşehir', plate_code: '40', region: 'İç Anadolu', lat: 39.1425, lng: 34.1709, pop: 244519 },
    { name: 'Kocaeli', plate_code: '41', region: 'Marmara', lat: 40.8533, lng: 29.8815, pop: 2033441 },
    { name: 'Konya', plate_code: '42', region: 'İç Anadolu', lat: 37.8667, lng: 32.4833, pop: 2277017 },
    { name: 'Kütahya', plate_code: '43', region: 'Ege', lat: 39.4167, lng: 29.9833, pop: 579257 },
    { name: 'Malatya', plate_code: '44', region: 'Doğu Anadolu', lat: 38.3552, lng: 38.3095, pop: 812580 },
    { name: 'Manisa', plate_code: '45', region: 'Ege', lat: 38.6191, lng: 27.4289, pop: 1450616 },
    { name: 'Kahramanmaraş', plate_code: '46', region: 'Akdeniz', lat: 37.5858, lng: 36.9371, pop: 1177436 },
    { name: 'Mardin', plate_code: '47', region: 'Güneydoğu Anadolu', lat: 37.3212, lng: 40.7245, pop: 862757 },
    { name: 'Muğla', plate_code: '48', region: 'Ege', lat: 37.2153, lng: 28.3636, pop: 1020487 },
    { name: 'Muş', plate_code: '49', region: 'Doğu Anadolu', lat: 38.9462, lng: 41.7539, pop: 408728 },
    { name: 'Nevşehir', plate_code: '50', region: 'İç Anadolu', lat: 38.6939, lng: 34.6857, pop: 303010 },
    { name: 'Niğde', plate_code: '51', region: 'İç Anadolu', lat: 37.9667, lng: 34.6833, pop: 365419 },
    { name: 'Ordu', plate_code: '52', region: 'Karadeniz', lat: 40.9839, lng: 37.8764, pop: 771932 },
    { name: 'Rize', plate_code: '53', region: 'Karadeniz', lat: 41.0201, lng: 40.5234, pop: 348608 },
    { name: 'Sakarya', plate_code: '54', region: 'Marmara', lat: 40.6940, lng: 30.4358, pop: 1060876 },
    { name: 'Samsun', plate_code: '55', region: 'Karadeniz', lat: 41.2928, lng: 36.3313, pop: 1368488 },
    { name: 'Siirt', plate_code: '56', region: 'Güneydoğu Anadolu', lat: 37.9333, lng: 41.9500, pop: 331670 },
    { name: 'Sinop', plate_code: '57', region: 'Karadeniz', lat: 42.0231, lng: 35.1531, pop: 219733 },
    { name: 'Sivas', plate_code: '58', region: 'İç Anadolu', lat: 39.7477, lng: 37.0179, pop: 646608 },
    { name: 'Tekirdağ', plate_code: '59', region: 'Marmara', lat: 41.0000, lng: 27.5167, pop: 1108669 },
    { name: 'Tokat', plate_code: '60', region: 'Karadeniz', lat: 40.3167, lng: 36.5500, pop: 612646 },
    { name: 'Trabzon', plate_code: '61', region: 'Karadeniz', lat: 41.0027, lng: 39.7168, pop: 818023 },
    { name: 'Tunceli', plate_code: '62', region: 'Doğu Anadolu', lat: 39.1079, lng: 39.5401, pop: 84660 },
    { name: 'Şanlıurfa', plate_code: '63', region: 'Güneydoğu Anadolu', lat: 37.1591, lng: 38.7969, pop: 2170110 },
    { name: 'Uşak', plate_code: '64', region: 'Ege', lat: 38.6823, lng: 29.4082, pop: 370509 },
    { name: 'Van', plate_code: '65', region: 'Doğu Anadolu', lat: 38.4891, lng: 43.4089, pop: 1141015 },
    { name: 'Yozgat', plate_code: '66', region: 'İç Anadolu', lat: 39.8181, lng: 34.8147, pop: 419440 },
    { name: 'Zonguldak', plate_code: '67', region: 'Karadeniz', lat: 41.4564, lng: 31.7987, pop: 596053 },
    { name: 'Aksaray', plate_code: '68', region: 'İç Anadolu', lat: 38.3687, lng: 34.0370, pop: 421200 },
    { name: 'Bayburt', plate_code: '69', region: 'Karadeniz', lat: 40.2552, lng: 40.2249, pop: 84843 },
    { name: 'Karaman', plate_code: '70', region: 'İç Anadolu', lat: 37.1759, lng: 33.2287, pop: 258838 },
    { name: 'Kırıkkale', plate_code: '71', region: 'İç Anadolu', lat: 39.8468, lng: 33.5153, pop: 290708 },
    { name: 'Batman', plate_code: '72', region: 'Güneydoğu Anadolu', lat: 37.8812, lng: 41.1351, pop: 620278 },
    { name: 'Şırnak', plate_code: '73', region: 'Güneydoğu Anadolu', lat: 37.4187, lng: 42.4918, pop: 557605 },
    { name: 'Bartın', plate_code: '74', region: 'Karadeniz', lat: 41.6344, lng: 32.3375, pop: 203351 },
    { name: 'Ardahan', plate_code: '75', region: 'Doğu Anadolu', lat: 41.1105, lng: 42.7022, pop: 97319 },
    { name: 'Iğdır', plate_code: '76', region: 'Doğu Anadolu', lat: 39.9167, lng: 44.0500, pop: 203159 },
    { name: 'Yalova', plate_code: '77', region: 'Marmara', lat: 40.6500, lng: 29.2667, pop: 296333 },
    { name: 'Karabük', plate_code: '78', region: 'Karadeniz', lat: 41.2061, lng: 32.6204, pop: 248014 },
    { name: 'Kilis', plate_code: '79', region: 'Güneydoğu Anadolu', lat: 36.7184, lng: 37.1212, pop: 145826 },
    { name: 'Osmaniye', plate_code: '80', region: 'Akdeniz', lat: 37.0746, lng: 36.2464, pop: 546000 },
    { name: 'Düzce', plate_code: '81', region: 'Karadeniz', lat: 40.8438, lng: 31.1565, pop: 395679 }
];

// ============================================
// ABONELİK MİMARİSİ (3 paket: Starter / Growth / Enterprise)
// ============================================
// Karar gerekçesi: TÜİK aylık veri ritmi (T+15 gün), Türkiye B2B SaaS fiyat anchor noktaları,
// pazarlama-finans dengesi (sabit MRR + esnek ARPU). AI sorgu sayısı kotalı (token değil),
// kapsam (rakip sayısı, geriye dönük yıl) tier başına farklı, WhatsApp sadece Enterprise.

const PLAN_FEATURE_CATALOG = {
    starter: [
        'dashboard_basic',
        'map_basic',
        'historical_basic',         // 12 ay limit (limit ayrı kontrol edilir)
        'province_basic',
        'model_catalog',
        'hp_segment_basic',
        'brand_summary',
        'export_limited'            // 50 satır/ay
    ],
    growth: [
        'competitor_analysis',      // 5 rakipe kadar
        'brand_compare',
        'model_compare',
        'province_top_brand',
        'model_region_analysis',
        'media_watch',
        'export_basic',             // sınırsız
        'weather_data',
        'tarmakbir_view',
        'historical_extended',      // 36 ay
        'ai_insights_limited'       // ayda 50 sorgu
    ],
    enterprise: [
        'ai_insights',              // sınırsız (fair use)
        'ai_forecast',
        'ai_brief',
        'automation_roadmap',
        'whatsapp_query',           // 3 telefon hattı
        'priority_support',
        'api_access',               // 10K istek/ay
        'custom_reports',
        'scheduled_exports',        // zamanlanmış otomatik export
        'historical_full',          // tüm geçmiş
        'unlimited_competitors',    // sınırsız rakip
        'province_diff_alerts'      // il bazlı diff alarmı
    ]
};

const growthFeatures = [...PLAN_FEATURE_CATALOG.starter, ...PLAN_FEATURE_CATALOG.growth];
const enterpriseFeatures = [...growthFeatures, ...PLAN_FEATURE_CATALOG.enterprise];

// Kapsam (scope) limitleri — feature_keys yetmez, sayısal limitler buradan okunur
const PLAN_LIMITS = {
    starter:    { max_rivals: 0,   history_months: 12,   ai_queries_monthly: 0,    export_rows_monthly: 50,   api_requests_monthly: 0,     whatsapp_phones: 0 },
    growth:     { max_rivals: 5,   history_months: 36,   ai_queries_monthly: 50,   export_rows_monthly: -1,   api_requests_monthly: 0,     whatsapp_phones: 0 },
    enterprise: { max_rivals: -1,  history_months: -1,   ai_queries_monthly: -1,   export_rows_monthly: -1,   api_requests_monthly: 10000, whatsapp_phones: 3 }
};

const subscriptionPlans = [
    {
        name: 'Starter', slug: 'starter', tier_rank: 1,
        price_monthly: 990.00, price_yearly: 9990.00, currency: 'TRY',
        description: 'Kendi markanızın saha verisini tek panoda izleyin',
        features: JSON.stringify([
            'Kendi marka satış ve pazar payı verileri',
            'İl analizi ve Türkiye haritası',
            'Son 12 ay tarihsel veri',
            'HP segment dağılımı',
            'Model kataloğu',
            'Aylık tescil güncellemesi (TÜİK T+15 gün)',
            'Aylık 50 satır Excel/PDF export',
            'E-posta bildirimi (yeni veri yayımlandığında)',
            '2 kullanıcı koltuğu'
        ]),
        feature_keys: JSON.stringify(PLAN_FEATURE_CATALOG.starter),
        plan_limits: JSON.stringify(PLAN_LIMITS.starter),
        max_users: 2,
        has_ai_insights: false, has_competitor_analysis: false, has_weather_data: false, has_export: true
    },
    {
        name: 'Growth', slug: 'growth', tier_rank: 2,
        price_monthly: 2990.00, price_yearly: 29990.00, currency: 'TRY',
        description: 'Rakip baskısını izleyin, marka/model kıyaslayın, AI ile derinleşin',
        features: JSON.stringify([
            'Tüm Starter özellikleri',
            'Rakip analizi (5 rakibe kadar)',
            'Marka ve model karşılaştırma stüdyoları',
            'İl liderlik merkezi',
            'Model-Bölge analizi',
            'Marka Medya Radarı (TR kaynaklar)',
            'İklim Komuta Merkezi',
            'Sınırsız Excel/PDF export',
            'Son 36 ay tarihsel veri',
            'AI Öngörüler (ayda 50 sorgu dahil)',
            'Aylık yönetici brifi PDF',
            '8 kullanıcı koltuğu'
        ]),
        feature_keys: JSON.stringify(growthFeatures),
        plan_limits: JSON.stringify(PLAN_LIMITS.growth),
        max_users: 8,
        has_ai_insights: true, has_competitor_analysis: true, has_weather_data: true, has_export: true
    },
    {
        name: 'Enterprise', slug: 'enterprise', tier_rank: 3,
        price_monthly: 9990.00, price_yearly: 99990.00, currency: 'TRY',
        description: 'Sınırsız rakip, AI savaş odası, WhatsApp sorgu kanalı ve API erişimi',
        features: JSON.stringify([
            'Tüm Growth özellikleri',
            'Sınırsız rakip analizi',
            'Sınırsız AI Öngörüler (fair use)',
            '12 aylık + uzun vade tahmin omurgası',
            'AI yönetici brifi (kişiye özel)',
            'WhatsApp sorgu kanalı (3 telefon)',
            'API erişimi (10.000 istek/ay)',
            'Otomasyon yol haritası',
            'Zamanlanmış otomatik raporlar',
            'İl bazlı diff alarmları',
            'Tüm tarihsel veri + erken erişim',
            'Öncelikli destek (4 saat SLA)',
            '25 kullanıcı koltuğu'
        ]),
        feature_keys: JSON.stringify(enterpriseFeatures),
        plan_limits: JSON.stringify(PLAN_LIMITS.enterprise),
        max_users: 25,
        has_ai_insights: true, has_competitor_analysis: true, has_weather_data: true, has_export: true
    }
];

module.exports = { brands, provinces, subscriptionPlans, PLAN_FEATURE_CATALOG, PLAN_LIMITS };
