-- Full schema for a new Allur application Supabase project.
-- Run this entire script once in Supabase Dashboard -> SQL Editor.
-- Then start the backend with SUPABASE_DB_URL pointing to this project.
-- Backend startup synchronizes reference data and transfers local application data.

BEGIN;

CREATE TABLE areas (
	code VARCHAR(16) NOT NULL, 
	name VARCHAR(60) NOT NULL, 
	kind VARCHAR(16) NOT NULL, 
	line VARCHAR(40), 
	position INTEGER NOT NULL, 
	cycle_s FLOAT NOT NULL, 
	buffer_after INTEGER NOT NULL, 
	PRIMARY KEY (code), 
	UNIQUE (name)
);

CREATE TABLE car_models (
	code VARCHAR(20) NOT NULL, 
	name VARCHAR(60) NOT NULL, 
	month_plan INTEGER, 
	PRIMARY KEY (code), 
	UNIQUE (name)
);

CREATE TABLE shifts (
	number INTEGER NOT NULL, 
	starts VARCHAR(5) NOT NULL, 
	ends VARCHAR(5) NOT NULL, 
	hours FLOAT NOT NULL, 
	PRIMARY KEY (number)
);

CREATE TABLE meta (
	key VARCHAR(40) NOT NULL, 
	value VARCHAR(200) NOT NULL, 
	PRIMARY KEY (key)
);

INSERT INTO meta (key, value) VALUES ('schema_version', '3');

CREATE TABLE shift_ready (
	id SERIAL NOT NULL, 
	shift_id INTEGER NOT NULL, 
	user_id INTEGER NOT NULL, 
	name VARCHAR(80) NOT NULL, 
	area VARCHAR(16), 
	status VARCHAR(12) NOT NULL, 
	note TEXT NOT NULL, 
	at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (shift_id, user_id), 
	CONSTRAINT ck_shift_ready_status CHECK (status IN ('ready', 'absent'))
);

CREATE INDEX ix_shift_ready_user_id ON shift_ready (user_id);

CREATE INDEX ix_shift_ready_shift_id ON shift_ready (shift_id);

CREATE TABLE imports (
	id SERIAL NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	filename VARCHAR(200) NOT NULL, 
	role VARCHAR(20) NOT NULL, 
	summary JSON NOT NULL, 
	PRIMARY KEY (id)
);

CREATE TABLE settings (
	key VARCHAR(60) NOT NULL, 
	value JSON NOT NULL, 
	PRIMARY KEY (key)
);

CREATE TABLE audit_log (
	id SERIAL NOT NULL, 
	at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	plant_time TIMESTAMP WITHOUT TIME ZONE, 
	category VARCHAR(16) NOT NULL, 
	action VARCHAR(40) NOT NULL, 
	severity VARCHAR(10) NOT NULL, 
	actor VARCHAR(60) NOT NULL, 
	title VARCHAR(240) NOT NULL, 
	details JSON NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT ck_audit_severity CHECK (severity IN ('info', 'warning', 'critical'))
);

CREATE INDEX ix_audit_log_at ON audit_log (at);

CREATE INDEX ix_audit_category_at ON audit_log (category, at);

CREATE TABLE builder_layouts (
	id SERIAL NOT NULL, 
	name VARCHAR(120) NOT NULL, 
	data JSON NOT NULL, 
	nodes INTEGER NOT NULL, 
	equipment INTEGER NOT NULL, 
	author VARCHAR(60) NOT NULL, 
	updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	PRIMARY KEY (id)
);

CREATE INDEX ix_builder_layouts_updated_at ON builder_layouts (updated_at);

CREATE TABLE chat_messages (
	id SERIAL NOT NULL, 
	channel VARCHAR(24) NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	author_id INTEGER, 
	author VARCHAR(80) NOT NULL, 
	position VARCHAR(80) NOT NULL, 
	role VARCHAR(16) NOT NULL, 
	kind VARCHAR(10) NOT NULL, 
	text TEXT NOT NULL, 
	ref JSON, 
	reply_to_id INTEGER, 
	edited_at TIMESTAMP WITHOUT TIME ZONE, 
	deleted BOOLEAN, 
	actor_id INTEGER, 
	PRIMARY KEY (id)
);

CREATE INDEX ix_chat_channel_id ON chat_messages (channel, id);

CREATE INDEX ix_chat_messages_channel ON chat_messages (channel);

CREATE INDEX ix_chat_messages_created_at ON chat_messages (created_at);

CREATE TABLE chat_reads (
	user_id INTEGER NOT NULL, 
	channel VARCHAR(24) NOT NULL, 
	last_id INTEGER NOT NULL, 
	PRIMARY KEY (user_id, channel)
);

