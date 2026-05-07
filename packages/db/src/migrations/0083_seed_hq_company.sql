-- Seed the singleton HQ portfolio-root company on installs that don't have one.
-- 0078 added `companies.is_portfolio_root` but did not insert a row; on Barry's
-- machine the existing "Portfolio Operations" company was hand-flipped to HQ
-- via one-off SQL. Fresh installs (e.g. Tony's) had no HQ row, so the sidebar
-- never showed the portfolio-root entry. This idempotent seed fixes that.

DO $$
DECLARE
  hq_exists boolean;
  chosen_prefix text := 'HQ';
  candidate text;
BEGIN
  SELECT EXISTS (SELECT 1 FROM companies WHERE is_portfolio_root = true) INTO hq_exists;
  IF hq_exists THEN
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM companies WHERE issue_prefix = chosen_prefix) THEN
    FOR i IN 0..25 LOOP
      candidate := 'HQ' || chr(65 + i);
      IF NOT EXISTS (SELECT 1 FROM companies WHERE issue_prefix = candidate) THEN
        chosen_prefix := candidate;
        EXIT;
      END IF;
    END LOOP;
  END IF;

  INSERT INTO companies (
    name,
    description,
    status,
    issue_prefix,
    is_portfolio_root,
    require_board_approval_for_new_agents
  ) VALUES (
    'HQ',
    'Portfolio root — cross-company holding view for the operating companies.',
    'active',
    chosen_prefix,
    true,
    true
  );
END $$;
