import { describe, it, expect } from 'vitest';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFindingsHtmlReport } from './validate-report-html.js';

describe('writeFindingsHtmlReport', () => {
  it('writes HTML with escaped message and summary', async () => {
    const tmp = join(tmpdir(), `archrad-report-test-${Date.now()}.html`);
    try {
      await writeFindingsHtmlReport(
        [
          {
            code: 'IR-LINT-X',
            severity: 'warning',
            message: 'Use <tags> & "quotes"',
            nodeId: 'n1',
            fixHint: 'Fix <me>',
          },
        ],
        tmp,
      );
      const html = await readFile(tmp, 'utf8');
      expect(html).toContain('Use &lt;tags&gt; &amp; &quot;quotes&quot;');
      expect(html).toContain('Fix &lt;me&gt;');
      expect(html).toContain('Total</strong> 1 findings');
      expect(html).toContain('IR-LINT-X');
    } finally {
      await unlink(tmp).catch(() => {});
    }
  });

  it('writes empty state when no findings', async () => {
    const tmp = join(tmpdir(), `archrad-report-empty-${Date.now()}.html`);
    try {
      await writeFindingsHtmlReport([], tmp);
      const html = await readFile(tmp, 'utf8');
      expect(html).toContain('No findings');
    } finally {
      await unlink(tmp).catch(() => {});
    }
  });
});
