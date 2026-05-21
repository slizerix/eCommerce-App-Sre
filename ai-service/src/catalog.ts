import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

// Loads blueprint files on demand. The LLM has two ways to get this context:
//   1. A short snapshot is injected into the system prompt at agent start
//      (the catalog summary section, harvested from the file headings).
//   2. Full files reachable via the `get_metric_catalog` and `get_runbook`
//      tools, when the LLM decides it needs depth.
//
// Files are intentionally small enough to fit comfortably in a tool result.

const CACHE = new Map<string, string>();

async function readBlueprint(filename: string): Promise<string> {
  const cached = CACHE.get(filename);
  if (cached) return cached;
  const fullPath = path.join(config.blueprintDir, filename);
  try {
    const content = await readFile(fullPath, 'utf8');
    CACHE.set(filename, content);
    return content;
  } catch (err) {
    return `# missing blueprint file\n\nCould not read ${fullPath}: ${(err as Error).message}`;
  }
}

export function getCatalog(): Promise<string> {
  return readBlueprint('catalog.md');
}

export function getGuidelines(): Promise<string> {
  return readBlueprint('guidelines.md');
}

// Returns a compact summary suitable for the system prompt. We don't dump
// the full catalog here — the file gets long, and the LLM can fetch it via
// tool call if it needs detail. What goes in the prompt is the metric names
// and one-line descriptions only.
export async function getCatalogSummary(): Promise<string> {
  const md = await getCatalog();
  // Extract lines that look like `### metric_name` or `- **field**: ...`
  // Falls back to the first ~80 lines if the format is unrecognized.
  const lines = md.split('\n');
  const summary: string[] = [];
  for (const line of lines) {
    if (/^#{2,3}\s+`?[a-z_]+`?/i.test(line) || /^-\s+\*\*`?[a-z_.]+`?\*\*/i.test(line)) {
      summary.push(line.trim());
    }
  }
  if (summary.length === 0) {
    return lines.slice(0, 80).join('\n');
  }
  return summary.join('\n');
}
