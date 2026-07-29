// Central Zod schemas. Every API boundary parses input with these.
import { z } from "zod";

// Governance classification flag for a minute. Mirrors the Prisma MinuteFlag
// enum. "" / undefined = unflagged (stored as null).
export const MINUTE_FLAGS = ["Governance", "Decision", "Scope"] as const;
export const MinuteFlagSchema = z.enum(MINUTE_FLAGS);
export type MinuteFlagValue = z.infer<typeof MinuteFlagSchema>;

export const CreateProjectSchema = z.object({
  name: z.string().min(1).max(200)
});

export const CreateMeetingSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1).max(200),
  meetingDate: z.string().datetime(),
  attendee: z.string().max(500).optional(),
  parentMeetingIdRaw: z.string().nullable().optional()
});

export const CreateMinuteSchema = z.object({
  meetingId: z.string().uuid(),
  area: z.string().default("General"),
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  type: z.enum(["Note", "To-Do", "Action", "Devops"]).default("Note"),
  status: z.enum(["New", "Initiated", "In Progress", "Completed", "Cancelled"]).default("New"),
  flag: MinuteFlagSchema.nullable().optional(),
  parentMinuteId: z.string().uuid().nullable().optional(),
  isPersistent: z.boolean().default(false),
  assignedToUserId: z.string().uuid().nullable().optional(),
  dueDate: z.string().datetime().nullable().optional()
});

export type CreateProject = z.infer<typeof CreateProjectSchema>;
export type CreateMeeting = z.infer<typeof CreateMeetingSchema>;
export type CreateMinute  = z.infer<typeof CreateMinuteSchema>;
