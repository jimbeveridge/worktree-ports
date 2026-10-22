import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'

const PKG = resolve(import.meta.dirname, '..')
const SOURCE_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs'])

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) walk(abs, out)
    else if (SOURCE_EXTENSIONS.has(extname(entry.name))) out.push(abs)
  }
}

/** Every `.ts`/`.mts`/`.cts`/`.js`/`.mjs` file under `src/` and `bin/`, at any depth. */
function sourceFiles(): string[] {
  const out: string[] = []
  for (const dir of ['src', 'bin']) {
    const abs = join(PKG, dir)
    if (existsSync(abs)) walk(abs, out)
  }
  return out
}

test('src/ and bin/ import only node: builtins and files inside the package', () => {
  const files = sourceFiles()
  assert.ok(files.length > 0, 'expected source files to scan')
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const label = relative(PKG, file)

    // CommonJS escape hatches bypass the whole static check below; ban them outright.
    assert.doesNotMatch(text, /\brequire\s*\(/, `${label} uses require(), which bypasses the boundary guard`)
    assert.doesNotMatch(text, /\bcreateRequire\b/, `${label} uses createRequire, which bypasses the boundary guard`)

    // Every dynamic import(...) must take a single plain string literal — no template literals,
    // concatenation, or variables, all of which would hide the target from this static check.
    for (const m of text.matchAll(/\bimport\s*\(([^)]*)\)/g)) {
      const arg = (m[1] ?? '').trim()
      assert.match(
        arg,
        /^(['"])[^'"]*\1$/,
        `${label} has a dynamic import() whose argument is not a plain string literal: ${m[0]}`,
      )
    }

    // `import x from '…'` / `export … from '…'`, dynamic `import('…')`, and bare side-effect `import '…'`.
    // `\b` (not `(?:^|\s)`) so a preceding token with no separating space (`foo();import …`, `}export …`)
    // still counts as a boundary.
    const specifiers = [
      ...text.matchAll(
        /\b(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\bimport\s+['"]([^'"]+)['"]/gm,
      ),
    ].map((m) => m[1] ?? m[2] ?? m[3] ?? '')
    for (const spec of specifiers) {
      const inside =
        spec.startsWith('node:') ||
        ((spec.startsWith('./') || spec.startsWith('../')) && resolve(dirname(file), spec).startsWith(PKG + sep))
      assert.ok(inside, `${label} imports "${spec}", which is outside the package`)
    }
  }
})
