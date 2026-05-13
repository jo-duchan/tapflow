-- 007_app_platform_model.sql
-- App을 제품 단위 엔티티로 확장: platform이 'ios' | 'android' | 'both' 를 지원
-- 개별 build는 항상 'ios' | 'android' 중 하나를 가지므로 builds에 platform 컬럼 추가

PRAGMA foreign_keys = OFF;

-- Step 1. apps 테이블 재구성
--   - bundle_id_key: NOT NULL → nullable (앱 먼저 생성, 빌드 나중 추가 지원)
--   - platform CHECK: 'both' 추가
--   - UNIQUE(bundle_id_key, platform): 제거 (application 레벨에서 처리)
CREATE TABLE apps_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  bundle_id_key TEXT,
  platform      TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'both')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO apps_new (id, name, bundle_id_key, platform, created_at)
SELECT id, name, bundle_id_key, platform, created_at FROM apps;

DROP TABLE apps;
ALTER TABLE apps_new RENAME TO apps;

-- Step 2. builds에 platform 컬럼 추가
--   - app.platform이 'both'인 경우 개별 빌드 수준에서 플랫폼 식별이 필요
ALTER TABLE builds ADD COLUMN platform TEXT CHECK (platform IN ('ios', 'android'));

-- Step 3. 기존 builds.platform 채우기 (기존 앱은 모두 'ios' | 'android')
UPDATE builds SET platform = (
  SELECT a.platform FROM apps a WHERE a.id = builds.app_id
);

PRAGMA foreign_keys = ON;
