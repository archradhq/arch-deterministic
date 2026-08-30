import { describe, it, expect } from 'vitest';
import {
  unifyScanRoots,
  unifyCorroboratedApps,
  unifyEquivalentComponentNames,
  unifySingletonInfra,
  unifyComposeOverrides,
  unifyRedundantEdges,
  unifyDraft,
} from './merge-draft.js';
import { readProvenance, elementConfidence } from './provenance.js';

function prov(extractor: string, from: string, confidence: 'high' | 'medium' | 'low' = 'low') {
  return { inferred_from: from, confidence, extractor };
}
function node(id: string, type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, type, name: id, config: {}, ...extra };
}

describe('unifyScanRoots', () => {
  it('collapses two scanRoot-tagged nodes, preferring the more specific type', () => {
    const nodes = [
      node('gateway_x', 'gateway', { config: { scanRoot: true, provenance: [prov('code', 'src/index.ts:9')] } }),
      node('service_x', 'service', { config: { scanRoot: true, provenance: [prov('manifest', 'package.json:1')] } }),
    ];
    const edges = [
      { id: 'e0', from: 'gateway_x', to: 'db', metadata: { relation: 'dbConnection' }, config: { provenance: [prov('code', 'src/index.ts:9')] } },
      { id: 'e1', from: 'service_x', to: 'smtp', metadata: { relation: 'smtp' }, config: { provenance: [prov('manifest', 'package.json:2')] } },
    ];
    const result = unifyScanRoots(nodes, edges, ['manifest', 'code']);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.id).toBe('gateway_x'); // gateway (specificity 0) beats service (2)
    expect(readProvenance(result.nodes[0]!).map((p) => p.extractor).sort()).toEqual(['code', 'manifest']);
    // Both edges survive, rewired onto the survivor id.
    expect(result.edges.map((e) => e.from)).toEqual(['gateway_x', 'gateway_x']);
    expect(result.edges.map((e) => e.to).sort()).toEqual(['db', 'smtp']);
  });

  it('is a no-op when fewer than two nodes are tagged scanRoot', () => {
    const nodes = [node('gateway_x', 'gateway', { config: { scanRoot: true } }), node('postgres', 'postgres')];
    const result = unifyScanRoots(nodes, [], ['code']);
    expect(result.nodes).toHaveLength(2);
  });

  it('drops a self-loop edge created by rewiring both endpoints onto the same survivor', () => {
    const nodes = [
      node('gateway_x', 'gateway', { config: { scanRoot: true, provenance: [prov('code', 'a:1')] } }),
      node('service_x', 'service', { config: { scanRoot: true, provenance: [prov('manifest', 'b:1')] } }),
    ];
    const edges = [{ id: 'e0', from: 'gateway_x', to: 'service_x', metadata: { relation: 'selfRef' }, config: { provenance: [prov('code', 'a:1')] } }];
    const result = unifyScanRoots(nodes, edges, ['manifest', 'code']);
    expect(result.edges).toHaveLength(0);
  });
});

describe('unifyCorroboratedApps', () => {
  it('folds exact alias and two-shared-infra views into the proven scan root', () => {
    const nodes = [
      node('gateway_code', 'gateway', { name: 'repo-folder', config: { scanRoot: true, scanAliases: ['immich'], provenance: [prov('code', 'src/app.ts:1')] } }),
      node('gateway_openapi', 'gateway', { name: 'immich', config: { provenance: [prov('openapi', 'openapi.json:1', 'medium')] } }),
      node('gateway_compose', 'gateway', { name: 'immich-server', config: { provenance: [
        prov('compose', 'docker-compose.yml:1', 'high'),
        prov('compose', 'docker-compose.prod.yml:1', 'high'),
      ] } }),
      node('db', 'postgres'),
      node('redis', 'cache'),
    ];
    const edges = [
      { from: 'gateway_code', to: 'db' },
      { from: 'gateway_code', to: 'redis' },
      { from: 'gateway_compose', to: 'db' },
      { from: 'gateway_compose', to: 'redis' },
    ];
    const result = unifyCorroboratedApps(nodes, edges, ['compose', 'openapi', 'code']);
    expect(result.nodes.filter((candidate) => candidate.type === 'gateway')).toHaveLength(1);
    expect([...new Set(readProvenance(result.nodes.find((candidate) => candidate.type === 'gateway')!).map((p) => p.extractor))].sort())
      .toEqual(['code', 'compose', 'openapi']);
  });

  it('does not merge a service sharing only one infrastructure dependency', () => {
    const nodes = [
      node('root', 'gateway', { config: { scanRoot: true, provenance: [prov('code', 'src/app.ts:1')] } }),
      node('worker', 'service', { config: { provenance: [prov('compose', 'compose.yml:1', 'high')] } }),
      node('db', 'postgres'),
    ];
    const edges = [{ from: 'root', to: 'db' }, { from: 'worker', to: 'db' }];
    expect(unifyCorroboratedApps(nodes, edges, ['compose', 'code']).nodes).toHaveLength(3);
  });
});

