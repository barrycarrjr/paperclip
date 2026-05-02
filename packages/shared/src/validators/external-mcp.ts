import { z } from "zod";
import { EXTERNAL_MCP_TRANSPORTS, PORTFOLIO_WIDE_COMPANY_TOKEN } from "../types/external-mcp.js";
import { envBindingSchema } from "./secret.js";

const slugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "key must be lowercase letters/digits with - or _ separators");

const envVarNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "env var name must match POSIX identifier rules");

const headerNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/, "invalid HTTP header name");

const envBindingsRecordSchema = z
  .record(envBindingSchema)
  .refine(
    (rec) => Object.keys(rec).every((k) => envVarNameSchema.safeParse(k).success),
    "one or more env var names are invalid",
  );

const headerBindingsRecordSchema = z
  .record(envBindingSchema)
  .refine(
    (rec) => Object.keys(rec).every((k) => headerNameSchema.safeParse(k).success),
    "one or more header names are invalid",
  );

const allowedCompaniesSchema = z
  .array(z.union([z.literal(PORTFOLIO_WIDE_COMPANY_TOKEN), z.string().uuid()]))
  .max(128);

const baseSchema = z.object({
  key: slugSchema,
  displayName: z.string().min(1).max(120),
  description: z.string().max(2000).optional().nullable(),
  transport: z.enum(EXTERNAL_MCP_TRANSPORTS),
  command: z.string().max(512).optional().nullable(),
  args: z.array(z.string().max(2048)).max(64).optional().nullable(),
  url: z.string().url().max(2048).optional().nullable(),
  envBindings: envBindingsRecordSchema.default({}),
  headerBindings: headerBindingsRecordSchema.default({}),
  allowedCompanies: allowedCompaniesSchema.default([]),
  allowMutations: z.boolean().default(false),
  writeAllowList: z.array(z.string().min(1).max(128)).max(128).default([]),
  toolAllowList: z.array(z.string().min(1).max(128)).max(256).default([]),
  toolDenyList: z.array(z.string().min(1).max(128)).max(256).default([]),
});

function transportInvariants<T extends { transport: string; command?: string | null; args?: string[] | null; url?: string | null }>(
  data: T,
  ctx: z.RefinementCtx,
): void {
  if (data.transport === "stdio") {
    if (!data.command || data.command.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["command"],
        message: "command is required for stdio transport",
      });
    }
    if (data.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["url"],
        message: "url must be empty for stdio transport",
      });
    }
  } else {
    if (!data.url || data.url.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["url"],
        message: "url is required for http/sse transport",
      });
    }
    if (data.command) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["command"],
        message: "command must be empty for http/sse transport",
      });
    }
  }
}

export const createExternalMcpServerSchema = baseSchema.superRefine(transportInvariants);
export type CreateExternalMcpServer = z.infer<typeof createExternalMcpServerSchema>;

export const updateExternalMcpServerSchema = baseSchema.partial().superRefine(
  (data, ctx) => {
    if (data.transport !== undefined) {
      transportInvariants(
        {
          transport: data.transport,
          command: data.command ?? null,
          args: data.args ?? null,
          url: data.url ?? null,
        },
        ctx,
      );
    }
  },
);
export type UpdateExternalMcpServer = z.infer<typeof updateExternalMcpServerSchema>;
