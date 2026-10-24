CREATE TABLE "agent_config" (
	"id" text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"system_prompt" text DEFAULT '' NOT NULL,
	"knowledge_base" text DEFAULT '' NOT NULL,
	"ai_enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_config_singleton_ck" CHECK ("agent_config"."id" = 'singleton')
);
--> statement-breakpoint
CREATE TABLE "agent_kb" (
	"id" text PRIMARY KEY NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_lab_run" (
	"id" text PRIMARY KEY NOT NULL,
	"score" integer,
	"verdict" text,
	"detail" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wa_chat" (
	"wa_jid" text PRIMARY KEY NOT NULL,
	"contact_id" text,
	"is_group" boolean DEFAULT false NOT NULL,
	"group_name" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"mode" text DEFAULT 'ai' NOT NULL,
	"handoff_at" timestamp,
	"handoff_reason" text,
	"number_id" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wa_number" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"connection_state" text DEFAULT 'disconnected' NOT NULL,
	"last_connected_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message" ALTER COLUMN "contact_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wa_chat" ADD CONSTRAINT "wa_chat_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wa_chat" ADD CONSTRAINT "wa_chat_number_id_wa_number_id_fk" FOREIGN KEY ("number_id") REFERENCES "public"."wa_number"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_kb_position_idx" ON "agent_kb" USING btree ("position");--> statement-breakpoint
CREATE INDEX "agent_lab_run_created_idx" ON "agent_lab_run" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wa_chat_contact_uq" ON "wa_chat" USING btree ("contact_id") WHERE "wa_chat"."contact_id" is not null;--> statement-breakpoint
CREATE INDEX "wa_chat_updated_idx" ON "wa_chat" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "message_wajid_ts_idx" ON "message" USING btree ("wa_jid","ts");--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_owner_ck" CHECK ("message"."contact_id" is not null or "message"."wa_jid" is not null);