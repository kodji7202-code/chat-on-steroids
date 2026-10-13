export const MAX_QUALITY_CHECKS = 8;
export const MAX_QUALITY_CHECK_CHARS = 500;

/**
 * One check line as argv: whitespace separates arguments and double quotes group them.
 * There is no shell: pipes, globs, variables and redirections are passed through as literal text.
 */
export function parseQualityCheck(line: string): string[] | null {
  const argv: string[] = [];
  let current = '';
  let quoted = false;
  let started = false;
  for (const char of line.trim()) {
    if (char === '"') { quoted = !quoted; started = true; continue; }
    if (!quoted && /\s/.test(char)) {
      if (started) argv.push(current);
      current = ''; started = false;
      continue;
    }
    current += char; started = true;
  }
  if (quoted) return null;
  if (started) argv.push(current);
  return argv.length > 0 && argv[0] !== '' ? argv : null;
}

/** Trimmed, non-empty lines, or an error naming the first line that cannot be a command. */
export function normalizeQualityChecks(lines: readonly string[]): { checks: string[] } | { error: string } {
  const checks = lines.map(line => line.trim()).filter(Boolean);
  if (checks.length > MAX_QUALITY_CHECKS) return { error: `Use at most ${MAX_QUALITY_CHECKS} checks` };
  for (const check of checks) {
    if (check.length > MAX_QUALITY_CHECK_CHARS || check.includes('\0')) return { error: `Check is too long: ${check.slice(0, 60)}` };
    if (!parseQualityCheck(check)) return { error: `Check is not a command: ${check.slice(0, 60)}` };
  }
  return { checks };
}
