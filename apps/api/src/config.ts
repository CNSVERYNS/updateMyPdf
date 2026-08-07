import path from 'node:path'
import { z } from 'zod'

const boolFromEnv = z.preprocess((value) => {
  if (value === undefined || value === '') return undefined
  return String(value).toLowerCase() === 'true'
}, z.boolean().optional())
const optionalString = z.preprocess((value) => {
  const normalized = String(value ?? '').trim()
  return normalized || undefined
}, z.string().optional())

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: optionalString,
  INTERNAL_API_SECRET: optionalString.pipe(z.string().min(16).optional()),
  DOWNLOAD_LINK_SECRET: optionalString.pipe(z.string().min(16).optional()),
  N8N_WEBHOOK_SECRET: optionalString.pipe(z.string().min(16).optional()),
  ADMIN_API_SECRET: optionalString.pipe(z.string().min(16).optional()),
  ADMIN_EMAILS: z.string().default(''),
  CORS_ORIGINS: z.string().default('http://localhost:3000,http://localhost:5173'),
  AZURE_TRANSLATOR_ENDPOINT: optionalString.pipe(z.string().url().optional()),
  AZURE_TRANSLATOR_KEY: optionalString,
  AZURE_TRANSLATOR_REGION: optionalString,
  AZURE_TRANSLATOR_API_VERSION: z.string().default('2026-03-01'),
  AZURE_STORAGE_ACCOUNT_NAME: optionalString,
  AZURE_STORAGE_CONNECTION_STRING: optionalString,
  AZURE_STORAGE_SOURCE_CONTAINER: z.string().default('translation-source'),
  AZURE_STORAGE_TARGET_CONTAINER: z.string().default('translation-target'),
  AZURE_STORAGE_QUARANTINE_CONTAINER: z.string().default('translation-quarantine'),
  AZURE_USE_ENTRA_ID: boolFromEnv.default(true),
  TRANSLATION_MOCK: boolFromEnv.default(true),
  SYNC_TRANSLATION_ENABLED: boolFromEnv.default(true),
  SYNC_MAX_FILE_SIZE_MB: z.coerce.number().positive().default(5),
  MAX_UPLOAD_SIZE_MB: z.coerce.number().positive().default(20),
  MAX_PDF_PAGES: z.coerce.number().int().positive().default(50),
  SOURCE_SAS_TTL_MINUTES: z.coerce.number().positive().default(30),
  TARGET_SAS_TTL_MINUTES: z.coerce.number().positive().default(60),
  DOWNLOAD_LINK_TTL_MINUTES: z.coerce.number().positive().default(15),
  FILE_RETENTION_HOURS: z.coerce.number().positive().default(24),
  AZURE_MAX_RETRIES: z.coerce.number().int().nonnegative().default(5),
  AZURE_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  AZURE_JOB_TIMEOUT_MINUTES: z.coerce.number().positive().default(30),
  PDF_QUALITY_SERVICE_URL: z.string().url().default('http://localhost:8000'),
  OPENAI_API_KEY: optionalString,
  OPENAI_MODEL: z.string().default('gpt-5.1'),
  AI_VISUAL_REVIEW_ENABLED: boolFromEnv.default(true),
  AI_VISUAL_REVIEW_MAX_PAGES: z.coerce.number().int().positive().default(12),
  QUALITY_PASS_SCORE: z.coerce.number().min(0).max(100).default(90),
  QUALITY_WARNING_SCORE: z.coerce.number().min(0).max(100).default(70),
  MIN_ACCEPTABLE_FONT_SIZE: z.coerce.number().positive().default(5),
  STORAGE_ROOT: z.string().default(path.resolve(process.cwd(), 'data', 'translation')),
})

export type AppConfig = z.infer<typeof envSchema>

export const loadConfig = (source: NodeJS.ProcessEnv = process.env): AppConfig => {
  const parsed = envSchema.safeParse(source)
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
    throw new Error(`Invalid translation API configuration: ${details}`)
  }
  return parsed.data
}

export const config = loadConfig()
