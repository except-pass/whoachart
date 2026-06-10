// src/forms.ts
import { z } from "zod"
import type { FormField } from "./types"

export const formFieldSchema: z.ZodType<FormField> = z
  .object({
    key: z.string(),
    type: z.enum(["text", "textarea", "number", "boolean", "enum"]),
    label: z.string().optional(),
    required: z.boolean().optional(),
    default: z.unknown().optional(),
    options: z.array(z.string()).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().optional(),
  })
  .superRefine((f, ctx) => {
    if (f.type === "enum" && (!f.options || f.options.length === 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "enum field requires options" })
    }
  })

export class FormError extends Error {
  constructor(public fields: Record<string, string>) {
    super(`form validation failed: ${Object.keys(fields).join(", ")}`)
  }
}

// Validate submitted values against a form. Applies defaults, coerces numbers
// and booleans from strings (curl ergonomics), throws FormError with
// per-field messages. The SERVER is the enforcement point — agents signaling
// an edge are held to the same schema as humans.
export function validateForm(form: FormField[], values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...values }
  const fields: Record<string, string> = {}
  for (const f of form) {
    const v = out[f.key]
    if (v === undefined || v === null || v === "") {
      if (f.default !== undefined) out[f.key] = f.default
      else if (f.required) fields[f.key] = "required"
      continue
    }
    switch (f.type) {
      case "number": {
        const n = typeof v === "number" ? v : Number(v)
        if (Number.isNaN(n)) { fields[f.key] = "must be a number"; break }
        if (f.min !== undefined && n < f.min) { fields[f.key] = `must be >= ${f.min}`; break }
        if (f.max !== undefined && n > f.max) { fields[f.key] = `must be <= ${f.max}`; break }
        out[f.key] = n
        break
      }
      case "boolean": {
        if (typeof v === "boolean") break
        if (v === "true") { out[f.key] = true; break }
        if (v === "false") { out[f.key] = false; break }
        fields[f.key] = "must be a boolean"
        break
      }
      case "enum": {
        if (!f.options!.includes(String(v))) fields[f.key] = `must be one of: ${f.options!.join(", ")}`
        break
      }
      case "text":
      case "textarea": {
        if (typeof v !== "string") fields[f.key] = "must be a string"
        break
      }
    }
  }
  if (Object.keys(fields).length > 0) throw new FormError(fields)
  return out
}
