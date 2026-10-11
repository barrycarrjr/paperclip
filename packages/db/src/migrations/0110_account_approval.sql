-- New accounts wait for an instance admin's approval.
--
-- `approval_status` is 'pending' for an account nobody has decided on yet,
-- 'approved' once an instance admin lets it in, and 'declined' when one
-- refuses it. A waiting account can sign in but sees only a waiting screen;
-- the server refuses it everywhere else. See
-- server/src/services/account-approvals.ts.
--
-- Every account that exists when this runs is approved, and that is done by
-- adding the column with 'approved' as its default: the rows already there
-- take the default they were added with. Only then does the default become
-- 'pending', for accounts made from now on. Not an UPDATE, so that running
-- this file again (which happens when a migration's history row goes missing)
-- cannot approve an account that is waiting, or one that was declined.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "approval_status" text DEFAULT 'approved' NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "approval_status" SET DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "approval_decided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "approval_decided_by_user_id" text;
