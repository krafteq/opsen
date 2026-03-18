#!/usr/bin/env node
/**
 * Builds the Azure Function deployment artifact:
 *   dist/azure-function.zip
 *
 * Contains:
 *   - function-bundle.cjs  (single-file esbuild bundle, all deps inlined)
 *   - host.json
 *   - certRenewalTimer/function.json
 *   - package.json
 */
import { build } from 'esbuild'
import { writeFileSync, mkdirSync, rmSync, createWriteStream } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const outDir = join(root, 'dist', 'azure-function')
const require = createRequire(import.meta.url)

// Clean
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
mkdirSync(join(outDir, 'certRenewalTimer'), { recursive: true })

// Bundle function-handler.ts → function-bundle.cjs (CJS, all deps inlined)
await build({
  entryPoints: [join(root, 'src', 'function-handler.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: join(outDir, 'function-bundle.cjs'),
  // Node built-ins are external (available in Azure Functions runtime)
  external: [
    'node:*',
    'crypto',
    'https',
    'http',
    'fs',
    'path',
    'os',
    'child_process',
    'url',
    'net',
    'tls',
    'stream',
    'zlib',
    'events',
    'buffer',
    'util',
    'assert',
    'querystring',
  ],
  minify: false, // keep readable for debugging
  sourcemap: false,
})

// host.json
writeFileSync(
  join(outDir, 'host.json'),
  JSON.stringify(
    {
      version: '2.0',
      extensionBundle: {
        id: 'Microsoft.Azure.Functions.ExtensionBundle',
        version: '[4.*, 5.0.0)',
      },
    },
    null,
    2,
  ),
)

// function.json (v3 model, points to the bundle)
writeFileSync(
  join(outDir, 'certRenewalTimer', 'function.json'),
  JSON.stringify(
    {
      bindings: [
        {
          name: 'myTimer',
          type: 'timerTrigger',
          direction: 'in',
          schedule: '0 0 3 * * *',
        },
      ],
      scriptFile: '../function-bundle.cjs',
    },
    null,
    2,
  ),
)

// package.json (minimal, no deps needed — everything is bundled)
writeFileSync(join(outDir, 'package.json'), JSON.stringify({ name: 'cert-renewer-func' }))

// Create zip using Node.js (no external zip command needed)
const archiver = (await import('archiver')).default
const zipPath = join(root, 'dist', 'azure-function.zip')
const output = createWriteStream(zipPath)
const archive = archiver('zip', { zlib: { level: 9 } })

await new Promise((resolve, reject) => {
  output.on('close', resolve)
  archive.on('error', reject)
  archive.pipe(output)
  archive.directory(outDir, false)
  archive.finalize()
})

const sizeKB = Math.round(output.bytesWritten / 1024)
console.log(`[build-azure-function] Built ${zipPath} (${sizeKB}KB)`)
