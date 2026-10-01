WITH numbered AS (
  SELECT id, company_id,
    COALESCE((SELECT MAX(issue_number) FROM issues i2 WHERE i2.company_id = issues.company_id), 0)
    + ROW_NUMBER() OVER (PARTITION BY company_id ORDER BY created_at ASC) AS rn
  FROM issues
  WHERE issue_number IS NULL OR identifier IS NULL
)
UPDATE issues
SET issue_number = numbered.rn,
    identifier = (SELECT issue_prefix FROM companies WHERE companies.id = issues.company_id) || '-' || numbered.rn
FROM numbered
WHERE issues.id = numbered.id;

UPDATE companies
SET issue_counter = GREATEST(
  COALESCE(issue_counter, 0),
  COALESCE((SELECT MAX(issue_number) FROM issues WHERE issues.company_id = companies.id), 0)
);
