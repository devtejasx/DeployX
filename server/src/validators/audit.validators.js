import { z } from 'zod';

export const listAuditLogsQuery = z.strictObject({
  limit: z.coerce
    .number({ error: 'limit must be a number' })
    .int({ error: 'limit must be an integer between 1 and 200' })
    .min(1, { error: 'limit must be an integer between 1 and 200' })
    .max(200, { error: 'limit must be an integer between 1 and 200' })
    .default(50),
  before: z
    .string()
    .regex(/^[1-9][0-9]{0,18}$/, { error: 'before must be an audit entry id' })
    .optional(),
});
