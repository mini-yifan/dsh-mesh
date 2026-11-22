import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { mkdir, open, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import type { RemoteClientCore } from '@dsh-remote/client-core'
import type { RemoteTypertGateway } from 'ds-harness-remote/internal'
import { z } from 'zod'

/** Where a remote worker stages files for the device that started the task. */
export const RETURN_DIR = '.mesh-out'
/** Where the starting device places files returned by the remote worker. */
export const RECEIVE_DIR = '.mesh-in'

/** The relay upload budget used by `workspace.upload.*`. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024
/** The scoped file carrier download budget used by `workspaceFiles/readBytes`. */
export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024

const UPLOAD_CHUNK = 64 * 1024
const DOWNLOAD_CHUNK = 256 * 1024

const statSchema = z.object({
  absolutePath: z.string().min(1),
  version: z.string().min(1),
  bytes: z.number().int().min(0).max(MAX_DOWNLOAD_BYTES),
})
const chunkSchema = statSchema.extend({
  offset: z.number().int().min(0),
  data: z.instanceof(Uint8Array),
  eof: z.boolean(),
})

export interface UploadedFile {
  name: string
  path: string
  bytes: number
}

export interface RemoteFileEntry {
  name: string
  type: 'file' | 'directory' | 'other'
  size?: number
}

type UploadClient = Pick<RemoteClientCore, 'rpc'> & Partial<Pick<RemoteClientCore, 'getStats'>>

/**
 * Upload one local file into the workspace owned by `sessionId`. The Host
 * publishes the file atomically at the workspace root, which is the only
 * location its scoped uploader permits.
 */
export async function uploadWorkspaceFile(
  client: UploadClient,
  sessionId: string,
  localPath: string,
  name: string,
  signal: AbortSignal,
): Promise<UploadedFile> {
  const uploadId = randomUUID()
  const scope = { sessionId, uploadId }
  let file
  try {
    file = await open(localPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    const before = await file.stat()
    if (!before.isFile()) throw new Error('attachment_not_a_file')
    if (before.size > MAX_UPLOAD_BYTES) throw new Error('attachment_too_large')
    await client.rpc('workspace.upload.open', { ...scope, name, totalBytes: before.size }, signal)
    let offset = 0
    while (offset < before.size) {
      signal.throwIfAborted()
      const buffer = Buffer.alloc(Math.min(UPLOAD_CHUNK, before.size - offset))
      const read = await file.read(buffer, 0, buffer.length, offset)
      if (read.bytesRead === 0) throw new Error('attachment_changed')
      await client.rpc('workspace.upload.chunk', {
        ...scope,
        offset,
        data: buffer.subarray(0, read.bytesRead).toString('base64'),
      }, signal)
      offset += read.bytesRead
    }
    const after = await file.stat()
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error('attachment_changed')
    }
    signal.throwIfAborted()
    return await client.rpc('workspace.upload.commit', scope, signal) as UploadedFile
  } catch (error) {
    await client.rpc('workspace.upload.abort', scope, AbortSignal.timeout(5_000)).catch(() => undefined)
    throw error
  } finally {
    await file?.close().catch(() => undefined)
  }
}

/** List files in a Session-scoped workspace directory. */
export async function listWorkspaceFiles(
  gateway: RemoteTypertGateway,
  sessionId: string,
  path: string,
  signal: AbortSignal,
): Promise<RemoteFileEntry[]> {
  const value = await gateway.invoke({
    namespace: 'workspaceFiles',
    method: 'list',
    args: { workspaceFileScopeId: sessionId, path },
    signal,
  }) as { entries?: unknown }
  const entries = Array.isArray(value?.entries) ? value.entries : []
  return entries.flatMap(entry => {
    if (entry === null || typeof entry !== 'object') return []
    const item = entry as Record<string, unknown>
    if (typeof item.name !== 'string') return []
    const type = item.type === 'directory' ? 'directory' : item.type === 'file' ? 'file' : 'other'
    return [{
      name: item.name,
      type,
      ...(typeof item.size === 'number' ? { size: item.size } : {}),
    }]
  })
}

/**
 * Download one Session-scoped workspace file into an exact local path. The
 * local path must not exist yet; callers retry with a suffix on `EEXIST`.
 */
export async function downloadWorkspaceFile(
  gateway: RemoteTypertGateway,
  sessionId: string,
  remotePath: string,
  localPath: string,
  signal: AbortSignal,
): Promise<{ bytes: number }> {
  const call = async (method: string, extra: Record<string, unknown> = {}) => {
    signal.throwIfAborted()
    const result = await gateway.invoke({
      namespace: 'workspaceFiles',
      method,
      args: { workspaceFileScopeId: sessionId, path: remotePath, ...extra },
      signal,
    })
    signal.throwIfAborted()
    return result
  }
  const before = statSchema.parse(await call('stat'))
  await mkdir(dirname(localPath), { recursive: true, mode: 0o700 })
  const file = await open(localPath, 'wx', 0o600)
  try {
    let offset = 0
    for (;;) {
      const length = Math.min(DOWNLOAD_CHUNK, Math.max(1, before.bytes - offset))
      const chunk = chunkSchema.parse(await call('readBytes', { range: { offset, length } }))
      if (chunk.absolutePath !== before.absolutePath || chunk.version !== before.version || chunk.bytes !== before.bytes
        || chunk.offset !== offset || chunk.data.length > length || offset + chunk.data.length > before.bytes
        || (chunk.eof ? offset + chunk.data.length !== before.bytes : chunk.data.length === 0)) {
        throw new Error('remote_file_changed_or_invalid_chunk')
      }
      await file.writeFile(chunk.data)
      offset += chunk.data.length
      if (chunk.eof) break
    }
    const after = statSchema.parse(await call('stat'))
    if (after.absolutePath !== before.absolutePath || after.version !== before.version || after.bytes !== before.bytes) {
      throw new Error('remote_file_changed')
    }
    return { bytes: before.bytes }
  } catch (error) {
    await file.close().catch(() => undefined)
    await rm(localPath, { force: true })
    throw error
  } finally {
    await file.close().catch(() => undefined)
  }
}

/** Make a remote-provided label safe on both macOS and Windows. */
export function safeFileName(value: string, fallback = 'file'): string {
  const leaf = value.replaceAll('\\', '/').split('/').at(-1) ?? value
  const base = leaf.replace(/[/\\\x00-\x1f\x7f<>:"|?*]/gu, '_').replace(/[. ]+$/gu, '')
  return base === '' || base === '.' || base === '..' ? fallback : base.slice(0, 180)
}

/** Prefix an uploaded file with the task identity so concurrent tasks do not collide. */
export function uploadFileName(taskId: string, index: number, original: string): string {
  const prefix = `mesh-in-${taskId.slice(0, 8)}-${index + 1}-`
  const base = safeFileName(original)
  let suffix = base
  while (Buffer.byteLength(prefix + suffix, 'utf8') > 220 && suffix.length > 0) suffix = suffix.slice(0, -1)
  return prefix + (suffix === '' ? 'file' : suffix)
}

/** Add a numeric suffix before the extension. */
export function suffixedName(name: string, index: number): string {
  if (index === 0) return name
  const dot = name.lastIndexOf('.')
  return dot > 0 ? `${name.slice(0, dot)} (${index})${name.slice(dot)}` : `${name} (${index})`
}

/** Download into a directory, choosing a non-conflicting local name. */
export async function downloadUnique(
  gateway: RemoteTypertGateway,
  sessionId: string,
  remotePath: string,
  directory: string,
  name: string,
  signal: AbortSignal,
): Promise<{ localPath: string; bytes: number }> {
  const safe = safeFileName(name)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  for (let index = 0; index < 10_000; index += 1) {
    const localPath = join(directory, suffixedName(safe, index))
    try {
      return { localPath, ...(await downloadWorkspaceFile(gateway, sessionId, remotePath, localPath, signal)) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new Error('file_name_conflict')
}