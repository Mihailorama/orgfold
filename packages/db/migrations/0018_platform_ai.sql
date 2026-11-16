CREATE TABLE "platform_ai" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"api_key" text,
	"api_key_hint" text,
	"connected_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform_ai" ADD CONSTRAINT "platform_ai_connected_by_user_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;