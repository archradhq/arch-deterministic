/**
 * Topology extractor: Kubernetes manifests → PartialIR (confidence: high).
 *
 * Unlike compose, k8s manifests have no fixed filename — detected by CONTENT:
 * any YAML document with both `apiVersion` and a recognized `kind`. Reuses
 * `inferTypeFromImage()`, `connectionUrlHost()`, `composePlainEnvHostname()`,
 * and the `CONNECTION_ENV_KEYS`/`HOST_ONLY_ENV_KEYS` constants from the `init`
 * docker-compose path, so a Postgres StatefulSet and a Postgres Compose service
 * classify identically. See docs/SPEC-scan.md §3.1 for the full design and its
 * honest limitation (only literal `env[].value` is read — not `valueFrom`).
 */

import yaml from 'js-yaml';
import type { Extractor, PartialIR } from '../types.js';
import { canonicalizeIds } from '../node-id.js';
import { provenanceEntry, withProvenance } from '../provenance.js';
import {
  inferTypeFromImage,
  connectionUrlHost,
  composePlainEnvHostname,
  CONNECTION_ENV_KEYS,
  HOST_ONLY_ENV_KEYS,
} from '../../init/docker-compose.js';

const JSON_SCHEMA = yaml.JSON_SCHEMA;

const WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'Pod', 'Job', 'CronJob']);
const RECOGNIZED_KINDS = new Set([...WORKLOAD_KINDS, 'Service', 'Ingress']);

type PodSpec = { containers?: { image?: string; env?: { name?: string; value?: string }[] }[] };
type K8sDoc = {
  kind?: string;
  apiVersion?: string;
  metadata?: { name?: string; labels?: Record<string, string> };
  spec?: {
    selector?: Record<string, string>;
    template?: { metadata?: { labels?: Record<string, string> }; spec?: PodSpec };
    jobTemplate?: { spec?: { template?: { metadata?: { labels?: Record<string, string> }; spec?: PodSpec } } };
    rules?: { http?: { paths?: { backend?: { service?: { name?: string }; serviceName?: string } }[] } }[];
  } & PodSpec;
};

function isYamlFile(relPath: string): boolean {
  return /\.ya?ml$/i.test(relPath);
}

/**
 * 1-based line where each `---`-separated document starts. A LEADING `---`
 * (common style: files often open with one before any content) is a stream
 * marker, not a boundary between two documents — it must not shift the count
 * out of alignment with `yaml.loadAll`'s own document array.
 */
export function documentStartLines(text: string): number[] {
  const lines = text.split(/\r?\n/);
  const starts: number[] = [];
  let sawContentSinceLastBoundary = false;
  let currentStart = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^---\s*$/.test(line)) {
      if (sawContentSinceLastBoundary) starts.push(currentStart);
      currentStart = i + 2; // content begins the line after the separator
      sawContentSinceLastBoundary = false;
      continue;
    }
    if (line.trim() && !line.trim().startsWith('#')) sawContentSinceLastBoundary = true;
  }
  starts.push(currentStart);
  return starts;
}

/** Parse every YAML document in a file, keeping only recognized k8s manifests, paired with its start line. */
function loadK8sDocs(text: string): { doc: K8sDoc; line: number }[] {
  const docs: unknown[] = [];
  try {
    yaml.loadAll(text, (d) => docs.push(d), { schema: JSON_SCHEMA });
  } catch {
    return [];
  }
  const starts = documentStartLines(text);
  const out: { doc: K8sDoc; line: number }[] = [];
  docs.forEach((d, i) => {
    if (
      d &&
      typeof d === 'object' &&
      !Array.isArray(d) &&
      typeof (d as K8sDoc).kind === 'string' &&
      typeof (d as K8sDoc).apiVersion === 'string' &&
      RECOGNIZED_KINDS.has((d as K8sDoc).kind as string)
    ) {
      out.push({ doc: d as K8sDoc, line: starts[i] ?? 1 });
    }
  });
  return out;
}

/** The pod template spec for any workload kind (CronJob nests one level deeper; Pod IS the pod). */
function podSpecOf(doc: K8sDoc): PodSpec | undefined {
  if (doc.kind === 'CronJob') return doc.spec?.jobTemplate?.spec?.template?.spec;
  if (doc.kind === 'Pod') return doc.spec as PodSpec | undefined;
  return doc.spec?.template?.spec;
}

function podLabelsOf(doc: K8sDoc): Record<string, string> {
  if (doc.kind === 'CronJob') return doc.spec?.jobTemplate?.spec?.template?.metadata?.labels ?? {};
  if (doc.kind === 'Pod') return doc.metadata?.labels ?? {};
  return doc.spec?.template?.metadata?.labels ?? {};
}

function primaryImage(doc: K8sDoc): string | undefined {
  return podSpecOf(doc)?.containers?.[0]?.image;
}

/** Literal (non-`valueFrom`) env vars across all containers, flattened. Later containers win on key collision. */
function podEnv(doc: K8sDoc): Record<string, string> {
  const env: Record<string, string> = {};
  for (const c of podSpecOf(doc)?.containers ?? []) {
    for (const e of c.env ?? []) {
      if (typeof e.name === 'string' && typeof e.value === 'string') env[e.name] = e.value;
    }
  }
  return env;
}

function selectorMatches(selector: Record<string, string> | undefined, labels: Record<string, string>): boolean {
  if (!selector || Object.keys(selector).length === 0) return false;
  return Object.entries(selector).every(([k, v]) => labels[k] === v);
}