CREATE TABLE chat_files (
	id SERIAL NOT NULL, 
	channel VARCHAR(24) NOT NULL, 
	author_id INTEGER NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	mime VARCHAR(20) NOT NULL, 
	size INTEGER NOT NULL, 
	width INTEGER, 
	height INTEGER, 
	data BYTEA NOT NULL, 
	PRIMARY KEY (id)
);

CREATE INDEX ix_chat_files_channel ON chat_files (channel);

CREATE TABLE equipment (
	code VARCHAR(40) NOT NULL, 
	name VARCHAR(80) NOT NULL, 
	kind VARCHAR(40) NOT NULL, 
	area VARCHAR(16) NOT NULL, 
	critical BOOLEAN NOT NULL, 
	mtbf_h FLOAT, 
	in_model BOOLEAN NOT NULL, 
	PRIMARY KEY (code), 
	FOREIGN KEY(area) REFERENCES areas (code) ON UPDATE CASCADE
);

CREATE INDEX ix_equipment_area ON equipment (area);

CREATE TABLE production (
	id SERIAL NOT NULL, 
	day DATE NOT NULL, 
	shift INTEGER NOT NULL, 
	area VARCHAR(16) NOT NULL, 
	line VARCHAR(40) NOT NULL, 
	plan INTEGER NOT NULL, 
	fact INTEGER NOT NULL, 
	run_hours FLOAT NOT NULL, 
	load_pct FLOAT, 
	source VARCHAR(16) NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (day, shift, area), 
	CONSTRAINT ck_production_nonneg CHECK (plan >= 0 AND fact >= 0), 
	CONSTRAINT ck_production_hours CHECK (run_hours >= 0 AND run_hours <= 24), 
	CONSTRAINT ck_production_source CHECK (source IN ('customer', 'history', 'live', 'import')), 
	FOREIGN KEY(shift) REFERENCES shifts (number), 
	FOREIGN KEY(area) REFERENCES areas (code) ON UPDATE CASCADE
);

CREATE INDEX ix_production_day ON production (day);

CREATE INDEX ix_production_area ON production (area);

CREATE TABLE model_plan (
	id SERIAL NOT NULL, 
	month VARCHAR(7) NOT NULL, 
	model VARCHAR(60) NOT NULL, 
	plan INTEGER NOT NULL, 
	source VARCHAR(16) NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (month, model), 
	CONSTRAINT ck_model_plan_nonneg CHECK (plan >= 0), 
	FOREIGN KEY(model) REFERENCES car_models (name) ON UPDATE CASCADE
);

CREATE INDEX ix_model_plan_model ON model_plan (model);

CREATE TABLE model_output (
	id SERIAL NOT NULL, 
	day DATE NOT NULL, 
	model VARCHAR(60) NOT NULL, 
	qty INTEGER NOT NULL, 
	source VARCHAR(16) NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (day, model), 
	CONSTRAINT ck_model_output_nonneg CHECK (qty >= 0), 
	FOREIGN KEY(model) REFERENCES car_models (name) ON UPDATE CASCADE
);

CREATE INDEX ix_model_output_model ON model_output (model);

CREATE INDEX ix_model_output_day ON model_output (day);

CREATE TABLE quality (
	id SERIAL NOT NULL, 
	day DATE NOT NULL, 
	shift INTEGER NOT NULL, 
	area VARCHAR(16) NOT NULL, 
	produced INTEGER NOT NULL, 
	defects INTEGER NOT NULL, 
	source VARCHAR(16) NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (day, shift, area), 
	CONSTRAINT ck_quality_defects CHECK (produced >= 0 AND defects >= 0 AND defects <= produced), 
	CONSTRAINT ck_quality_source CHECK (source IN ('customer', 'history', 'live', 'import')), 
	FOREIGN KEY(shift) REFERENCES shifts (number), 
	FOREIGN KEY(area) REFERENCES areas (code) ON UPDATE CASCADE
);

CREATE INDEX ix_quality_day ON quality (day);

CREATE INDEX ix_quality_area ON quality (area);

CREATE TABLE users (
	id SERIAL NOT NULL, 
	name VARCHAR(80) NOT NULL, 
	position VARCHAR(80) NOT NULL, 
	role VARCHAR(16) NOT NULL, 
	area VARCHAR(16), 
	login VARCHAR(40), 
	pin_hash VARCHAR(200) NOT NULL, 
	pin_key VARCHAR(64), 
	active BOOLEAN NOT NULL, 
	failed_attempts INTEGER NOT NULL, 
	locked_until TIMESTAMP WITHOUT TIME ZONE, 
	last_login TIMESTAMP WITHOUT TIME ZONE, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	status VARCHAR(12), 
	request_note TEXT, 
	PRIMARY KEY (id), 
	CONSTRAINT ck_user_role CHECK (role IN ('admin', 'director', 'supervisor', 'worker')), 
	FOREIGN KEY(area) REFERENCES areas (code) ON UPDATE CASCADE
);

