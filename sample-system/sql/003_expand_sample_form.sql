ALTER TABLE samples
  ADD COLUMN customer_id VARCHAR(100) NOT NULL DEFAULT '' AFTER owner_phone,
  ADD COLUMN order_number VARCHAR(100) NOT NULL DEFAULT '' AFTER customer_id,
  ADD COLUMN sample_categories JSON NULL AFTER order_number,
  ADD COLUMN content_changed TINYINT(1) NOT NULL DEFAULT 0 AFTER sample_categories,
  ADD COLUMN color_changed TINYINT(1) NOT NULL DEFAULT 0 AFTER content_changed,
  ADD COLUMN specification_changed TINYINT(1) NOT NULL DEFAULT 0 AFTER color_changed,
  ADD COLUMN box_type_changed TINYINT(1) NOT NULL DEFAULT 0 AFTER specification_changed,
  ADD COLUMN sample_content TEXT NOT NULL AFTER box_type_changed,
  ADD COLUMN sample_specification TEXT NOT NULL AFTER sample_content,
  ADD COLUMN sample_color TEXT NOT NULL AFTER sample_specification,
  ADD COLUMN reserved_field_1 VARCHAR(500) NOT NULL DEFAULT '' AFTER sample_color,
  ADD COLUMN reserved_field_2 VARCHAR(500) NOT NULL DEFAULT '' AFTER reserved_field_1,
  ADD COLUMN reserved_field_3 VARCHAR(500) NOT NULL DEFAULT '' AFTER reserved_field_2;
