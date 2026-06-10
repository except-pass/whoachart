// Type declarations for the plain-ESM control-surface client (unit-tested from bun).
// Importing the module runs its top-level setup; tests set WHOACHART.autoboot=false first.
export function openModal(
  title: string,
  fields: any[],
  onSubmit: (values: Record<string, unknown>) => unknown,
): void
