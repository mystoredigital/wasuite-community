ALTER TABLE "contact" ADD COLUMN "wa_jid" text;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_wajid_uq" ON "contact" USING btree ("wa_jid") WHERE "contact"."wa_jid" is not null;