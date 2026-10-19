export function log(
  level: "info" | "warn" | "error",
  msg: string,
  fields: Record<string, unknown> = {},
): void {
  console.log(JSON.stringify({ level, msg, ...fields }));
}