describe('unifyEquivalentComponentNames', () => {
  it('merges same-type cross-extractor names that differ only by display spacing', () => {
    const nodes = [
      node('service_balance_reader', 'service', { name: 'Balance Reader', config: { provenance: [prov('manifest', 'pom.xml:1')] } }),
      node('service_balancereader', 'service', { name: 'balancereader', config: { provenance: [prov('kubernetes', 'deployment.yaml:1', 'high')] } }),
    ];
    const result = unifyEquivalentComponentNames(nodes, [], ['kubernetes', 'manifest']);
    expect(result.nodes).toHaveLength(1);
    expect([...new Set(readProvenance(result.nodes[0]!).map((record) => record.extractor))].sort())
      .toEqual(['kubernetes', 'manifest']);
  });

  it('does not merge compact-name collisions emitted by the same extractor', () => {
    const nodes = [
      node('service_a', 'service', { name: 'order-api', config: { provenance: [prov('kubernetes', 'a.yaml:1', 'high')] } }),
      node('service_b', 'service', { name: 'order api', config: { provenance: [prov('kubernetes', 'b.yaml:1', 'high')] } }),
    ];
    expect(unifyEquivalentComponentNames(nodes, [], ['kubernetes']).nodes).toHaveLength(2);
  });
});

describe('unifySingletonInfra', () => {
  it('collapses same-type nodes from different extractors even when names differ', () => {
    const nodes = [
      node('firestore', 'firestore', { config: { provenance: [prov('manifest', 'package.json:39')] } }),
      node('firestore_firebase_admin', 'firestore', { config: { provenance: [prov('code', 'scripts/seed.ts:11')] } }),
    ];
    const result = unifySingletonInfra(nodes, [], ['manifest', 'code']);
    expect(result.nodes).toHaveLength(1);
    expect(readProvenance(result.nodes[0]!).map((p) => p.extractor).sort()).toEqual(['code', 'manifest']);
  });

  it('does NOT collapse when a single extractor contributes two nodes of the same type', () => {
    // Two genuinely distinct instances (e.g. primary + replica) both found by compose —
    // merging across extractors here would risk conflating two real databases.
    const nodes = [
      node('postgres_primary', 'postgres', { config: { provenance: [prov('compose', 'compose.yml:1', 'high')] } }),
      node('postgres_replica', 'postgres', { config: { provenance: [prov('compose', 'compose.yml:2', 'high')] } }),
      node('postgres_db', 'postgres', { config: { provenance: [prov('code', 'src/db.ts:3')] } }),
    ];
    const result = unifySingletonInfra(nodes, [], ['compose', 'code']);
    expect(result.nodes).toHaveLength(3); // left untouched — unsafe to guess which one code's finding matches
  });

  it('only merges nodes sharing the exact same type', () => {
    const nodes = [
      node('postgres', 'postgres', { config: { provenance: [prov('manifest', 'a:1')] } }),
      node('mongodb', 'mongodb', { config: { provenance: [prov('code', 'b:1')] } }),
    ];
    const result = unifySingletonInfra(nodes, [], ['manifest', 'code']);
    expect(result.nodes).toHaveLength(2);
  });
});

describe('unifyDraft', () => {
  it('strips the internal scanRoot tag from the final output', () => {
    const nodes = [
      node('gateway_x', 'gateway', { config: { scanRoot: true, provenance: [prov('code', 'a:1')] } }),
      node('service_x', 'service', { config: { scanRoot: true, provenance: [prov('manifest', 'b:1')] } }),
    ];
    const result = unifyDraft(nodes, [], ['manifest', 'code']);
    expect(result.nodes).toHaveLength(1);
    expect((result.nodes[0]!.config as Record<string, unknown>).scanRoot).toBeUndefined();
  });

  it('runs root unification before infra unification without interference', () => {
    const nodes = [
      node('gateway_x', 'gateway', { config: { scanRoot: true, provenance: [prov('code', 'a:1')] } }),
      node('service_x', 'service', { config: { scanRoot: true, provenance: [prov('manifest', 'b:1')] } }),
      node('firestore', 'firestore', { config: { provenance: [prov('manifest', 'c:1')] } }),
      node('firestore_x', 'firestore', { config: { provenance: [prov('code', 'd:1')] } }),
    ];
    const result = unifyDraft(nodes, [], ['manifest', 'code']);
    expect(result.nodes).toHaveLength(2);
    expect(elementConfidence(result.nodes[0]!)).toBe('low');
  });
});

