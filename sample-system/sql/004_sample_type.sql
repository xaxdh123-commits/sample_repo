ALTER TABLE samples
  ADD COLUMN sample_type ENUM('label','packaging') NOT NULL DEFAULT 'label' AFTER sample_code;
