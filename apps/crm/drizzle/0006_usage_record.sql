CREATE TABLE "usage_record" (
	"id" text PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"kind" text DEFAULT 'chat' NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"wa_jid" text,
	"ts" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "usage_ts_idx" ON "usage_record" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "usage_model_ts_idx" ON "usage_record" USING btree ("model","ts");