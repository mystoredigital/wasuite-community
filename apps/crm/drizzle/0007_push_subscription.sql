CREATE TABLE "push_subscription" (
	"id" text PRIMARY KEY NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"username" text,
	"user_agent" text,
	"failed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "push_endpoint_uq" ON "push_subscription" USING btree ("endpoint");