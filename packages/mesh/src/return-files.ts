import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { constants } from 'node:fs'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { RETURN_DIR, safeFileName, suffixedName } from './files.js'

export const name = 'tool-mesh-return-files'
export const inject = ['tools']

export const MESH_RETURN_FILES = 'mesh_return_files'

const MAX_FILE_BYTES = 50 * 1024 * 1024

const DESCRIPTION = 'Stage local files for the device that started this background task. '
  + 'Call it before your final answer with every file the caller should receive. '
  + 'Files are copied into the workspace return directory and downloaded by the caller after this turn. '
  + 'Only use this for files produced for the caller; ordinary workspace edits do not need it.'

interface SessionLike {
  id?: string
  header?: { id?: string; cwd?: string }
}

/** Register the return-file tool in a preset that serves cross-device tasks. */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: MESH_RETURN_FILES,
    description: DESCRIPTION,
    parameters: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'Files to return, as absolute paths or paths relative to this session workspace.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          accepted: { type: 'boolean', required: true },
          reason: { type: 'string' },
          directory: { type: 'string' },
          files: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                name: { type: 'string' },
                path: { type: 'string' },
                bytes: { type: 'number' },
              },
            },
          },
          errors: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: true,
              properties: {
                path: { type: 'string' },
                reason: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.accepted
          ? `Staged ${value.files?.length ?? 0} file(s) for the caller in ${value.directory}.`
          : `No files staged: ${value.reason ?? 'unknown reason'}.`,
      }],
    },
    isConcurrencySafe: () => true,
    presentCall: args => ({ card: 'generic', title: 'Return files to caller', kind: 'execute', rawInput: { paths: args.paths } }),
    async execute(args, exec): Promise<any> {
      const session = (exec.agent as { session?: SessionLike } | undefined)?.session
      const sessionId = session?.header?.id ?? session?.id
      const cwd = session?.header?.cwd
      if (sessionId === undefined || cwd === undefined) {
        return { accepted: false, reason: 'no_session_workspace' }
      }
      const paths = [...new Set((args.paths ?? []).map(path => path.trim()).filter(Boolean))]
      if (paths.length === 0) return { accepted: false, reason: 'no_paths' }
      const directory = join(cwd, RETURN_DIR, sessionId)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const files: Array<{ name: string; path: string; bytes: number }> = []
      const errors: Array<{ path: string; reason: string }> = []
      for (const requested of paths) {
        try {
          const source = isAbsolute(requested) ? requested : resolve(cwd, requested)
          const info = await stat(source)
          if (!info.isFile()) throw new Error('not_a_file')
          if (info.size > MAX_FILE_BYTES) throw new Error('file_too_large')
          const wanted = safeFileName(basename(source))
          let target = join(directory, wanted)
          let index = 0
          for (;;) {
            if (resolve(source) === resolve(target)) break
            try {
              await copyFile(source, target, constants.COPYFILE_EXCL)
              break
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
              index += 1
              if (index >= 10_000) throw new Error('file_name_conflict')
              target = join(directory, suffixedName(wanted, index))
            }
          }
          files.push({
            name: basename(source),
            path: relative(cwd, target).replaceAll('\\', '/'),
            bytes: info.size,
          })
        } catch (error) {
          errors.push({ path: requested, reason: error instanceof Error ? error.message : String(error) })
        }
      }
      return {
        accepted: files.length > 0,
        ...(files.length > 0 ? {} : { reason: 'no_files_staged' }),
        directory: relative(cwd, directory).replaceAll('\\', '/'),
        files,
        errors,
      }
    },
  }))
}