describe('unifyComposeOverrides', () => {
  const overrideNodes = () => [
    node('gateway_node_app', 'gateway', {
      name: 'node-app',
      config: { provenance: [prov('compose', 'docker-compose.yml:4', 'high')] },
    }),
    node('service_node_app', 'service', {
      name: 'node-app',
      config: { provenance: [prov('compose', 'docker-compose.dev.yml:4', 'high')] },
    }),
  ];

  it('collapses one service declared across base and override compose files', () => {
    const result = unifyComposeOverrides(overrideNodes(), [], ['compose']);
    expect(result.nodes).toHaveLength(1);
    // gateway (ports published in the base file) is the more specific type.
    expect(result.nodes[0]!.id).toBe('gateway_node_app');
    expect(readProvenance(result.nodes[0]!).map((p) => p.inferred_from).sort()).toEqual([
      'docker-compose.dev.yml:4',
      'docker-compose.yml:4',
    ]);
  });

  it('leaves same-named nodes alone when another extractor corroborates one of them', () => {
    const nodes = overrideNodes();
    nodes[1]!.config = {
      provenance: [prov('compose', 'docker-compose.dev.yml:4', 'high'), prov('code', 'src/index.js:1')],
    };
    const result = unifyComposeOverrides(nodes, [], ['compose', 'code']);
    expect(result.nodes).toHaveLength(2);
  });

  it('keeps the identified datastore type when an override re-declares the service without an image', () => {
    // compose.yml: `db: image: postgres:18` → postgres (identified).
    // compose.override.yml: `db:` with only ports → unknown image, promoted to
    // gateway (guessed). The identified type must win, or the database is
    // relabelled an HTTP entry point and then linted as one.
    const nodes = [
      node('postgres_db', 'postgres', {
        name: 'db',
        config: { provenance: [prov('compose', 'compose.yml:12', 'high')] },
      }),
      node('gateway_db', 'gateway', {
        name: 'db',
        config: { provenance: [prov('compose', 'compose.override.yml:4', 'high')] },
      }),
    ];
    const result = unifyComposeOverrides(nodes, [], ['compose']);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.type).toBe('postgres');
  });

  it('leaves distinct service names alone', () => {
    const nodes = [
      node('gateway_api', 'gateway', { name: 'api', config: { provenance: [prov('compose', 'a.yml:1', 'high')] } }),
      node('gateway_web', 'gateway', { name: 'web', config: { provenance: [prov('compose', 'b.yml:1', 'high')] } }),
    ];
    expect(unifyComposeOverrides(nodes, [], ['compose']).nodes).toHaveLength(2);
  });
});

describe('unifyRedundantEdges', () => {
  const nodes = [
    node('app', 'gateway'),
    node('mongodb', 'mongodb'),
    node('redis', 'cache'),
  ];

  it('collapses compose depends_on with a code dbConnection into one link', () => {
    const edges = [
      { id: 'e0', from: 'app', to: 'mongodb', metadata: { relation: 'depends_on' }, config: { provenance: [prov('compose', 'docker-compose.yml:4', 'high')] } },
      { id: 'e1', from: 'app', to: 'mongodb', metadata: { relation: 'dbConnection' }, config: { provenance: [prov('code', 'src/index.js:9')] } },
    ];
    const result = unifyRedundantEdges(nodes, edges);
    expect(result).toHaveLength(1);
    expect((result[0]!.metadata as Record<string, unknown>).relation).toBe('dbConnection');
    expect(readProvenance(result[0]!).map((p) => p.extractor).sort()).toEqual(['code', 'compose']);
  });

  it('names the surviving relation from the target type, resolving extractor disagreement', () => {
    // code calls a Redis link dbConnection, manifest calls it cacheConnection.
    const edges = [
      { id: 'e0', from: 'app', to: 'redis', metadata: { relation: 'dbConnection' }, config: { provenance: [prov('code', 'a.ts:1')] } },
      { id: 'e1', from: 'app', to: 'redis', metadata: { relation: 'cacheConnection' }, config: { provenance: [prov('manifest', 'package.json:3')] } },
    ];
    const result = unifyRedundantEdges(nodes, edges);
    expect(result).toHaveLength(1);
    expect((result[0]!.metadata as Record<string, unknown>).relation).toBe('cacheConnection');
  });

  it('keeps semantically distinct parallel edges (routes alongside a data link)', () => {
    const edges = [
      { id: 'e0', from: 'app', to: 'mongodb', metadata: { relation: 'dbConnection' }, config: {} },
      { id: 'e1', from: 'app', to: 'mongodb', metadata: { relation: 'serviceCall' }, config: {} },
    ];
    expect(unifyRedundantEdges(nodes, edges)).toHaveLength(2);
  });

  it('leaves a single edge untouched', () => {
    const edges = [{ id: 'e0', from: 'app', to: 'mongodb', metadata: { relation: 'depends_on' }, config: {} }];
    expect(unifyRedundantEdges(nodes, edges)).toEqual(edges);
  });
});
