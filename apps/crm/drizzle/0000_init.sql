CREATE TABLE "contact" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"email" text,
	"company" text,
	"notes" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"archived_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lead" (
	"id" text PRIMARY KEY NOT NULL,
	"contact_id" text NOT NULL,
	"stage_id" text NOT NULL,
	"title" text,
	"value_cents" integer,
	"position" integer DEFAULT 0 NOT NULL,
	"last_activity_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pipeline_stage" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"kind" text DEFAULT 'open' NOT NULL,
	"color" text DEFAULT 'slate' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lead" ADD CONSTRAINT "lead_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead" ADD CONSTRAINT "lead_stage_id_pipeline_stage_id_fk" FOREIGN KEY ("stage_id") REFERENCES "public"."pipeline_stage"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_phone_uq" ON "contact" USING btree ("phone") WHERE "contact"."phone" is not null;--> statement-breakpoint
CREATE INDEX "contact_name_idx" ON "contact" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "lead_contact_uq" ON "lead" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "lead_stage_position_idx" ON "lead" USING btree ("stage_id","position");--> statement-breakpoint
CREATE INDEX "stage_position_idx" ON "pipeline_stage" USING btree ("position");