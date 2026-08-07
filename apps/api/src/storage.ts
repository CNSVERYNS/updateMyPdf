import fs from 'node:fs/promises'
import path from 'node:path'
import { DefaultAzureCredential } from '@azure/identity'
import { BlobServiceClient, BlobSASPermissions, ContainerSASPermissions, SASProtocol, StorageSharedKeyCredential, generateBlobSASQueryParameters } from '@azure/storage-blob'
import type { AppConfig } from './config.js'

export interface StorageAdapter {
  readonly kind: 'azure' | 'local'
  upload(container: string, blobName: string, bytes: Buffer, contentType: string): Promise<void>
  download(container: string, blobName: string): Promise<Buffer>
  delete(container: string, blobName: string): Promise<void>
  createReadSas(container: string, blobName: string, expiresInMinutes: number): Promise<string>
  createTargetSas(container: string, blobName: string, expiresInMinutes: number): Promise<string>
  publicBlobUrl(container: string, blobName: string): string
}

const encodeBlob = (name: string) => name.split('/').map(encodeURIComponent).join('/')

class LocalStorage implements StorageAdapter {
  readonly kind = 'local' as const
  constructor(private readonly root: string) {}

  private file(container: string, blobName: string) {
    const root = path.resolve(this.root)
    const target = path.resolve(root, container, blobName)
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Invalid storage path')
    return target
  }

  async upload(container: string, blobName: string, bytes: Buffer) {
    const file = this.file(container, blobName)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, bytes)
  }

  download(container: string, blobName: string) { return fs.readFile(this.file(container, blobName)) }
  async delete(container: string, blobName: string) { await fs.rm(this.file(container, blobName), { force: true }) }
  async createReadSas(container: string, blobName: string) { return this.publicBlobUrl(container, blobName) }
  async createTargetSas(container: string, blobName: string) { return this.publicBlobUrl(container, blobName) }
  publicBlobUrl(container: string, blobName: string) { return `local://${encodeURIComponent(container)}/${encodeBlob(blobName)}` }
}

class AzureBlobStorage implements StorageAdapter {
  readonly kind = 'azure' as const
  private readonly service: BlobServiceClient
  private readonly accountName: string
  private readonly keyCredential?: StorageSharedKeyCredential

  constructor(private readonly config: AppConfig) {
    this.accountName = config.AZURE_STORAGE_ACCOUNT_NAME || ''
    const connection = config.AZURE_STORAGE_CONNECTION_STRING
    if (connection) {
      this.service = BlobServiceClient.fromConnectionString(connection)
      const accountNameMatch = connection.match(/AccountName=([^;]+)/i)
      const accountKeyMatch = connection.match(/AccountKey=([^;]+)/i)
      if (accountNameMatch?.[1] && accountKeyMatch?.[1]) this.keyCredential = new StorageSharedKeyCredential(accountNameMatch[1], accountKeyMatch[1])
    } else {
      if (!this.accountName) throw new Error('AZURE_STORAGE_ACCOUNT_NAME is required for Entra ID storage mode')
      this.service = new BlobServiceClient(`https://${this.accountName}.blob.core.windows.net`, new DefaultAzureCredential())
    }
  }

  private blob(container: string, blobName: string) { return this.service.getContainerClient(container).getBlockBlobClient(blobName) }
  async upload(container: string, blobName: string, bytes: Buffer, contentType: string) {
    const client = this.blob(container, blobName)
    await client.uploadData(bytes, { blobHTTPHeaders: { blobContentType: contentType } })
  }
  async download(container: string, blobName: string) { return Buffer.from(await this.blob(container, blobName).downloadToBuffer()) }
  async delete(container: string, blobName: string) { await this.blob(container, blobName).deleteIfExists() }

  private async delegationKey(startsOn: Date, expiresOn: Date) {
    if (this.keyCredential) return this.keyCredential
    return this.service.getUserDelegationKey(startsOn, expiresOn)
  }

  private async sas(container: string, blobName: string, expiresInMinutes: number, mode: 'read' | 'target') {
    const startsOn = new Date(Date.now() - 60_000)
    const expiresOn = new Date(Date.now() + expiresInMinutes * 60_000)
    const credential = await this.delegationKey(startsOn, expiresOn)
    if (credential instanceof StorageSharedKeyCredential) {
      if (mode === 'read') {
        const token = generateBlobSASQueryParameters({ containerName: container, blobName, permissions: BlobSASPermissions.parse('r'), startsOn, expiresOn, protocol: SASProtocol.Https }, credential).toString()
        return `${this.blob(container, blobName).url}?${token}`
      }
      // Azure batch translation discovers the output name inside the target
      // container, so the target SAS is container-scoped with create/write/list.
      const token = generateBlobSASQueryParameters({ containerName: container, permissions: ContainerSASPermissions.parse('racwl'), startsOn, expiresOn, protocol: SASProtocol.Https }, credential).toString()
      return `${this.service.getContainerClient(container).url}/${encodeBlob(blobName)}?${token}`
    }
    if (mode === 'read') {
      const token = generateBlobSASQueryParameters({ containerName: container, blobName, permissions: BlobSASPermissions.parse('r'), startsOn, expiresOn, protocol: SASProtocol.Https }, credential, this.accountName).toString()
      return `${this.blob(container, blobName).url}?${token}`
    }
    const token = generateBlobSASQueryParameters({ containerName: container, permissions: ContainerSASPermissions.parse('racwl'), startsOn, expiresOn, protocol: SASProtocol.Https }, credential, this.accountName).toString()
    return `${this.service.getContainerClient(container).url}/${encodeBlob(blobName)}?${token}`
  }

  createReadSas(container: string, blobName: string, expiresInMinutes: number) { return this.sas(container, blobName, expiresInMinutes, 'read') }
  createTargetSas(container: string, blobName: string, expiresInMinutes: number) { return this.sas(container, blobName, expiresInMinutes, 'target') }
  publicBlobUrl(container: string, blobName: string) { return this.blob(container, blobName).url }
}

export const createStorage = (appConfig: AppConfig): StorageAdapter => {
  if (appConfig.TRANSLATION_MOCK || (!appConfig.AZURE_STORAGE_ACCOUNT_NAME && !appConfig.AZURE_STORAGE_CONNECTION_STRING)) return new LocalStorage(appConfig.STORAGE_ROOT)
  return new AzureBlobStorage(appConfig)
}
