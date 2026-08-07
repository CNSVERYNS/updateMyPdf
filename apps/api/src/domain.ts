export const JOB_STATES = [
  'received',
  'validating',
  'uploaded',
  'submitted',
  'translating',
  'downloading',
  'quality_check',
  'completed',
  'completed_with_warnings',
  'failed',
  'expired',
  'deleted',
] as const

export type JobStatus = typeof JOB_STATES[number]

export const TERMINAL_STATES = new Set<JobStatus>(['completed', 'completed_with_warnings', 'failed', 'expired', 'deleted'])

const transitions: Record<JobStatus, Set<JobStatus>> = {
  received: new Set(['validating', 'failed', 'expired', 'deleted']),
  validating: new Set(['uploaded', 'failed', 'expired', 'deleted']),
  uploaded: new Set(['submitted', 'failed', 'expired', 'deleted']),
  submitted: new Set(['translating', 'downloading', 'failed', 'expired', 'deleted']),
  translating: new Set(['downloading', 'failed', 'expired', 'deleted']),
  downloading: new Set(['quality_check', 'failed', 'expired', 'deleted']),
  quality_check: new Set(['completed', 'completed_with_warnings', 'failed', 'expired', 'deleted']),
  completed: new Set(['expired', 'deleted']),
  completed_with_warnings: new Set(['expired', 'deleted']),
  failed: new Set(['deleted', 'expired']),
  expired: new Set(['deleted']),
  deleted: new Set(),
}

export const canTransition = (from: JobStatus, to: JobStatus) => transitions[from]?.has(to) ?? false

export const assertTransition = (from: JobStatus, to: JobStatus) => {
  if (!canTransition(from, to)) throw new Error(`Invalid job state transition: ${from} -> ${to}`)
}

export interface TranslationJob {
  id: string
  originalFileName: string
  sanitizedFileName: string
  sourceMimeType: string
  sourceExtension: string
  sourceLanguage: string | null
  targetLanguage: string
  translationMode: 'sync' | 'batch' | 'preserve_pdf' | null
  status: JobStatus
  progress: number
  currentStage: string
  sourceBlobName: string | null
  targetBlobName: string | null
  azureOperationId: string | null
  azureOperationUrl: string | null
  sourceSizeBytes: number
  resultSizeBytes: number | null
  sourcePageCount: number | null
  resultPageCount: number | null
  qualityScore: number | null
  qualityWarnings: unknown[]
  qualityReport: Record<string, unknown> | null
  errorCode: string | null
  errorMessage: string | null
  errorDetails: Record<string, unknown> | null
  expiresAt: string
  createdAt: string
  updatedAt: string
  completedAt: string | null
}

export interface JobEvent {
  id: string
  jobId: string
  previousStatus: JobStatus | null
  newStatus: JobStatus
  eventType: string
  message: string
  metadata: Record<string, unknown>
  createdAt: string
}
