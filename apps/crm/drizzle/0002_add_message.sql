CREATE TABLE "message" (
	"id" text PRIMARY KEY NOT NULL,
	"contact_id" text NOT NULL,
	"wa_jid" text,
	"role" text NOT NULL,
	"text" text,
	"media_url" text,
	"media_type" text,
	"transcription" text,
	"wa_message_id" text,
	"ts" timestamp DEFAULT now() NOT NULL,
	"read_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "message" ADD CONSTRAINT "message_contact_id_contact_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "message_contact_ts_idx" ON "message" USING btree ("contact_id","ts");--> statement-breakpoint
CREATE UNIQUE INDEX "message_wamsgid_uq" ON "message" USING btree ("wa_message_id") WHERE "message"."wa_message_id" is not null;