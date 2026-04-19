/**
 * Self-contained HTML report for `archrad validate` (GitHub Actions artifact).
 */

import { writeFile } from 'node:fs/promises';
import type { IrStructuralFinding } from './ir-structural.js';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export async function writeFindingsHtmlReport(
  findings: IrStructuralFinding[],
  filePath: string,
  title = 'ArchRad validation report',
): Promise<void> {
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  const infos = findings.filter((f) => f.severity === 'info').length;

  const rows = findings
    .map((f) => {
      const sev = escapeHtml(f.severity);
      const code = escapeHtml(f.code);
      const msg = escapeHtml(f.message);
      const node = f.nodeId ? escapeHtml(f.nodeId) : '—';
      const hint = f.fixHint ? `<div class="hint">${escapeHtml(f.fixHint)}</div>` : '';
      return `<tr class="sev-${escapeHtml(f.severity)}"><td><span class="sev">${sev}</span></td><td><code>${code}</code></td><td>${node}</td><td>${msg}${hint}</td></tr>`;
    })
    .join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, Segoe UI, Roboto, sans-serif; margin: 1.25rem; line-height: 1.45; color: #1a1a1a; }
    h1 { font-size: 1.25rem; margin-top: 0; }
    .summary { margin: 1rem 0; padding: 0.75rem 1rem; background: #f4f4f5; border-radius: 6px; }
    .summary strong { margin-right: 0.5rem; }
    table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    th, td { border: 1px solid #d4d4d8; padding: 0.5rem 0.65rem; text-align: left; vertical-align: top; }
    th { background: #fafafa; }
    tr.sev-error { background: #fef2f2; }
    tr.sev-warning { background: #fffbeb; }
    .sev { font-weight: 600; text-transform: uppercase; font-size: 0.75rem; }
    code { font-size: 0.85em; }
    .hint { margin-top: 0.35rem; font-size: 0.85rem; color: #52525b; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <div class="summary">
    <strong>Total</strong> ${findings.length} findings    · <strong>Errors</strong> ${errors}
    · <strong>Warnings</strong> ${warnings}
    ${infos ? `· <strong>Info</strong> ${infos}` : ''}
  </div>
  ${
    findings.length === 0
      ? '<p>No findings. IR structural validation and architecture lint passed.</p>'
      : `<table>
    <thead><tr><th>Severity</th><th>Code</th><th>Node</th><th>Message</th></tr></thead>
    <tbody>
${rows}
    </tbody>
  </table>`
  }
</body>
</html>
`;

  await writeFile(filePath, html, 'utf8');
}
