INSERT INTO workflow_events (workflow_id, step_name, phase, payload_json)
VALUES ('seed', 'seed', 'ready', '{"note":"seed marker"}')
ON CONFLICT DO NOTHING;
