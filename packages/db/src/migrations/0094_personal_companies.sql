-- Personal companies: one per user, never shared, never deleted.
--
-- Every other company is a place people work together — you add members, you
-- give them roles, you scope what they can see. Personal is the opposite: it
-- belongs to exactly one person and nobody else can ever be let in, not by a
-- membership row, not by an invite, and not by being an administrator. If two
-- people use the same instance they each get their own, and neither can see
-- the other's.
--
-- It stays a row in `companies` rather than becoming a separate concept so
-- that everything already built — issues, agents, routines, the catalog —
-- works there unchanged. What makes it different is enforced by `kind` and
-- `owner_user_id` plus the access rules that read them.

ALTER TABLE "companies"
  ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'standard';

ALTER TABLE "companies"
  ADD COLUMN IF NOT EXISTS "owner_user_id" text;

-- A personal company must name its owner; anything else must not have one.
-- Enforced in the database because this is the whole basis of the isolation —
-- a personal row that lost its owner would be a company nobody can reach, and
-- a standard row that gained one would silently start hiding itself.
ALTER TABLE "companies"
  DROP CONSTRAINT IF EXISTS "companies_personal_owner_ck";
ALTER TABLE "companies"
  ADD CONSTRAINT "companies_personal_owner_ck" CHECK (
    (kind = 'personal' AND owner_user_id IS NOT NULL)
    OR (kind <> 'personal' AND owner_user_id IS NULL)
  );

-- One personal company per person. Without this a retried provision on a slow
-- first login would leave someone with two, and "your Personal" stops meaning
-- one thing.
CREATE UNIQUE INDEX IF NOT EXISTS "companies_personal_owner_uq"
  ON "companies" ("owner_user_id")
  WHERE "kind" = 'personal';

CREATE INDEX IF NOT EXISTS "companies_kind_idx" ON "companies" ("kind");

-- Existing hand-made "Personal" companies are adopted in application code
-- rather than here, on the owner's next sign-in. This migration knows about
-- companies and users but nothing that links them, so it cannot tell whose a
-- given Personal was meant to be; guessing would lock someone's work to the
-- wrong person. `ensurePersonalCompany` adopts one only when the person
-- signing in is its sole active member, and otherwise leaves it alone.
--
-- See server/src/services/personal-companies.ts.