CREATE UNIQUE INDEX ix_users_pin_key ON users (pin_key);

CREATE UNIQUE INDEX ix_users_login ON users (login);

CREATE INDEX ix_users_role ON users (role);

CREATE INDEX ix_users_area ON users (area);

CREATE TABLE shift_sessions (
	id SERIAL NOT NULL, 
	day DATE NOT NULL, 
	shift INTEGER NOT NULL, 
	supervisor VARCHAR(80) NOT NULL, 
	started_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	closed_at TIMESTAMP WITHOUT TIME ZONE, 
	plan INTEGER NOT NULL, 
	staff INTEGER, 
	note TEXT NOT NULL, 
	summary JSON NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (day, shift), 
	FOREIGN KEY(shift) REFERENCES shifts (number)
);

CREATE INDEX ix_shift_sessions_day ON shift_sessions (day);

CREATE TABLE downtime (
	id SERIAL NOT NULL, 
	day DATE NOT NULL, 
	shift INTEGER NOT NULL, 
	area VARCHAR(16) NOT NULL, 
	equipment VARCHAR(40) NOT NULL, 
	reason VARCHAR(120) NOT NULL, 
	minutes FLOAT NOT NULL, 
	planned BOOLEAN NOT NULL, 
	started_at TIMESTAMP WITHOUT TIME ZONE, 
	source VARCHAR(16) NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT ck_downtime_minutes CHECK (minutes >= 0), 
	CONSTRAINT ck_downtime_source CHECK (source IN ('customer', 'history', 'live', 'import')), 
	FOREIGN KEY(shift) REFERENCES shifts (number), 
	FOREIGN KEY(area) REFERENCES areas (code) ON UPDATE CASCADE, 
	FOREIGN KEY(equipment) REFERENCES equipment (code) ON UPDATE CASCADE
);

CREATE INDEX ix_downtime_area ON downtime (area);

CREATE INDEX ix_downtime_day ON downtime (day);

CREATE INDEX ix_downtime_equipment ON downtime (equipment);

CREATE INDEX ix_downtime_equipment_day ON downtime (equipment, day);

CREATE TABLE incidents (
	id SERIAL NOT NULL, 
	created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL, 
	kind VARCHAR(24) NOT NULL, 
	severity VARCHAR(12) NOT NULL, 
	area VARCHAR(16), 
	equipment VARCHAR(40), 
	title VARCHAR(200) NOT NULL, 
	details TEXT NOT NULL, 
	status VARCHAR(12) NOT NULL, 
	acked_by VARCHAR(60), 
	resolved_at TIMESTAMP WITHOUT TIME ZONE, 
	downtime_min FLOAT, 
	cost_kzt INTEGER, 
	source VARCHAR(12) NOT NULL, 
	reported_by VARCHAR(80), 
	line_stopped BOOLEAN NOT NULL, 
	resolved_by VARCHAR(80), 
	resolution TEXT, 
	reporter_id INTEGER, 
	urgency VARCHAR(12), 
	reasons JSON, 
	photo_id INTEGER, 
	est_minutes FLOAT, 
	acked_at TIMESTAMP WITHOUT TIME ZONE, 
	comments JSON, 
	PRIMARY KEY (id), 
	CONSTRAINT ck_incident_severity CHECK (severity IN ('critical', 'warning', 'info')), 
	CONSTRAINT ck_incident_status CHECK (status IN ('open', 'ack', 'resolved')), 
	FOREIGN KEY(area) REFERENCES areas (code) ON UPDATE CASCADE, 
	FOREIGN KEY(equipment) REFERENCES equipment (code) ON UPDATE CASCADE
);

CREATE INDEX ix_incidents_created_at ON incidents (created_at);

CREATE INDEX ix_incidents_equipment ON incidents (equipment);

CREATE INDEX ix_incidents_reporter_id ON incidents (reporter_id);

CREATE INDEX ix_incidents_area ON incidents (area);

CREATE INDEX ix_incidents_status ON incidents (status);

CREATE OR REPLACE VIEW public.v_shift_output AS
SELECT p.day, p.shift, a.name AS area, p.line, p.plan, p.fact,
               p.fact - p.plan AS deviation,
               ROUND(CAST(100.0 * p.fact / NULLIF(p.plan, 0) AS NUMERIC), 2) AS plan_pct,
               p.run_hours, p.load_pct, p.source
        FROM production p JOIN areas a ON a.code = p.area;

