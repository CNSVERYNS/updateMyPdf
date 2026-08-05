import { execFile as execFileCallback } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFile = promisify(execFileCallback)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const findGhostscript = () => {
  const roots = ['C:\\Program Files\\gs', 'C:\\Program Files (x86)\\gs']
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const version of readdirSync(root)) {
      const candidate = path.join(root, version, 'bin', 'gswin64c.exe')
      if (existsSync(candidate)) return candidate
    }
  }
  return process.env.PDFMANIAC_GHOSTSCRIPT_PATH || null
}

const tools = {
  qpdf: process.env.PDFMANIAC_QPDF_PATH || path.join(projectRoot, 'tools', 'qpdf-12.3.2', 'qpdf-12.3.2-msvc64', 'bin', 'qpdf.exe'),
  ghostscript: findGhostscript(),
  libreoffice: process.env.PDFMANIAC_LIBREOFFICE_PATH || 'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
}

const toolLabels = {
  qpdf: 'qpdf',
  ghostscript: 'Ghostscript',
  libreoffice: 'LibreOffice',
}

export const getExternalToolStatus = () => Object.fromEntries(Object.entries(tools).map(([name, executable]) => [name, {
  available: Boolean(executable && (path.isAbsolute(executable) ? existsSync(executable) : true)),
  executable: executable || null,
}]))

export const getGhostscriptResources = () => {
  const executable = tools.ghostscript
  const available = Boolean(executable && (path.isAbsolute(executable) ? existsSync(executable) : true))
  if (!available) return null
  const root = path.dirname(path.dirname(executable))
  return {
    root,
    lib: path.join(root, 'lib'),
    iccprofiles: path.join(root, 'iccprofiles'),
    pdfaDefinition: path.join(root, 'lib', 'PDFA_def.ps'),
    pdfxDefinition: path.join(root, 'lib', 'PDFX_def.ps'),
    pdfaProfile: path.join(root, 'iccprofiles', 'esrgb.icc'),
    pdfxProfile: path.join(root, 'iccprofiles', 'default_cmyk.icc'),
  }
}

export const runExternalTool = async (name, args, options = {}) => {
  const executable = tools[name]
  const available = Boolean(executable && (path.isAbsolute(executable) ? existsSync(executable) : true))
  if (!available) {
    const error = new Error(`${toolLabels[name] || name} is not installed.`)
    error.code = 'TOOL_MISSING'
    throw error
  }
  return execFile(executable, args, {
    cwd: options.cwd || projectRoot,
    timeout: options.timeout || 180000,
    maxBuffer: options.maxBuffer || 20 * 1024 * 1024,
    windowsHide: true,
  })
}

export const withTempDirectory = async (callback) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'pdfmaniac-'))
  try {
    return await callback(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
