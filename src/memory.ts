import { z } from "zod/v4";

export const MiB = 1024 * 1024;
export const MEMORY_DEFAULTS = {
  code_mode_high_water_mib: 4096,
  idle_retention_hours: 72,
  terminal_buffer_mib: 16,
} as const;
export const MEMORY_SCHEMA = z
  .object({
    code_mode_high_water_mib: z
      .number()
      .int()
      .positive()
      .max(Math.floor(Number.MAX_SAFE_INTEGER / MiB))
      .default(MEMORY_DEFAULTS.code_mode_high_water_mib),
    idle_retention_hours: z
      .number()
      .int()
      .positive()
      .max(Math.floor(Number.MAX_SAFE_INTEGER / 3_600_000))
      .default(MEMORY_DEFAULTS.idle_retention_hours),
    terminal_buffer_mib: z
      .number()
      .int()
      .positive()
      .max(Math.floor(Number.MAX_SAFE_INTEGER / MiB))
      .default(MEMORY_DEFAULTS.terminal_buffer_mib),
  })
  .strict();
export type MemoryConfig = z.infer<typeof MEMORY_SCHEMA>;
export const DEFAULT_IDLE_MS = MEMORY_DEFAULTS.idle_retention_hours * 3_600_000;
