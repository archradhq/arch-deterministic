import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateIrLint } from './ir-lint.js';
import { loadPolicyPacksFromDirectory, loadPolicyPacksFromFiles } from './policy-pack.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dirname, '../fixtures/policy-packs');

describe('loadPolicyPacksFromFiles', () => {
  it('rejects empty sources', () => {
    const r = loadPolicyPacksFromFiles([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /no policy sources/i.test(e))).toBe(true);
  });

  it('loads the same rules as directory for sample-only content', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const p = path.join(fixturesDir, 'sample-only', 'sample-node-tags.yaml');
    const content = await fs.readFile(p, 'utf8');
    const fromMem = loadPolicyPacksFromFiles([{ name: 'sample-node-tags.yaml', content }]);
    const fromDir = await loadPolicyPacksFromDirectory(path.join(fixturesDir, 'sample-only'));
    expect(fromMem.ok && fromDir.ok).toBe(true);
    if (fromMem.ok && fromDir.ok) {
      expect(fromMem.ruleCount).toBe(fromDir.ruleCount);
    }
  });
});

describe('loadPolicyPacksFromDirectory', () => {
  it('loads sample-node-tags and compiles visitors', async () => {
    const r = await loadPolicyPacksFromDirectory(join(fixturesDir, 'sample-only'));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.ruleCount).toBe(1);
      expect(r.visitors.length).toBe(1);
    }
  });

  it('rejects duplicate rule ids across files', async () => {
    const r = await loadPolicyPacksFromDirectory(join(fixturesDir, 'duplicate-pack'));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes('duplicate rule id'))).toBe(true);
    }
  });
});

describe('validateIrLint + policy packs', () => {
  it('emits ORG-HTTP-DEPRECATED-001 when an HTTP node has the deprecated tag', async () => {
    const loaded = await loadPolicyPacksFromDirectory(join(fixturesDir, 'sample-only'));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.errors.join('; '));

    const ir = {
      graph: {
        nodes: [
          {
            id: 'api',
            type: 'http',
            config: { url: '/x', method: 'GET' },
            metadata: { tags: ['deprecated'] },
          },
        ],
        edges: [],
      },
    };
    const findings = validateIrLint(ir, { policyRuleVisitors: loaded.visitors });
    expect(findings.some((f) => f.code === 'ORG-HTTP-DEPRECATED-001' && f.nodeId === 'api')).toBe(true);
  });

  it('does not emit ORG-HTTP-DEPRECATED-001 when the deprecated tag is absent', async () => {
    const loaded = await loadPolicyPacksFromDirectory(join(fixturesDir, 'sample-only'));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.errors.join('; '));

    const ir = {
      graph: {
        nodes: [
          {
            id: 'api',
            type: 'http',
            config: { url: '/x', method: 'GET' },
            metadata: { tags: ['stable'] },
          },
        ],
        edges: [],
      },
    };
    const findings = validateIrLint(ir, { policyRuleVisitors: loaded.visitors });
    expect(findings.some((f) => f.code === 'ORG-HTTP-DEPRECATED-001')).toBe(false);
  });
});
