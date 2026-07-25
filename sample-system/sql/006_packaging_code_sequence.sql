CREATE TABLE IF NOT EXISTS sample_code_sequences (
  sequence_key VARCHAR(32) NOT NULL,
  next_number INT UNSIGNED NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (sequence_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO sample_code_sequences (sequence_key, next_number)
SELECT 'packaging',
       COALESCE(MAX(CASE
         WHEN sample_code REGEXP '^BZ[0-9]+$' THEN CAST(SUBSTRING(sample_code, 3) AS UNSIGNED)
         ELSE NULL
       END), 0) + 1
  FROM samples
ON DUPLICATE KEY UPDATE next_number=GREATEST(next_number, VALUES(next_number));