/** k8s in-cluster DNS is `<service>.<namespace>.svc.cluster.local`; bare short names also resolve. */
function resolveHostToIds(
  host: string,
  workloadIdsByServiceName: Map<string, string[]>,
  workloadIdByName: Map<string, string>,
): string[] {
  const shortName = host.split('.')[0] ?? host;
  if (workloadIdsByServiceName.has(shortName)) return workloadIdsByServiceName.get(shortName)!;
  const direct = workloadIdByName.get(shortName);
  return direct ? [direct] : [];
}

export const kubernetesExtractor: Extractor = {
  name: 'kubernetes',
  defaultConfidence: 'high',
  extract(tree): PartialIR[] {
    const partials: PartialIR[] = [];

    for (const file of tree.files) {
      if (!isYamlFile(file.relPath)) continue;
      const text = tree.read(file.relPath);
      if (!text.trim()) continue;

      const entries = loadK8sDocs(text);
      if (entries.length === 0) continue;

      const workloads = entries.filter((e) => WORKLOAD_KINDS.has(e.doc.kind as string));
      const services = entries.filter((e) => e.doc.kind === 'Service');
      const ingresses = entries.filter((e) => e.doc.kind === 'Ingress');
      if (workloads.length === 0 && ingresses.length === 0) continue; // Services alone anchor nothing

      const nodes: Record<string, unknown>[] = [];
      const edges: Record<string, unknown>[] = [];
      const prov = (line: number) => provenanceEntry('kubernetes', file.relPath, line, 'high');

      const workloadIdByName = new Map<string, string>();
      const workloadIdsByServiceName = new Map<string, string[]>();
      const lineByWorkloadId = new Map<string, number>();

      for (const { doc: w, line } of workloads) {
        const name = w.metadata?.name;
        if (!name) continue;
        const image = primaryImage(w);
        const isBatch = w.kind === 'Job' || w.kind === 'CronJob';
        const nodeType = isBatch ? 'worker' : image ? inferTypeFromImage(image).type : 'service';
        const id = `k8s_${name}`; // pre-canonical placeholder; canonicalizeIds() below assigns the real id
        workloadIdByName.set(name, id);
        lineByWorkloadId.set(id, line);
        nodes.push(withProvenance({ id, type: nodeType, name, config: { k8sKind: w.kind } }, prov(line)));
      }

      for (const { doc: s } of services) {
        const name = s.metadata?.name;
        if (!name) continue;
        const matched = workloads
          .filter(({ doc: w }) => selectorMatches(s.spec?.selector, podLabelsOf(w)))
          .map(({ doc: w }) => workloadIdByName.get(w.metadata?.name ?? ''))
          .filter((id): id is string => !!id);
        if (matched.length > 0) workloadIdsByServiceName.set(name, matched);
      }

      for (const { doc: w } of workloads) {
        const fromId = workloadIdByName.get(w.metadata?.name ?? '');
        if (!fromId) continue;
        const fromLine = lineByWorkloadId.get(fromId) ?? 1;
        const env = podEnv(w);

        for (const key of CONNECTION_ENV_KEYS) {
          const val = env[key];
          const host = val ? connectionUrlHost(val) : null;
          if (!host) continue;
          for (const toId of resolveHostToIds(host, workloadIdsByServiceName, workloadIdByName)) {
            if (toId === fromId) continue;
            edges.push(
              withProvenance(
                { id: `e_${fromId}_${toId}_${key}`, from: fromId, to: toId, metadata: { relation: 'connectionUrl', protocol: 'tcp', async: false, env: key } },
                prov(fromLine),
              ),
            );
          }
        }
        for (const key of HOST_ONLY_ENV_KEYS) {
          const val = env[key];
          const host = val ? composePlainEnvHostname(val) : null;
          if (!host) continue;
          for (const toId of resolveHostToIds(host, workloadIdsByServiceName, workloadIdByName)) {
            if (toId === fromId) continue;
            edges.push(
              withProvenance(
                { id: `e_${fromId}_${toId}_${key}`, from: fromId, to: toId, metadata: { relation: 'connectionUrl', protocol: 'tcp', async: false, env: key } },
                prov(fromLine),
              ),
            );
          }
        }
      }

      for (const { doc: ing, line } of ingresses) {
        const name = ing.metadata?.name;
        if (!name) continue;
        const gwId = `k8s_ing_${name}`;
        nodes.push(withProvenance({ id: gwId, type: 'gateway', name, config: { k8sKind: 'Ingress' } }, prov(line)));

        const backendNames = new Set<string>();
        for (const rule of ing.spec?.rules ?? []) {
          for (const p of rule.http?.paths ?? []) {
            const svcName = p.backend?.service?.name ?? p.backend?.serviceName;
            if (typeof svcName === 'string') backendNames.add(svcName);
          }
        }
        for (const svcName of backendNames) {
          for (const toId of workloadIdsByServiceName.get(svcName) ?? []) {
            edges.push(
              withProvenance(
                { id: `e_${gwId}_${toId}`, from: gwId, to: toId, metadata: { relation: 'routes', protocol: 'http', async: false } },
                prov(line),
              ),
            );
          }
        }
      }

      const canon = canonicalizeIds(nodes, edges);
      partials.push({ extractor: 'kubernetes', nodes: canon.nodes, edges: canon.edges, warnings: [] });
    }

    return partials;
  },
};
