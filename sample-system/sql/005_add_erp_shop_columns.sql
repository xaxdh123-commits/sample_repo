ALTER TABLE samples
  ADD COLUMN erp_shop_id BIGINT UNSIGNED NULL AFTER store_name,
  ADD COLUMN erp_shop_code VARCHAR(100) NOT NULL DEFAULT '' AFTER erp_shop_id;
