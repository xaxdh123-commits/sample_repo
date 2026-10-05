ALTER TABLE samples ADD INDEX idx_samples_created_at (created_at);
ALTER TABLE samples ADD INDEX idx_samples_type_status_created (sample_type, status, created_at);
ALTER TABLE samples ADD INDEX idx_samples_holder_status_updated (updated_by_id, status, updated_at);
ALTER TABLE sample_operation_logs ADD INDEX idx_operation_action_operator_time_sample (action, operator_id, operated_at, sample_id);
ALTER TABLE sample_operation_logs ADD INDEX idx_operation_operator_action_status_time (operator_id, action, to_status, operated_at);