CREATE OR REPLACE VIEW public.v_quality AS
SELECT q.day, q.shift, a.name AS area, q.produced, q.defects,
               ROUND(CAST(100.0 * q.defects / NULLIF(q.produced, 0) AS NUMERIC), 2) AS defect_pct, q.source
        FROM quality q JOIN areas a ON a.code = q.area;

CREATE OR REPLACE VIEW public.v_downtime AS
SELECT d.day, d.shift, a.name AS area, d.equipment, e.name AS equipment_name,
               e.critical, d.reason, d.minutes, d.planned, d.source
        FROM downtime d
        JOIN areas a ON a.code = d.area
        JOIN equipment e ON e.code = d.equipment;

CREATE OR REPLACE VIEW public.v_daily_summary AS
SELECT p.day,
               SUM(p.plan) AS plan,
               SUM(p.fact) AS cars,
               (SELECT ROUND(CAST(100.0 * SUM(q.defects) / NULLIF(SUM(q.produced), 0) AS NUMERIC), 2)
                  FROM quality q WHERE q.day = p.day) AS defect_pct,
               (SELECT ROUND(CAST(COALESCE(SUM(d.minutes), 0) AS NUMERIC), 1)
                  FROM downtime d WHERE d.day = p.day AND NOT d.planned) AS unplanned_downtime_min
        FROM production p
        WHERE p.area = 'ASSY'
        GROUP BY p.day;

CREATE OR REPLACE VIEW public.v_equipment_downtime AS
SELECT e.code, e.name, a.name AS area, e.critical,
               COUNT(d.id) AS stops,
               ROUND(CAST(COALESCE(SUM(d.minutes), 0) AS NUMERIC), 1) AS minutes,
               MAX(d.day) AS last_stop
        FROM equipment e
        JOIN areas a ON a.code = e.area
        LEFT JOIN downtime d ON d.equipment = e.code AND NOT d.planned
        GROUP BY e.code, e.name, a.name, e.critical;

CREATE OR REPLACE VIEW public.v_model_plan AS
SELECT mp.month, mp.model, mp.plan,
               COALESCE((SELECT SUM(mo.qty) FROM model_output mo
                          WHERE mo.model = mp.model
                            AND SUBSTR(CAST(mo.day AS TEXT), 1, 7) = mp.month), 0) AS fact
        FROM model_plan mp;

DO $$
DECLARE
  relation_name text;
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', role_name);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', role_name);

      FOR relation_name IN
        SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', relation_name);
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', relation_name, role_name);
      END LOOP;

      FOR relation_name IN
        SELECT viewname FROM pg_views WHERE schemaname = 'public'
      LOOP
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', relation_name, role_name);
      END LOOP;
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', role_name);
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.can_read_chat_message(target_channel text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.users AS employee
    WHERE employee.id = CASE
      WHEN COALESCE(auth.jwt() -> 'app_metadata' ->> 'user_id', '') ~ '^[0-9]+$'
      THEN (auth.jwt() -> 'app_metadata' ->> 'user_id')::integer
      ELSE NULL
    END
    AND employee.active IS TRUE
    AND (employee.status IS NULL OR employee.status = 'active')
    AND (
      target_channel = 'all'
      OR target_channel ~ (
        '^dm:('
        || employee.id::text
        || '-[0-9]+|[0-9]+-'
        || employee.id::text
        || ')$'
      )
      OR (employee.role <> 'worker' AND target_channel !~ '^dm:')
      OR (employee.role = 'worker' AND target_channel = employee.area)
    )
  )
$function$;

REVOKE ALL ON FUNCTION public.can_read_chat_message(text) FROM PUBLIC;
DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.can_read_chat_message(text) FROM %I', role_name);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT ON public.chat_messages TO authenticated;
    GRANT EXECUTE ON FUNCTION public.can_read_chat_message(text) TO authenticated;
    ALTER TABLE public.chat_messages REPLICA IDENTITY FULL;
    DROP POLICY IF EXISTS chat_messages_select_all ON public.chat_messages;
    DROP POLICY IF EXISTS chat_messages_insert_all ON public.chat_messages;
    DROP POLICY IF EXISTS chat_messages_realtime_select ON public.chat_messages;
    CREATE POLICY chat_messages_realtime_select ON public.chat_messages
      FOR SELECT TO authenticated USING (public.can_read_chat_message(channel));
  END IF;

  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime')
     AND NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
       WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'chat_messages'
     ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.chat_messages;
  ELSIF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RAISE EXCEPTION 'Supabase Realtime publication is missing';
  END IF;
END $$;

COMMIT;
