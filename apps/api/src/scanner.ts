export interface ScanResult {
  clean: boolean
  engine: string
  signature?: string
}

export interface FileScanner {
  scan(filePath: string): Promise<ScanResult>
}

/**
 * The MVP keeps the scanning boundary explicit without requiring ClamAV on a
 * developer laptop. A production deployment can replace this with a scanner
 * that writes the upload to a quarantine path and invokes clamdscan.
 */
export class NoopFileScanner implements FileScanner {
  async scan() { return { clean: true, engine: 'noop' } }
}
