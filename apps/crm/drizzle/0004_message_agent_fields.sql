ALTER TABLE "message" ADD COLUMN "number_id" text;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "ghl_message_id" text;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "meta" jsonb;--> statement-breakpoint
CREATE INDEX "message_ghlmsgid_idx" ON "message" USING btree ("ghl_message_id") WHERE "message"."ghl_message_id" is not null;