import { ConfigError } from './config.ts'

export interface TemplateContext {
  root: string
  name: string
  home: string
  ports: Record<string, number>
}

/** Replace `{root}`, `{name}`, `{home}` and `{<service>}` tokens. */
export function renderTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(/\{([^{}]*)\}/g, (_match, token: string) => {
    if (token === 'root') return ctx.root
    if (token === 'name') return ctx.name
    if (token === 'home') return ctx.home
    const port = ctx.ports[token]
    if (port === undefined) throw new ConfigError(`unknown template token {${token}}`)
    return String(port)
  })
}

export interface MergedEnv {
  env: Record<string, string | undefined>
  /** Keys taken from `values`. */
  applied: string[]
  /** Keys already present in `base` and left untouched. */
  kept: string[]
}

/** Overlay `values` onto `base` without overwriting anything already set: an explicit variable always wins. */
export function mergeEnv(base: Record<string, string | undefined>, values: Record<string, string>): MergedEnv {
  const env = { ...base }
  const applied: string[] = []
  const kept: string[] = []
  for (const [key, value] of Object.entries(values)) {
    if (env[key] === undefined) {
      env[key] = value
      applied.push(key)
    } else {
      kept.push(key)
    }
  }
  return { env, applied, kept }
}
