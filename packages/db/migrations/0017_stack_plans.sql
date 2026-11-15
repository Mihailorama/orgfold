CREATE TABLE "stack_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request" text NOT NULL,
	"status" text DEFAULT 'drafting' NOT NULL,
	"reply" text,
	"actions" jsonb,
	"stack_version" text NOT NULL,
	"ai_call_id" uuid,
	"created_by" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stack_plans_status" CHECK ("stack_plans"."status" in ('drafting','ready','failed','off','approved','applied'))
);
--> statement-breakpoint
ALTER TABLE "stack_plans" ADD CONSTRAINT "stack_plans_ai_call_id_ai_calls_id_fk" FOREIGN KEY ("ai_call_id") REFERENCES "public"."ai_calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stack_plans" ADD CONSTRAINT "stack_plans_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stack_plans" ADD CONSTRAINT "stack_plans_approved_by_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stack_plans_created_at_index" ON "stack_plans" USING btree ("created_at");