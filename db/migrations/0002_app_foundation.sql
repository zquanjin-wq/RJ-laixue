CREATE SCHEMA app;
CREATE SCHEMA runtime;

CREATE TABLE app.user_profiles (
  user_id text PRIMARY KEY REFERENCES public."user"(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('admin', 'teacher', 'learner')),
  display_name text NOT NULL,
  employee_no text,
  department text,
  must_change_password boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX user_profiles_employee_no_uidx
  ON app.user_profiles (lower(employee_no))
  WHERE employee_no IS NOT NULL;
