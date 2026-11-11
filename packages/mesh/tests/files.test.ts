import { describe, expect, it } from 'vitest'
import { safeFileName, suffixedName, uploadFileName } from '../src/files.js'

describe('mesh task file names', () => {
  it('keeps a readable basename and strips path separators', () => {
    expect(safeFileName('/tmp/report.pdf')).toBe('report.pdf')
    expect(safeFileName('..\\secret.txt')).toBe('secret.txt')
    expect(safeFileName('   ')).toBe('file')
  })

  it('prefixes uploads with a task identity and an ordinal', () => {
    expect(uploadFileName('12345678-aaaa-bbbb-cccc-123456789012', 0, '/tmp/report.pdf'))
      .toBe('mesh-in-12345678-1-report.pdf')
  })

  it('keeps upload names within the host byte budget', () => {
    const name = uploadFileName('12345678-aaaa', 0, `${'x'.repeat(300)}.txt`)
    expect(Buffer.byteLength(name, 'utf8')).toBeLessThanOrEqual(220)
  })

  it('adds collision suffixes before the extension', () => {
    expect(suffixedName('report.pdf', 0)).toBe('report.pdf')
    expect(suffixedName('report.pdf', 2)).toBe('report (2).pdf')
    expect(suffixedName('README', 1)).toBe('README (1)')
  })
})