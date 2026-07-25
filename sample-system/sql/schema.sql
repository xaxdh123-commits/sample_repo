CREATE TABLE IF NOT EXISTS samples (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  legacy_id VARCHAR(80) NULL,
  sample_number INT UNSIGNED NOT NULL,
  sample_code VARCHAR(32) NOT NULL,
  sample_type ENUM('label','packaging') NOT NULL DEFAULT 'label',
  envelope_type ENUM('small','large','none') NOT NULL DEFAULT 'small',
  plate_number VARCHAR(1000) NOT NULL,
  customer_name VARCHAR(255) NOT NULL,
  store_name VARCHAR(255) NOT NULL DEFAULT '',
  erp_shop_id BIGINT UNSIGNED NULL,
  erp_shop_code VARCHAR(100) NOT NULL DEFAULT '',
  owner_name VARCHAR(100) NOT NULL,
  owner_phone VARCHAR(50) NOT NULL,
  customer_id VARCHAR(100) NOT NULL DEFAULT '',
  order_number VARCHAR(100) NOT NULL DEFAULT '',
  sample_categories JSON NULL,
  content_changed TINYINT(1) NOT NULL DEFAULT 0,
  color_changed TINYINT(1) NOT NULL DEFAULT 0,
  specification_changed TINYINT(1) NOT NULL DEFAULT 0,
  box_type_changed TINYINT(1) NOT NULL DEFAULT 0,
  sample_content TEXT NOT NULL,
  sample_specification TEXT NOT NULL,
  sample_color TEXT NOT NULL,
  reserved_field_1 VARCHAR(500) NOT NULL DEFAULT '',
  reserved_field_2 VARCHAR(500) NOT NULL DEFAULT '',
  reserved_field_3 VARCHAR(500) NOT NULL DEFAULT '',
  note TEXT NOT NULL,
  status ENUM('draft','printed','claimed','sent','void','completed') NOT NULL DEFAULT 'draft',
  void_reason VARCHAR(1000) NOT NULL DEFAULT '',
  created_by_id VARCHAR(64) NOT NULL,
  created_by_username VARCHAR(100) NOT NULL,
  created_by_name VARCHAR(100) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_by_id VARCHAR(64) NOT NULL,
  updated_by_username VARCHAR(100) NOT NULL,
  updated_by_name VARCHAR(100) NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_samples_code (sample_code),
  UNIQUE KEY uk_samples_legacy_id (legacy_id),
  KEY idx_samples_status_updated (status, updated_at),
  CONSTRAINT chk_samples_order_or_plate CHECK (order_number<>'' OR plate_number<>''),
  FULLTEXT KEY ft_samples_search (plate_number, customer_name, store_name, owner_name, owner_phone, note)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sample_images (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sample_id BIGINT UNSIGNED NOT NULL,
  storage_path VARCHAR(500) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  byte_size INT UNSIGNED NOT NULL,
  sort_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_by_id VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_sample_image_order (sample_id, sort_order),
  CONSTRAINT fk_sample_images_sample FOREIGN KEY (sample_id) REFERENCES samples(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS owners (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  legacy_id VARCHAR(80) NULL,
  name VARCHAR(100) NOT NULL,
  phone VARCHAR(50) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_owners_legacy_id (legacy_id),
  UNIQUE KEY uk_owners_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS owner_stores (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  owner_id BIGINT UNSIGNED NOT NULL,
  store_name VARCHAR(255) NOT NULL,
  store_key VARCHAR(255) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_owner_store_key (store_key),
  KEY idx_owner_stores_owner (owner_id),
  CONSTRAINT fk_owner_stores_owner FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sample_operation_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  sample_id BIGINT UNSIGNED NOT NULL,
  action ENUM('create','update','status_change','print','reprint','image_add','image_delete','legacy_import') NOT NULL,
  from_status ENUM('draft','printed','claimed','sent','void','completed') NULL,
  to_status ENUM('draft','printed','claimed','sent','void','completed') NULL,
  change_summary JSON NULL,
  operator_id VARCHAR(64) NOT NULL,
  operator_username VARCHAR(100) NOT NULL,
  operator_name VARCHAR(100) NOT NULL,
  operated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_operation_sample_time (sample_id, operated_at),
  CONSTRAINT fk_operation_sample FOREIGN KEY (sample_id) REFERENCES samples(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS number_sequences (
  envelope_type ENUM('small','large','none') NOT NULL,
  next_number INT UNSIGNED NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (envelope_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO number_sequences (envelope_type, next_number)
VALUES ('small', 1), ('large', 1), ('none', 1);

CREATE TABLE IF NOT EXISTS sample_code_sequences (
  sequence_key VARCHAR(32) NOT NULL,
  next_number INT UNSIGNED NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (sequence_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO sample_code_sequences (sequence_key, next_number)
VALUES ('packaging', 1);

CREATE TABLE IF NOT EXISTS sso_sessions (
  token_hash CHAR(64) NOT NULL,
  user_id VARCHAR(64) NOT NULL,
  username VARCHAR(100) NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  roles_json JSON NOT NULL,
  permissions_json JSON NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (token_hash),
  KEY idx_sessions_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
