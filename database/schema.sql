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
    data_source VARCHAR(100) DEFAULT 'TurkTractor',
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(brand_id, province_id, year, month, category, cabin_type, drive_type, hp_range, gear_config)
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
CREATE INDEX IF NOT EXISTS idx_ai_insights_brand ON ai_insights(brand_id);
CREATE INDEX IF NOT EXISTS idx_ai_insights_province ON ai_insights(province_id);
CREATE INDEX IF NOT EXISTS idx_competitor_brand ON competitor_analysis(brand_id, year);
CREATE INDEX IF NOT EXISTS idx_users_brand ON users(brand_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_user ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_activity_user ON activity_log(user_id, created_at);
