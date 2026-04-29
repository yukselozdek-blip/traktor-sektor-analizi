-- ============================================
-- TRAKTÖR SEKTÖR ANALİZİ - VERİTABANI ŞEMASI
-- ============================================

-- n8n schema
CREATE SCHEMA IF NOT EXISTS n8n;

-- ============================================
-- 1. MARKALAR (Brands)
-- ============================================
CREATE TABLE IF NOT EXISTS brands (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    slug VARCHAR(100) NOT NULL UNIQUE,
    logo_url VARCHAR(500),
    primary_color VARCHAR(7) NOT NULL DEFAULT '#333333',
    secondary_color VARCHAR(7) NOT NULL DEFAULT '#666666',
    accent_color VARCHAR(7) DEFAULT '#999999',
    text_color VARCHAR(7) DEFAULT '#FFFFFF',
    country_of_origin VARCHAR(100),
    parent_company VARCHAR(200),
    website VARCHAR(500),
    description TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 2. KULLANICILAR (Users / Brand Representatives)
-- ============================================
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(200) NOT NULL,
    phone VARCHAR(20),
    role VARCHAR(50) NOT NULL DEFAULT 'brand_user',
    brand_id INTEGER REFERENCES brands(id),
    company_name VARCHAR(200),
    city VARCHAR(100),
    is_active BOOLEAN DEFAULT true,
    last_login TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 3. ABONELİK PLANLARI (Subscription Plans)
-- ============================================
CREATE TABLE IF NOT EXISTS subscription_plans (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(100) NOT NULL UNIQUE,
    price_monthly DECIMAL(10,2) NOT NULL,
    price_yearly DECIMAL(10,2),
    features JSONB DEFAULT '[]',
    max_users INTEGER DEFAULT 1,
    has_ai_insights BOOLEAN DEFAULT false,
    has_competitor_analysis BOOLEAN DEFAULT false,
    has_weather_data BOOLEAN DEFAULT false,
    has_export BOOLEAN DEFAULT false,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 4. ABONELİKLER (User Subscriptions)
-- ============================================
CREATE TABLE IF NOT EXISTS subscriptions (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    plan_id INTEGER NOT NULL REFERENCES subscription_plans(id),
    stripe_customer_id VARCHAR(255),
    stripe_subscription_id VARCHAR(255),
    status VARCHAR(50) NOT NULL DEFAULT 'active',
    current_period_start TIMESTAMP,
    current_period_end TIMESTAMP,
    cancel_at_period_end BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 5. İLLER (Turkish Provinces)
-- ============================================
CREATE TABLE IF NOT EXISTS provinces (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    plate_code VARCHAR(3) NOT NULL UNIQUE,
    region VARCHAR(100) NOT NULL,
    latitude DECIMAL(10,7),
    longitude DECIMAL(10,7),
    population INTEGER,
    agricultural_area_hectare DECIMAL(12,2),
    primary_crops TEXT[],
    soil_type VARCHAR(200),
    climate_zone VARCHAR(100),
    annual_rainfall_mm DECIMAL(8,2),
    avg_temperature DECIMAL(5,2),
    elevation_m INTEGER,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 6. TRAKTÖR MODELLERİ (Tractor Models)
-- ============================================
CREATE TABLE IF NOT EXISTS tractor_models (
    id SERIAL PRIMARY KEY,
    brand_id INTEGER NOT NULL REFERENCES brands(id),
    model_name VARCHAR(200) NOT NULL,
    model_code VARCHAR(100),
    category VARCHAR(50) NOT NULL, -- 'tarla', 'bahce', 'bagiris', 'ozel'
    cabin_type VARCHAR(50), -- 'kabinli', 'rollbar'
    drive_type VARCHAR(10), -- '2WD', '4WD'
    engine_brand VARCHAR(100),
    engine_model VARCHAR(100),
    cylinder_count INTEGER,
    displacement_cc INTEGER,
    horsepower DECIMAL(6,1) NOT NULL,
    hp_range VARCHAR(50), -- '0-50', '51-75', '76-100', '101-150', '150+'
    max_torque_nm DECIMAL(8,2),
    rpm_at_max_torque INTEGER,
    transmission_type VARCHAR(50), -- 'mekanik', 'senkromec', 'powershift', 'CVT'
    gear_config VARCHAR(20), -- '8+2', '8+8', '12+12', '16+16', '32+32', 'CVT'
    forward_gears INTEGER,
    reverse_gears INTEGER,
    has_creeper BOOLEAN DEFAULT false,
    has_shuttle BOOLEAN DEFAULT false,
    pto_rpm VARCHAR(50), -- '540', '540/1000', '540/750/1000'
    pto_power_hp DECIMAL(6,1),
    hydraulic_capacity_lpm DECIMAL(8,2),
    lift_capacity_kg DECIMAL(8,2),
    three_point_hitch VARCHAR(50), -- 'Cat I', 'Cat II', 'Cat III'
    drawbar_pull_kg DECIMAL(8,2),
    fuel_tank_liters DECIMAL(6,1),
    weight_kg DECIMAL(8,1),
    length_mm INTEGER,
    width_mm INTEGER,
    height_mm INTEGER,
    wheelbase_mm INTEGER,
    turning_radius_m DECIMAL(5,2),
    front_tire VARCHAR(50),
    rear_tire VARCHAR(50),
    has_aircon BOOLEAN DEFAULT false,
    has_suspension BOOLEAN DEFAULT false,
    emission_standard VARCHAR(20), -- 'Stage III', 'Stage IV', 'Stage V'
    price_list_tl DECIMAL(12,2),
    year_introduced INTEGER,
    is_current_model BOOLEAN DEFAULT true,
    specs_json JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(brand_id, model_name)
);

-- ============================================
-- 7. SATIŞ VERİLERİ (Sales Data)
-- ============================================
CREATE TABLE IF NOT EXISTS sales_data (
    id SERIAL PRIMARY KEY,
    brand_id INTEGER NOT NULL REFERENCES brands(id),
    province_id INTEGER REFERENCES provinces(id),
    model_id INTEGER REFERENCES tractor_models(id),
    year INTEGER NOT NULL,
    month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
    quantity INTEGER NOT NULL DEFAULT 0,
    category VARCHAR(50), -- 'tarla', 'bahce'
    cabin_type VARCHAR(50), -- 'kabinli', 'rollbar'
    drive_type VARCHAR(10), -- '2WD', '4WD'
    hp_range VARCHAR(50),
    gear_config VARCHAR(20),
    model_year INTEGER,
    data_source VARCHAR(100) DEFAULT 'TurkTractor',
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 7b. TUIK VERİLERİ (Raw Data for Satis Adetleri/Tescil Yil)
-- ============================================
CREATE TABLE IF NOT EXISTS tuik_veri (
    id SERIAL PRIMARY KEY,
    marka VARCHAR(200),
    tuik_model_adi VARCHAR(200),
    tescil_yil INTEGER,
    tescil_ay INTEGER,
    sehir_kodu INTEGER,
    sehir_adi VARCHAR(200),
    model_yili INTEGER,
    motor_hacmi_cc VARCHAR(50),
    renk VARCHAR(100),
    satis_adet INTEGER
);

-- ============================================
-- 7c. TEKNİK VERİLER (Raw Technical Specs)
-- ============================================
CREATE TABLE IF NOT EXISTS teknik_veri (
    id SERIAL PRIMARY KEY,
    marka VARCHAR(200),
    model VARCHAR(200),
    tuik_model_adi VARCHAR(200),
    fiyat_usd DECIMAL(12,2),
    emisyon_seviyesi VARCHAR(100),
    cekis_tipi VARCHAR(100),
    koruma VARCHAR(100),
    vites_sayisi VARCHAR(100),
    mensei VARCHAR(100),
    kullanim_alani VARCHAR(100),
    motor_marka VARCHAR(100),
    silindir_sayisi INTEGER,
    motor_gucu_hp DECIMAL(10,2),
    motor_devri_rpm INTEGER,
    maksimum_tork DECIMAL(10,2),
    depo_hacmi_lt DECIMAL(10,2),
    hidrolik_kaldirma DECIMAL(10,2),
    agirlik DECIMAL(10,2),
    dingil_mesafesi INTEGER,
    uzunluk INTEGER,
    yukseklik INTEGER,
    genislik INTEGER,
    model_yillari VARCHAR(200)
);

-- ============================================
-- 8. PAZAR PAYI VERİLERİ (Market Share Data)
-- ============================================
CREATE TABLE IF NOT EXISTS market_share (
    id SERIAL PRIMARY KEY,
    brand_id INTEGER NOT NULL REFERENCES brands(id),
    province_id INTEGER REFERENCES provinces(id),
    year INTEGER NOT NULL,
    month INTEGER,
    total_market_sales INTEGER NOT NULL DEFAULT 0,
    brand_sales INTEGER NOT NULL DEFAULT 0,
    market_share_pct DECIMAL(6,3),
    ranking INTEGER,
    segment VARCHAR(50), -- 'overall', 'tarla', 'bahce', 'kabinli', 'rollbar'
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 9. HAVA DURUMU VERİLERİ (Weather Data)
-- ============================================
CREATE TABLE IF NOT EXISTS weather_data (
    id SERIAL PRIMARY KEY,
    province_id INTEGER NOT NULL REFERENCES provinces(id),
    date DATE NOT NULL,
    temp_min DECIMAL(5,2),
    temp_max DECIMAL(5,2),
    temp_avg DECIMAL(5,2),
    humidity_pct DECIMAL(5,2),
    rainfall_mm DECIMAL(8,2),
    wind_speed_kmh DECIMAL(6,2),
    weather_condition VARCHAR(100),
    is_forecast BOOLEAN DEFAULT false,
    source VARCHAR(100) DEFAULT 'openweathermap',
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(province_id, date, is_forecast)
);

-- ============================================
-- 10. İKLİM ANALİZİ (Climate Analysis - 10 Year)
-- ============================================
CREATE TABLE IF NOT EXISTS climate_analysis (
    id SERIAL PRIMARY KEY,
    province_id INTEGER NOT NULL REFERENCES provinces(id),
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    avg_temp DECIMAL(5,2),
    avg_rainfall_mm DECIMAL(8,2),
    avg_humidity DECIMAL(5,2),
    frost_days INTEGER DEFAULT 0,
    drought_index DECIMAL(5,2),
    growing_degree_days DECIMAL(8,2),
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(province_id, year, month)
);

-- ============================================
-- 11. TOPRAK ANALİZİ (Soil Data per Province)
-- ============================================
CREATE TABLE IF NOT EXISTS soil_data (
    id SERIAL PRIMARY KEY,
    province_id INTEGER NOT NULL REFERENCES provinces(id),
    soil_type VARCHAR(100) NOT NULL,
    soil_texture VARCHAR(100),
    ph_level DECIMAL(4,2),
    organic_matter_pct DECIMAL(5,2),
    suitable_crops TEXT[],
    recommended_hp_range VARCHAR(50),
    recommended_tractor_type VARCHAR(50),
    recommended_drive_type VARCHAR(10),
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 12. EKİN VERİLERİ (Crop Data per Province)
-- ============================================
CREATE TABLE IF NOT EXISTS crop_data (
    id SERIAL PRIMARY KEY,
    province_id INTEGER NOT NULL REFERENCES provinces(id),
    crop_name VARCHAR(100) NOT NULL,
    crop_type VARCHAR(50), -- 'tahil', 'endustriyel', 'meyve', 'sebze', 'yem'
    cultivation_area_hectare DECIMAL(12,2),
    annual_production_tons DECIMAL(14,2),
    year INTEGER NOT NULL,
    planting_season VARCHAR(50),
    harvest_season VARCHAR(50),
    requires_hp_min INTEGER,
    requires_hp_max INTEGER,
    suitable_tractor_types TEXT[],
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 13. AI İÇGÖRÜLERİ (AI Insights from n8n)
-- ============================================
CREATE TABLE IF NOT EXISTS ai_insights (
    id SERIAL PRIMARY KEY,
    brand_id INTEGER REFERENCES brands(id),
    province_id INTEGER REFERENCES provinces(id),
    insight_type VARCHAR(100) NOT NULL,
    title VARCHAR(500) NOT NULL,
    content TEXT NOT NULL,
    data_json JSONB DEFAULT '{}',
    confidence_score DECIMAL(4,2),
    source VARCHAR(100) DEFAULT 'n8n-ai-agent',
    is_active BOOLEAN DEFAULT true,
    expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 14. RAKİP ANALİZİ (Competitor Analysis)
-- ============================================
CREATE TABLE IF NOT EXISTS competitor_analysis (
    id SERIAL PRIMARY KEY,
    brand_id INTEGER NOT NULL REFERENCES brands(id),
    competitor_brand_id INTEGER NOT NULL REFERENCES brands(id),
    province_id INTEGER REFERENCES provinces(id),
    year INTEGER NOT NULL,
    analysis_type VARCHAR(100) NOT NULL,
    dimension VARCHAR(100), -- 'hp_range', 'cabin_type', 'drive_type', 'gear_config', 'price', 'market_share'
    brand_value DECIMAL(12,2),
    competitor_value DECIMAL(12,2),
    difference_pct DECIMAL(8,3),
    insight TEXT,
    data_json JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 15. ÖDEME GEÇMİŞİ (Payment History)
-- ============================================
CREATE TABLE IF NOT EXISTS payments (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    subscription_id INTEGER REFERENCES subscriptions(id),
    stripe_payment_id VARCHAR(255),
    amount DECIMAL(10,2) NOT NULL,
    currency VARCHAR(3) DEFAULT 'TRY',
    status VARCHAR(50) NOT NULL,
    payment_method VARCHAR(50),
    invoice_url VARCHAR(500),
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 16. KULLANICI AKTİVİTELERİ (Audit Log)
-- ============================================
CREATE TABLE IF NOT EXISTS activity_log (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    action VARCHAR(100) NOT NULL,
    resource VARCHAR(100),
    resource_id INTEGER,
    details JSONB DEFAULT '{}',
    ip_address VARCHAR(45),
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 17. BİLDİRİMLER (Notifications)
-- ============================================
CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    brand_id INTEGER REFERENCES brands(id),
    type VARCHAR(50) NOT NULL,
    title VARCHAR(500) NOT NULL,
    body TEXT,
    is_read BOOLEAN DEFAULT false,
    data_json JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 18. N8N WORKFLOW KAYITLARI
-- ============================================
CREATE TABLE IF NOT EXISTS n8n_workflows (
    id SERIAL PRIMARY KEY,
    title VARCHAR(200) NOT NULL,
    description TEXT,
    workflow_type VARCHAR(100),
    n8n_workflow_id VARCHAR(100),
    status VARCHAR(50) DEFAULT 'active',
    schedule VARCHAR(100),
    last_run TIMESTAMP,
    last_result JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 18B. MEDYA TAKIP CALISTIRMALARI
-- ============================================
CREATE TABLE IF NOT EXISTS media_watch_runs (
    id SERIAL PRIMARY KEY,
    brand_id INTEGER REFERENCES brands(id) ON DELETE CASCADE,
    workflow_code VARCHAR(120),
    run_key VARCHAR(160) UNIQUE,
    status VARCHAR(50) DEFAULT 'queued',
    trigger_source VARCHAR(50) DEFAULT 'n8n',
    item_count INTEGER DEFAULT 0,
    error_message TEXT,
    started_at TIMESTAMP DEFAULT NOW(),
    finished_at TIMESTAMP,
    meta_json JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 18C. MEDYA TAKIP OGELERI
-- ============================================
CREATE TABLE IF NOT EXISTS media_watch_items (
    id SERIAL PRIMARY KEY,
    brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
    province_id INTEGER REFERENCES provinces(id) ON DELETE SET NULL,
    source_id INTEGER REFERENCES intelligence_sources(id) ON DELETE SET NULL,
    run_id INTEGER REFERENCES media_watch_runs(id) ON DELETE SET NULL,
    channel_type VARCHAR(50) NOT NULL,
    item_type VARCHAR(60) NOT NULL,
    platform_name VARCHAR(120),
    source_name VARCHAR(255),
    source_domain VARCHAR(255),
    source_url VARCHAR(1000) NOT NULL,
    title VARCHAR(600) NOT NULL,
    summary TEXT,
    content_text TEXT,
    ai_summary TEXT,
    author_name VARCHAR(255),
    external_id VARCHAR(255),
    language_code VARCHAR(10) DEFAULT 'tr',
    country_code VARCHAR(10) DEFAULT 'TR',
    model_name VARCHAR(255),
    product_name VARCHAR(255),
    complaint_area VARCHAR(120),
    issue_type VARCHAR(120),
    sentiment_label VARCHAR(30),
    sentiment_score DECIMAL(5,2),
    severity_score DECIMAL(5,2),
    relevance_score DECIMAL(5,2),
    published_at TIMESTAMP,
    collected_at TIMESTAMP DEFAULT NOW(),
    engagement_json JSONB DEFAULT '{}',
    tags_json JSONB DEFAULT '[]',
    topics_json JSONB DEFAULT '[]',
    entities_json JSONB DEFAULT '[]',
    recommendations_json JSONB DEFAULT '{}',
    raw_payload JSONB DEFAULT '{}',
    dedupe_hash VARCHAR(80) NOT NULL UNIQUE,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 18D. MEDYA TAKIP BRIFLERI
-- ============================================
CREATE TABLE IF NOT EXISTS media_watch_briefs (
    id SERIAL PRIMARY KEY,
    brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
    run_id INTEGER REFERENCES media_watch_runs(id) ON DELETE SET NULL,
    brief_type VARCHAR(50) DEFAULT 'executive',
    period_label VARCHAR(120),
    window_days INTEGER DEFAULT 14,
    item_count INTEGER DEFAULT 0,
    risk_level VARCHAR(30) DEFAULT 'watch',
    executive_summary_md TEXT,
    sections_json JSONB DEFAULT '{}',
    source_mix_json JSONB DEFAULT '{}',
    ai_model VARCHAR(100),
    created_by VARCHAR(100) DEFAULT 'system',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 18E. MEDYA TAKIP ALARMLARI
-- ============================================
CREATE TABLE IF NOT EXISTS media_watch_alerts (
    id SERIAL PRIMARY KEY,
    brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
    run_id INTEGER REFERENCES media_watch_runs(id) ON DELETE SET NULL,
    brief_id INTEGER REFERENCES media_watch_briefs(id) ON DELETE SET NULL,
    alert_key VARCHAR(180) NOT NULL UNIQUE,
    alert_level VARCHAR(30) DEFAULT 'watch',
    alert_type VARCHAR(60) NOT NULL,
    title VARCHAR(255) NOT NULL,
    summary TEXT,
    action_owner VARCHAR(80),
    source_count INTEGER DEFAULT 0,
    item_count INTEGER DEFAULT 0,
    average_severity DECIMAL(5,2),
    confidence_score DECIMAL(5,2),
    source_item_ids_json JSONB DEFAULT '[]',
    meta_json JSONB DEFAULT '{}',
    first_seen_at TIMESTAMP,
    last_seen_at TIMESTAMP,
    is_open BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 19. MARKA PORTAL PROFILLERI
-- ============================================
CREATE TABLE IF NOT EXISTS brand_portal_profiles (
    id SERIAL PRIMARY KEY,
    brand_id INTEGER NOT NULL UNIQUE REFERENCES brands(id) ON DELETE CASCADE,
    tagline VARCHAR(255),
    hero_title VARCHAR(255),
    hero_subtitle TEXT,
    overview TEXT,
    website_url VARCHAR(500),
    dealer_locator_url VARCHAR(500),
    price_list_url VARCHAR(500),
    portal_url VARCHAR(500),
    contact_phone VARCHAR(50),
    contact_email VARCHAR(255),
    whatsapp_url VARCHAR(500),
    headquarters TEXT,
    hero_stats_json JSONB DEFAULT '[]',
    social_links_json JSONB DEFAULT '[]',
    product_lines_json JSONB DEFAULT '[]',
    focus_regions_json JSONB DEFAULT '[]',
    source_notes_json JSONB DEFAULT '[]',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 20. MARKA PORTAL OGELERI
-- ============================================
CREATE TABLE IF NOT EXISTS brand_portal_items (
    id SERIAL PRIMARY KEY,
    brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
    item_type VARCHAR(50) NOT NULL,
    title VARCHAR(255) NOT NULL,
    summary TEXT,
    cta_label VARCHAR(100),
    cta_url VARCHAR(500),
    image_url VARCHAR(500),
    meta_json JSONB DEFAULT '{}',
    published_at TIMESTAMP,
    priority INTEGER DEFAULT 100,
    is_featured BOOLEAN DEFAULT false,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(brand_id, item_type, title)
);

-- ============================================
-- 20A. MODEL FOTO GALERISI
-- ============================================
CREATE TABLE IF NOT EXISTS model_image_gallery (
    id SERIAL PRIMARY KEY,
    brand_name VARCHAR(150) NOT NULL,
    model_name VARCHAR(255) NOT NULL,
    tuik_model_adi VARCHAR(255),
    image_url VARCHAR(1000) NOT NULL,
    source_url VARCHAR(1000),
    source_name VARCHAR(160),
    angle_label VARCHAR(100) DEFAULT 'Ürün görseli',
    caption VARCHAR(255),
    width INTEGER,
    height INTEGER,
    confidence_score DECIMAL(5,2) DEFAULT 0.75,
    model_match_level VARCHAR(40) DEFAULT 'unknown',
    verification_status VARCHAR(40) DEFAULT 'candidate',
    review_status VARCHAR(40) DEFAULT 'candidate',
    verified_at TIMESTAMP,
    sort_order INTEGER DEFAULT 100,
    is_primary BOOLEAN DEFAULT false,
    is_active BOOLEAN DEFAULT true,
    raw_payload JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(brand_name, model_name, image_url)
);

-- ============================================
-- 21. MARKA PORTAL ILETISIM VE SAHA KAYITLARI
-- ============================================
CREATE TABLE IF NOT EXISTS brand_portal_contacts (
    id SERIAL PRIMARY KEY,
    brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
    contact_type VARCHAR(50) NOT NULL,
    label VARCHAR(150) NOT NULL,
    region_name VARCHAR(100),
    city VARCHAR(100),
    contact_name VARCHAR(150),
    title VARCHAR(150),
    phone VARCHAR(50),
    email VARCHAR(255),
    url VARCHAR(500),
    sort_order INTEGER DEFAULT 100,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(brand_id, contact_type, label, city)
);

-- ============================================
-- 22. INTELLIGENCE SOURCES
-- ============================================
CREATE TABLE IF NOT EXISTS intelligence_sources (
    id SERIAL PRIMARY KEY,
    source_code VARCHAR(100) NOT NULL UNIQUE,
    title VARCHAR(255) NOT NULL,
    publisher VARCHAR(150),
    source_type VARCHAR(50) NOT NULL,
    geography_scope VARCHAR(50) DEFAULT 'turkiye',
    official_url VARCHAR(500),
    publication_date DATE,
    notes TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 23. SUPPORT PROGRAMS
-- ============================================
CREATE TABLE IF NOT EXISTS support_programs (
    id SERIAL PRIMARY KEY,
    program_code VARCHAR(100) NOT NULL UNIQUE,
    authority_name VARCHAR(150) NOT NULL,
    program_name VARCHAR(255) NOT NULL,
    program_type VARCHAR(100),
    status VARCHAR(50) DEFAULT 'planned',
    support_scope TEXT,
    support_mode VARCHAR(50),
    currency VARCHAR(10) DEFAULT 'TRY',
    min_grant_rate_pct DECIMAL(5,2),
    max_grant_rate_pct DECIMAL(5,2),
    source_id INTEGER REFERENCES intelligence_sources(id),
    official_url VARCHAR(500),
    notes TEXT,
    effective_start_date DATE,
    effective_end_date DATE,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 24. SUPPORT PROGRAM COVERAGE
-- ============================================
CREATE TABLE IF NOT EXISTS support_program_coverage (
    id SERIAL PRIMARY KEY,
    program_id INTEGER NOT NULL REFERENCES support_programs(id) ON DELETE CASCADE,
    province_id INTEGER REFERENCES provinces(id) ON DELETE CASCADE,
    region_name VARCHAR(100),
    coverage_scope VARCHAR(50) DEFAULT 'province',
    eligible_investments TEXT[] DEFAULT '{}',
    target_segments TEXT[] DEFAULT '{}',
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 25. SUPPORT APPLICATION WINDOWS
-- ============================================
CREATE TABLE IF NOT EXISTS support_application_windows (
    id SERIAL PRIMARY KEY,
    program_id INTEGER NOT NULL REFERENCES support_programs(id) ON DELETE CASCADE,
    application_year INTEGER NOT NULL,
    call_no VARCHAR(50),
    open_date DATE,
    close_date DATE,
    budget_amount DECIMAL(16,2),
    budget_currency VARCHAR(10) DEFAULT 'EUR',
    status VARCHAR(50) DEFAULT 'announced',
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(program_id, application_year, call_no)
);

-- ============================================
-- 26. COMMODITY PRICES
-- ============================================
CREATE TABLE IF NOT EXISTS commodity_prices (
    id SERIAL PRIMARY KEY,
    commodity_code VARCHAR(50) NOT NULL,
    commodity_name VARCHAR(150) NOT NULL,
    market_scope VARCHAR(50) DEFAULT 'turkiye',
    province_id INTEGER REFERENCES provinces(id) ON DELETE CASCADE,
    price_date DATE NOT NULL,
    year INTEGER NOT NULL,
    month INTEGER,
    unit VARCHAR(50),
    currency VARCHAR(10) DEFAULT 'TRY',
    nominal_price DECIMAL(16,4),
    source_id INTEGER REFERENCES intelligence_sources(id),
    metadata_json JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 27. CLIMATE PROJECTION SCENARIOS
-- ============================================
CREATE TABLE IF NOT EXISTS climate_projection_scenarios (
    id SERIAL PRIMARY KEY,
    province_id INTEGER REFERENCES provinces(id) ON DELETE CASCADE,
    region_name VARCHAR(100),
    scenario_code VARCHAR(50) NOT NULL,
    horizon_year INTEGER NOT NULL,
    metric_code VARCHAR(100) NOT NULL,
    metric_label VARCHAR(150),
    change_value DECIMAL(12,4),
    change_unit VARCHAR(30),
    baseline_period VARCHAR(50),
    source_id INTEGER REFERENCES intelligence_sources(id),
    notes TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 28. FORECAST RUNS
-- ============================================
CREATE TABLE IF NOT EXISTS forecast_runs (
    id SERIAL PRIMARY KEY,
    forecast_key VARCHAR(120) NOT NULL UNIQUE,
    model_family VARCHAR(100) NOT NULL,
    scope_level VARCHAR(50) NOT NULL,
    target_entity_type VARCHAR(50) NOT NULL,
    target_entity_id INTEGER,
    scenario_code VARCHAR(50) DEFAULT 'base',
    forecast_horizon_months INTEGER NOT NULL,
    training_start_year INTEGER,
    training_end_year INTEGER,
    run_status VARCHAR(50) DEFAULT 'draft',
    metrics_json JSONB DEFAULT '{}',
    feature_snapshot_json JSONB DEFAULT '{}',
    notes TEXT,
    created_by_user_id INTEGER REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 29. FORECAST FEATURE STORE
-- ============================================
CREATE TABLE IF NOT EXISTS forecast_feature_store (
    id SERIAL PRIMARY KEY,
    forecast_key VARCHAR(120) NOT NULL,
    snapshot_date DATE NOT NULL,
    province_id INTEGER REFERENCES provinces(id) ON DELETE CASCADE,
    brand_id INTEGER REFERENCES brands(id) ON DELETE CASCADE,
    commodity_code VARCHAR(50),
    feature_code VARCHAR(100) NOT NULL,
    feature_value DECIMAL(16,4),
    feature_unit VARCHAR(50),
    feature_source VARCHAR(100),
    source_id INTEGER REFERENCES intelligence_sources(id),
    metadata_json JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 30. FORECAST OUTPUTS
-- ============================================
CREATE TABLE IF NOT EXISTS forecast_outputs (
    id SERIAL PRIMARY KEY,
    forecast_run_id INTEGER NOT NULL REFERENCES forecast_runs(id) ON DELETE CASCADE,
    period_year INTEGER NOT NULL,
    period_month INTEGER,
    province_id INTEGER REFERENCES provinces(id) ON DELETE CASCADE,
    brand_id INTEGER REFERENCES brands(id) ON DELETE CASCADE,
    hp_range VARCHAR(50),
    drive_type VARCHAR(20),
    cabin_type VARCHAR(30),
    category VARCHAR(30),
    predicted_units DECIMAL(16,4),
    confidence_low DECIMAL(16,4),
    confidence_high DECIMAL(16,4),
    baseline_units DECIMAL(16,4),
    signal_summary TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 31. MODEL FEATURE DEMAND
-- ============================================
CREATE TABLE IF NOT EXISTS model_feature_demand (
    id SERIAL PRIMARY KEY,
    forecast_run_id INTEGER REFERENCES forecast_runs(id) ON DELETE CASCADE,
    province_id INTEGER REFERENCES provinces(id) ON DELETE CASCADE,
    brand_id INTEGER REFERENCES brands(id) ON DELETE CASCADE,
    horizon_year INTEGER NOT NULL,
    feature_type VARCHAR(50) NOT NULL,
    feature_value VARCHAR(100) NOT NULL,
    demand_share_pct DECIMAL(8,4),
    demand_units DECIMAL(16,4),
    evidence_json JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================
-- 32. PROVINCE RISK SIGNALS
-- ============================================
CREATE TABLE IF NOT EXISTS province_risk_signals (
    id SERIAL PRIMARY KEY,
    province_id INTEGER NOT NULL REFERENCES provinces(id) ON DELETE CASCADE,
    signal_date DATE NOT NULL,
    signal_type VARCHAR(100) NOT NULL,
    severity_score DECIMAL(8,4),
    signal_label VARCHAR(150),
    signal_summary TEXT,
    source_id INTEGER REFERENCES intelligence_sources(id),
    metadata_json JSONB DEFAULT '{}',
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(province_id, signal_date, signal_type)
);

-- ============================================
-- INDEXES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_sales_brand_year ON sales_data(brand_id, year);
CREATE INDEX IF NOT EXISTS idx_sales_province_year ON sales_data(province_id, year);
CREATE INDEX IF NOT EXISTS idx_sales_year_month ON sales_data(year, month);
CREATE INDEX IF NOT EXISTS idx_sales_category ON sales_data(category);
CREATE INDEX IF NOT EXISTS idx_sales_hp_range ON sales_data(hp_range);
CREATE INDEX IF NOT EXISTS idx_sales_gear ON sales_data(gear_config);
CREATE INDEX IF NOT EXISTS idx_market_share_brand ON market_share(brand_id, year);
CREATE INDEX IF NOT EXISTS idx_market_share_province ON market_share(province_id, year);
CREATE INDEX IF NOT EXISTS idx_tractor_models_brand ON tractor_models(brand_id);
CREATE INDEX IF NOT EXISTS idx_tractor_models_hp ON tractor_models(horsepower);
CREATE INDEX IF NOT EXISTS idx_tractor_models_category ON tractor_models(category);
CREATE INDEX IF NOT EXISTS idx_weather_province_date ON weather_data(province_id, date);
CREATE INDEX IF NOT EXISTS idx_climate_province ON climate_analysis(province_id, year, month);
CREATE INDEX IF NOT EXISTS idx_crop_province ON crop_data(province_id, year);
CREATE INDEX IF NOT EXISTS idx_tuik_year_city ON tuik_veri(tescil_yil, sehir_kodu);
CREATE INDEX IF NOT EXISTS idx_tuik_year_city_brand_model ON tuik_veri(tescil_yil, sehir_kodu, marka, tuik_model_adi);
CREATE INDEX IF NOT EXISTS idx_tuik_brand_model_upper ON tuik_veri(UPPER(marka), UPPER(tuik_model_adi));
CREATE INDEX IF NOT EXISTS idx_teknik_brand_model_upper ON teknik_veri(UPPER(marka), UPPER(tuik_model_adi));
CREATE INDEX IF NOT EXISTS idx_ai_insights_brand ON ai_insights(brand_id);
CREATE INDEX IF NOT EXISTS idx_ai_insights_province ON ai_insights(province_id);
CREATE INDEX IF NOT EXISTS idx_media_watch_items_brand ON media_watch_items(brand_id, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_watch_items_type ON media_watch_items(item_type, channel_type);
CREATE INDEX IF NOT EXISTS idx_media_watch_items_sentiment ON media_watch_items(sentiment_label, severity_score);
CREATE INDEX IF NOT EXISTS idx_media_watch_runs_brand ON media_watch_runs(brand_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_watch_briefs_brand ON media_watch_briefs(brand_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_watch_alerts_brand ON media_watch_alerts(brand_id, is_open, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_watch_alerts_level ON media_watch_alerts(alert_level, alert_type);
CREATE INDEX IF NOT EXISTS idx_competitor_brand ON competitor_analysis(brand_id, year);
CREATE INDEX IF NOT EXISTS idx_users_brand ON users(brand_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_log(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_brand_portal_items_brand ON brand_portal_items(brand_id, is_active, is_featured);
CREATE INDEX IF NOT EXISTS idx_brand_portal_items_published ON brand_portal_items(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_brand_portal_contacts_brand ON brand_portal_contacts(brand_id, is_active, sort_order);
CREATE INDEX IF NOT EXISTS idx_model_image_gallery_model ON model_image_gallery(UPPER(brand_name), UPPER(model_name), is_active);
CREATE INDEX IF NOT EXISTS idx_model_image_gallery_tuik ON model_image_gallery(UPPER(brand_name), UPPER(tuik_model_adi), is_active);
CREATE INDEX IF NOT EXISTS idx_intelligence_sources_type ON intelligence_sources(source_type, is_active);
CREATE INDEX IF NOT EXISTS idx_support_programs_status ON support_programs(status, program_type);
CREATE INDEX IF NOT EXISTS idx_support_program_coverage_program ON support_program_coverage(program_id, province_id);
CREATE INDEX IF NOT EXISTS idx_support_application_windows_program ON support_application_windows(program_id, application_year);
CREATE INDEX IF NOT EXISTS idx_commodity_prices_lookup ON commodity_prices(commodity_code, year, month, province_id);
CREATE INDEX IF NOT EXISTS idx_climate_projection_lookup ON climate_projection_scenarios(scenario_code, horizon_year, province_id);
CREATE INDEX IF NOT EXISTS idx_forecast_runs_scope ON forecast_runs(scope_level, scenario_code, run_status);
CREATE INDEX IF NOT EXISTS idx_forecast_feature_store_lookup ON forecast_feature_store(forecast_key, snapshot_date, province_id, brand_id);
CREATE INDEX IF NOT EXISTS idx_forecast_outputs_run ON forecast_outputs(forecast_run_id, period_year, period_month);
CREATE INDEX IF NOT EXISTS idx_model_feature_demand_lookup ON model_feature_demand(forecast_run_id, horizon_year, province_id, brand_id);
CREATE INDEX IF NOT EXISTS idx_province_risk_signals_lookup ON province_risk_signals(province_id, signal_date, signal_type);
