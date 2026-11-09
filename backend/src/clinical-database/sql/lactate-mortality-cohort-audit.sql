\set ON_ERROR_STOP on
\pset tuples_only on
\pset format unaligned

BEGIN READ ONLY;
SET LOCAL statement_timeout = '180s';

WITH ranked_admissions AS (
  SELECT
    icu.subject_id,
    icu.hadm_id,
    icu.stay_id,
    icu.intime,
    admission.hospital_expire_flag,
    patient.anchor_age
      + EXTRACT(YEAR FROM icu.intime)::integer
      - patient.anchor_year AS age_years,
    ROW_NUMBER() OVER (
      PARTITION BY icu.subject_id
      ORDER BY icu.intime, icu.stay_id
    ) AS admission_rank
  FROM mimiciv_icu.icustays AS icu
  INNER JOIN mimiciv_hosp.admissions AS admission
    USING (subject_id, hadm_id)
  INNER JOIN mimiciv_hosp.patients AS patient
    USING (subject_id)
),
eligible_admissions AS (
  SELECT *
  FROM ranked_admissions
  WHERE admission_rank = 1
    AND age_years >= 18
)
SELECT JSON_BUILD_OBJECT(
  'schema_version', '1.0.0',
  'study', 'adult_first_icu_lactate_mortality',
  'eligible_first_admissions', COUNT(*),
  'complete_lactate', COUNT(*) FILTER (
    WHERE lactate.max_lactate_first_6h IS NOT NULL
  ),
  'missing_lactate', COUNT(*) FILTER (
    WHERE lactate.max_lactate_first_6h IS NULL
  ),
  'excluded_measurements', SUM(lactate.excluded_measurements),
  'eligible_deaths', COUNT(*) FILTER (
    WHERE eligible.hospital_expire_flag = 1
  ),
  'complete_case_deaths', COUNT(*) FILTER (
    WHERE lactate.max_lactate_first_6h IS NOT NULL
      AND eligible.hospital_expire_flag = 1
  ),
  'exposed', COUNT(*) FILTER (
    WHERE lactate.max_lactate_first_6h > 2
  ),
  'exposed_deaths', COUNT(*) FILTER (
    WHERE lactate.max_lactate_first_6h > 2
      AND eligible.hospital_expire_flag = 1
  ),
  'unexposed', COUNT(*) FILTER (
    WHERE lactate.max_lactate_first_6h <= 2
  ),
  'unexposed_deaths', COUNT(*) FILTER (
    WHERE lactate.max_lactate_first_6h <= 2
      AND eligible.hospital_expire_flag = 1
  )
)::text
FROM eligible_admissions AS eligible
LEFT JOIN LATERAL (
  SELECT
    MAX(lab.valuenum::double precision) FILTER (
      WHERE lab.valuenum > 0 AND lab.valuenum <= 30
    ) AS max_lactate_first_6h,
    COUNT(*) FILTER (
      WHERE lab.valuenum <= 0 OR lab.valuenum > 30
    ) AS excluded_measurements
  FROM mimiciv_hosp.labevents AS lab
  WHERE lab.subject_id = eligible.subject_id
    AND lab.hadm_id = eligible.hadm_id
    AND lab.itemid IN (50813, 53154)
    AND lab.charttime >= eligible.intime
    AND lab.charttime < eligible.intime + INTERVAL '6 hours'
) AS lactate ON TRUE;

ROLLBACK;
