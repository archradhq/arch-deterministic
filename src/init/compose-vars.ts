/**
 * Docker Compose `${VAR}`, `${VAR:-default}`, `$$` literal for static YAML parsers.
 */

export function parseDotEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (let line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (t.startsWith('export ')) line = t.slice(7).trim();
    else line = t;

    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) continue;
    out[key] = val;
  }
  return out;
}

/** Merge bindings: **`includeProcessEnv`** first when set, then **`explicit`** overlays (explicit wins on key clashes). */
export function composeInterpolationBindings(
  explicit: Record<string, string> | undefined,
  includeProcessEnv: boolean | undefined,
): Record<string, string> {
  const merged: Record<string, string> = {};
  if (includeProcessEnv && typeof process !== 'undefined' && process.env) {
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && v !== '') merged[k] = v;
    }
  }
  if (explicit) {
    Object.assign(merged, explicit);
  }
  return merged;
}

const DOLLAR_SENT = '\uE070';

/**
 * Compose `${VAR}`, `${VAR:-default}` for simple names; `:+`, `:?`, `#` etc. left as literal `${…}`.
 */
function expandOneBraceBody(innerRaw: string, vars: Record<string, string>): string | null {
  const inner = innerRaw.trim();

  for (const c of '?#%+') {
    if (inner.includes(c)) return null;
  }
  if (inner.includes(':+')) return null;

  const ixColonDash = inner.indexOf(':-');
  if (ixColonDash !== -1) {
    const name = inner.slice(0, ixColonDash).trim();
    const def = inner.slice(ixColonDash + 2);
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) return null;
    const cur = vars[name];
    if (cur === undefined || cur === '') return def;
    return cur;
  }

  const mHyphen = /^([a-zA-Z_][a-zA-Z0-9_]*)-(.+)$/.exec(inner);
  if (mHyphen?.[1] && mHyphen[2] !== undefined) {
    const name = mHyphen[1];
    const def = mHyphen[2];
    const cur = vars[name];
    if (cur === undefined) return def;
    return cur;
  }

  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(inner)) {
    return vars[inner] ?? '';
  }

  return null;
}

/**
 * One deterministic pass: `$$` → placeholder; `${…}` substituted when `expandOneBraceBody` succeeds.
 * Scans left-to-right so `$${VAR}` emits one literal `$` from `$$`-pair handling, then expands `${VAR}`.
 */
function expandComposeVarsPass(input: string, vars: Record<string, string>): string {
  const out: string[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i]!;
    if (c === '$' && input[i + 1] === '$') {
      out.push(DOLLAR_SENT);
      i += 2;
      /** Compose `$${VAR}`:`$$` consumes two `$`; next char is `{` opening `${VAR}` */
      if (input[i] === '{') {
        const end = input.indexOf('}', i + 1);
        if (end === -1) {
          out.push(input.slice(i));
          break;
        }
        const inner = input.slice(i + 1, end);
        const r = expandOneBraceBody(inner, vars);
        out.push(r === null ? input.slice(i, end + 1) : r);
        i = end + 1;
      }
      continue;
    }
    if (c === '$' && input[i + 1] === '{') {
      const end = input.indexOf('}', i + 2);
      if (end === -1) {
        out.push(input.slice(i));
        break;
      }
      const inner = input.slice(i + 2, end);
      const r = expandOneBraceBody(inner, vars);
      out.push(r === null ? input.slice(i, end + 1) : r);
      i = end + 1;
      continue;
    }
    out.push(c);
    i += 1;
  }
  return out.join('');
}

/** Expand `${VAR}` / `${VAR:-x}`; `$$` → single `$`; repeat until stable for nested substitutions. */
export function expandComposeVars(input: string, vars: Record<string, string>): string {
  let s = input;
  for (let p = 0; p < 32; p++) {
    const next = expandComposeVarsPass(s, vars);
    if (next === s) break;
    s = next;
  }
  return s.split(DOLLAR_SENT).join('$');
}
