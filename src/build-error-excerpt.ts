import {stripVTControlCharacters} from 'util';

/**
 * Pick the few lines of a failed build's output that show why it failed.
 *
 * `build-all` builds packages in parallel, so a failure's full output is
 * printed inline, interleaved with everything else. Its end-of-run summary
 * repeats a short excerpt under each failed package so the cause is visible
 * without scrolling back. This is that excerpt: lines that look like errors
 * (`error TS…`, `Error:`, `npm ERR!`, …) with the first stack frame after
 * each, without npm's lifecycle boilerplate, de-duplicated and truncated. When
 * nothing looks like an error, the last meaningful lines are used instead.
 */
export function excerptBuildError(
  output: string,
  maxLines = 8,
  maxWidth = 160,
): string[] {
  const lines = stripVTControlCharacters(output || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''));

  const picked: string[] = [];
  let errorLines = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isNoise(line) || !isErrorLine(line)) continue;
    picked.push(line.trim());
    errorLines++;
    // Keep the first stack frame of a thrown error: where it came from.
    const next = lines[i + 1];
    if (next !== undefined && isStackFrame(next)) picked.push(next);
  }

  let chosen: string[];
  if (errorLines > 0) {
    chosen = picked;
  } else {
    // Nothing looks like an error: show how the output ended.
    let seenFrame = false;
    chosen = lines.filter((line) => {
      if (isNoise(line)) return false;
      if (isStackFrame(line)) {
        if (seenFrame) return false;
        seenFrame = true;
      }
      return true;
    });
    chosen = chosen.slice(-maxLines);
  }

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const line of chosen) {
    const key = line.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(truncate(line, maxWidth));
  }

  if (unique.length <= maxLines) return unique;
  const shown = unique.slice(0, maxLines - 1);
  shown.push(`… ${unique.length - shown.length} more`);
  return shown;
}

function truncate(line: string, maxWidth: number): string {
  return line.length > maxWidth ? line.slice(0, maxWidth - 1) + '…' : line;
}

function isStackFrame(line: string): boolean {
  return /^\s+at\s/.test(line);
}

/** Error-looking lines worth showing first. */
function isErrorLine(line: string): boolean {
  return (
    /\berror TS\d+\b/.test(line) ||
    /^\s*(Uncaught\s+)?([A-Z]\w*)?(Error|Exception)\b(\s*\[[^\]]*\])?:/.test(line) ||
    /^\s*(npm ERR!|npm error)\s/.test(line) ||
    /^\s*(error|ERROR|✘ \[ERROR\])\b:?\s/.test(line) ||
    /^\s*\S+:\d+(:\d+)?\s*-?\s*error\b/i.test(line) ||
    /\bERR_[A-Z_]+\b/.test(line) ||
    /\b(Cannot find (module|name)|Module not found|Could not resolve)\b/.test(
      line,
    )
  );
}

/** Lines that never explain a failure: npm lifecycle chatter and Node's throw site. */
function isNoise(line: string): boolean {
  const t = line.trim();
  if (t === '') return true;
  return (
    /^npm (notice|warn|WARN|info|timing|verb|http)\b/.test(t) ||
    // npm's own report that the script failed, and where its log went.
    /^(npm ERR!|npm error)\s+(code\b|errno\b|path\b|workspace\b|location\b|command\b|syscall\b|signal\b|A complete log|Lifecycle script|Failed at|This is probably|Exit status|Tell the author|You can get|Make sure|Check the|\S+@\S+ build:|$)/.test(
      t,
    ) ||
    /^(npm ERR!|npm error)$/.test(t) ||
    /^>\s/.test(t) ||
    /^node:internal\//.test(t) ||
    /^triggerUncaughtException\(/.test(t) ||
    /^\^+$/.test(t) ||
    /^Node\.js v\d/.test(t) ||
    /^(error )?Command failed with exit code \d+\.?$/.test(t) ||
    /^info Visit https:\/\/yarnpkg\.com/.test(t)
  );
}
