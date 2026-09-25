import { z } from 'zod';
import { enumField, stringField } from './common.js';

export const LOG_LEVELS = ['INFO', 'WARN', 'ERROR'];

export const createLogSchema = z.strictObject({
  level: enumField('Log level', LOG_LEVELS),
  // Kept verbatim (no trimming) so indentation in build output survives.
  message: stringField('Log message')
    .refine((message) => message.trim().length > 0, { error: 'Log message must not be empty' })
    .refine((message) => message.length <= 10000, { error: 'Log message must be at most 10000 characters' }),
});
