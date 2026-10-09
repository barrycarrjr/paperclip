CREATE TABLE "channel_user_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plugin_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"external_workspace" text DEFAULT '' NOT NULL,
	"external_user_id" text NOT NULL,
	"external_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "channel_user_links" ADD CONSTRAINT "channel_user_links_plugin_id_plugins_id_fk" FOREIGN KEY ("plugin_id") REFERENCES "public"."plugins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channel_user_links" ADD CONSTRAINT "channel_user_links_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "channel_user_links_identity_idx" ON "channel_user_links" USING btree ("plugin_id","external_workspace","external_user_id");--> statement-breakpoint
CREATE INDEX "channel_user_links_user_idx" ON "channel_user_links" USING btree ("user_id");