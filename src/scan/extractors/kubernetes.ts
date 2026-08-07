/**
 * Topology extractor: Kubernetes manifests → PartialIR (confidence: high).
 *
 * Unlike compose, k8s manifests have no fixed filename — detected by CONTENT:
 * any YAML document with both `apiVersion` and a recognized `kind`. Reuses
 * `inferTypeFromImage()`, `connectionUrlHost()`, `composePlainEnvHostname()`,
 * and the `CONNECTION_ENV_KEYS`/`HOST_ONLY_ENV_KEYS` constants from the `init`
 * docker-compose path, so a Postgres StatefulSet and a Postgres Compose service
 * classify identically. See docs/SPEC-scan.md §3.1 for the full design.
 *
 * Resolution (Service→workload, Ingress→backend, ConfigMap→env value) runs
 * across the WHOLE scanned tree, not per file — the most common real-world k8s
 * layout is one resource per file, and resolving per-file would silently miss
 * every cross-file reference.
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
import { isDbLikeType, isQueueLikeNodeType } from '../../graphPredicates.js';

const JSON_SCHEMA = yaml.JSON_SCHEMA;

const WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'Pod', 'Job', 'CronJob']);
const RECOGNIZED_KINDS = new Set([...WORKLOAD_KINDS, 'Service', 'Ingress', 'ConfigMap']);

type EnvVar = {
  name?: string;
  value?: string;
  valueFrom?: {
    configMapKeyRef?: { name?: string; key?: string };
    secretKeyRef?: { name?: string; key?: string };
  };
};
type PodSpec = { containers?: { image?: string; env?: EnvVar[]; command?: string[]; args?: string[] }[] };
type K8sDoc = {
  kind?: string;
  apiVersion?: string;
  metadata?: { name?: string; labels?: Record<string, string> };
  data?: Record<string, string>;
  stringData?: Record<string, string>;
  spec?: {
    selector?: Record<string, string>;
    template?: { metadata?: { labels?: Record<string, string> }; spec?: PodSpec };
    jobTemplate?: { spec?: { template?: { metadata?: { labels?: Record<string, string> }; spec?: PodSpec } } };
    rules?: { http?: { paths?: { backend?: { service?: { name?: string }; serviceName?: string } }[] } }[];
  } & PodSpec;
};

/** One recognized k8s document, tagged with where it came from. */
type Entry = { doc: K8sDoc; file: string; line: number };

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

/** Parse every YAML document in `text`, keeping only recognized k8s manifests, tagged with file + start line. */
function loadK8sDocs(text: string, relPath: string): Entry[] {
  const docs: unknown[] = [];
  try {
    yaml.loadAll(text, (d) => docs.push(d), { schema: JSON_SCHEMA });
  } catch {
    return [];
  }
  const starts = documentStartLines(text);
  const out: Entry[] = [];
  docs.forEach((d, i) => {
    if (
      d &&
      typeof d === 'object' &&
      !Array.isArray(d) &&
      typeof (d as K8sDoc).kind === 'string' &&
      typeof (d as K8sDoc).apiVersion === 'string' &&
      RECOGNIZED_KINDS.has((d as K8sDoc).kind as string)
    ) {
      out.push({ doc: d as K8sDoc, file: relPath, line: starts[i] ?? 1 });
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

/** Every env var across all containers, flattened (later containers win on key collision). Raw — value or valueFrom. */
function podEnvVars(doc: K8sDoc): Record<string, EnvVar> {
  const env: Record<string, EnvVar> = {};
  for (const c of podSpecOf(doc)?.containers ?? []) {
    for (const e of c.env ?? []) {
      if (typeof e.name === 'string') env[e.name] = e;
    }
  }
  return env;
}

/**
 * Every `command`/`args` token across all containers, with a leading `--flag=`
 * stripped, so `--backend-url=http://backend:9898/echo` and the two-token form
 * `--backend-url` `http://backend:9898/echo` both reduce to the bare value.
 */
function podArgValues(doc: K8sDoc): string[] {
  const out: string[] = [];
  for (const c of podSpecOf(doc)?.containers ?? []) {
    for (const token of [...(c.command ?? []), ...(c.args ?? [])]) {
      if (typeof token !== 'string') continue;
      const eq = token.indexOf('=');
      out.push(eq === -1 ? token : token.slice(eq + 1));
    }
  }
  return out;
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

/**
 * Resolve an env var to a plain string value where possible: literal `value`,
 * or a `configMapKeyRef` pointing at a `ConfigMap` present anywhere in the
 * scan with a literal `data`/`stringData` entry for that key. Returns
 * `undefined` when unresolvable (including every `secretKeyRef` — see the
 * module doc / SPEC §3.1 for why that's deliberate, not an oversight).
 */
function resolveEnvValue(
  ev: EnvVar,
  configMapData: Map<string, Record<string, string>>,
): string | undefined {
  if (typeof ev.value === 'string') return ev.value;
  const ref = ev.valueFrom?.configMapKeyRef;
  if (ref?.name && ref.key) {
    return configMapData.get(ref.name)?.[ref.key];
  }
  return undefined;
}

export const kubernetesExtractor: Extractor = {
  name: 'kubernetes',
  defaultConfidence: 'high',
  extract(tree): PartialIR[] {
    const warnings: string[] = [];

    // ---- Pass 1: collect every recognized document across the whole tree ----
    const allEntries: Entry[] = [];
    for (const file of tree.files) {
      if (!isYamlFile(file.relPath)) continue;
      const text = tree.read(file.relPath);
      if (!text.trim()) continue;
      allEntries.push(...loadK8sDocs(text, file.relPath));
    }
    if (allEntries.length === 0) return [];

    const workloads = allEntries.filter((e) => WORKLOAD_KINDS.has(e.doc.kind as string));
    const services = allEntries.filter((e) => e.doc.kind === 'Service');
    const ingresses = allEntries.filter((e) => e.doc.kind === 'Ingress');
    const configMaps = allEntries.filter((e) => e.doc.kind === 'ConfigMap');
    if (workloads.length === 0 && ingresses.length === 0) return [];

    const configMapData = new Map<string, Record<string, string>>();
    for (const { doc: cm } of configMaps) {
      const name = cm.metadata?.name;
      if (!name) continue;
      configMapData.set(name, { ...(cm.data ?? {}), ...(cm.stringData ?? {}) });
    }

    const nodes: Record<string, unknown>[] = [];
    const edges: Record<string, unknown>[] = [];
    const prov = (file: string, line: number) => provenanceEntry('kubernetes', file, line, 'high');

    // ---- Pass 2: workload nodes ----
    const workloadIdByName = new Map<string, string>();
    const workloadLoc = new Map<string, { file: string; line: number }>();
    for (const { doc: w, file, line } of workloads) {
      const name = w.metadata?.name;
      if (!name) continue;
      const image = primaryImage(w);
      const isBatch = w.kind === 'Job' || w.kind === 'CronJob';
      const nodeType = isBatch ? 'worker' : image ? inferTypeFromImage(image).type : 'service';
      const id = `k8s_${name}`; // pre-canonical placeholder; canonicalizeIds() below assigns the real id
      workloadIdByName.set(name, id);
      workloadLoc.set(id, { file, line });
      nodes.push(withProvenance({ id, type: nodeType, name, config: { k8sKind: w.kind } }, prov(file, line)));
    }

    /** Node type by id, for choosing an edge relation that matches what the target is. */
    const nodeTypeById = new Map<string, string>();
    for (const n of nodes) {
      if (typeof n.id === 'string') nodeTypeById.set(n.id, typeof n.type === 'string' ? n.type : '');
    }

    // ---- Pass 3: Service -> workload(s) alias, across the whole scan ----
    const workloadIdsByServiceName = new Map<string, string[]>();
    for (const { doc: s } of services) {
      const name = s.metadata?.name;
      if (!name) continue;
      const matched = workloads
        .filter(({ doc: w }) => selectorMatches(s.spec?.selector, podLabelsOf(w)))
        .map(({ doc: w }) => workloadIdByName.get(w.metadata?.name ?? ''))
        .filter((id): id is string => !!id);
      if (matched.length > 0) workloadIdsByServiceName.set(name, matched);
    }

    // ---- Pass 4: connection edges from workload env vars ----
    const CONNECTION_KEY_SET = new Set<string>([...CONNECTION_ENV_KEYS, ...HOST_ONLY_ENV_KEYS]);
    for (const { doc: w } of workloads) {
      const fromId = workloadIdByName.get(w.metadata?.name ?? '');
      if (!fromId) continue;
      const loc = workloadLoc.get(fromId)!;
      const envVars = podEnvVars(w);

      for (const key of CONNECTION_ENV_KEYS) {
        const ev = envVars[key];
        if (!ev) continue;
        const resolved = resolveEnvValue(ev, configMapData);
        const host = resolved ? connectionUrlHost(resolved) : null;
        if (host) {
          for (const toId of resolveHostToIds(host, workloadIdsByServiceName, workloadIdByName)) {
            if (toId === fromId) continue;
            edges.push(
              withProvenance(
                { id: `e_${fromId}_${toId}_${key}`, from: fromId, to: toId, metadata: { relation: 'connectionUrl', protocol: 'tcp', async: false, env: key } },
                prov(loc.file, loc.line),
              ),
            );
          }
        } else if (!resolved && ev.valueFrom?.secretKeyRef) {
          warnings.push(
            `${loc.file}:${loc.line}: "${w.metadata?.name}" env "${key}" is wired via a Secret — connection likely present but not detectable from the manifest`,
          );
        }
      }
      for (const key of HOST_ONLY_ENV_KEYS) {
        const ev = envVars[key];
        if (!ev) continue;
        const resolved = resolveEnvValue(ev, configMapData);
        const host = resolved ? composePlainEnvHostname(resolved) : null;
        if (host) {
          for (const toId of resolveHostToIds(host, workloadIdsByServiceName, workloadIdByName)) {
            if (toId === fromId) continue;
            edges.push(
              withProvenance(
                { id: `e_${fromId}_${toId}_${key}`, from: fromId, to: toId, metadata: { relation: 'connectionUrl', protocol: 'tcp', async: false, env: key } },
                prov(loc.file, loc.line),
              ),
            );
          }
        } else if (!resolved && ev.valueFrom?.secretKeyRef) {
          warnings.push(
            `${loc.file}:${loc.line}: "${w.metadata?.name}" env "${key}" is wired via a Secret — connection likely present but not detectable from the manifest`,
          );
        }
      }
      // ---- Service-address env vars (`CART_SERVICE_ADDR: cartservice:7070`) ----
      // The loops above match on a fixed KEY list, which covers datastores but not
      // the service-to-service convention every k8s microservice fleet uses: each
      // caller names its callees in arbitrarily-keyed env vars. Missing them left
      // whole fleets extracted as unconnected workloads, then reported as
      // "disconnected subgraph" — our gap described as the user's defect.
      //
      // Matched by VALUE, not key name: an edge is emitted only when the host
      // resolves to a Service or workload found in this same scan, so an
      // unrecognised value can never invent a component. The extra requirement of
      // an explicit port (or an address-shaped key) keeps incidental values like
      // `CACHE_TYPE: redis` from being read as a reference to the redis workload.
      const ADDRESS_SHAPED_KEY = /(_ADDR|_ADDRESS|_ENDPOINT|_SERVICE|_TARGET|_UPSTREAM|_BACKEND)$/i;
      // Seeded with whatever the two keyed loops above already linked, so the
      // value-matched rules below cannot restate an edge under a second id.
      const linkedTargets = new Set<string>(
        edges.filter((e) => e.from === fromId).map((e) => String(e.to)),
      );
      for (const [key, ev] of Object.entries(envVars)) {
        if (CONNECTION_KEY_SET.has(key)) continue; // already handled above
        const resolved = resolveEnvValue(ev, configMapData);
        if (!resolved) continue;
        const hasExplicitPort = /^[^\s/\\]+:\d{1,5}$/.test(resolved.trim());
        if (!hasExplicitPort && !ADDRESS_SHAPED_KEY.test(key)) continue;
        const host = composePlainEnvHostname(resolved);
        if (!host) continue;
        for (const toId of resolveHostToIds(host, workloadIdsByServiceName, workloadIdByName)) {
          if (toId === fromId || linkedTargets.has(toId)) continue;
          linkedTargets.add(toId);
          const targetType = String(nodeTypeById.get(toId) ?? '');
          // A datastore reached this way is still a connection; anything else is a call.
          const relation =
            isDbLikeType(targetType) || isQueueLikeNodeType(targetType) || targetType === 'cache'
              ? 'connectionUrl'
              : 'serviceCall';
          edges.push(
            withProvenance(
              {
                id: `e_${fromId}_${toId}_${key}`,
                from: fromId,
                to: toId,
                metadata: { relation, protocol: 'tcp', async: false, env: key },
              },
              prov(loc.file, loc.line),
            ),
          );
        }
      }

      // ---- Connection edges from container args (`--cache-server=tcp://cache:6379`) ----
      // Every loop above reads `env`, which misses an entire wiring convention: Go
      // and Java services in particular take their peers as command-line flags, so
      // a fleet wired that way extracted as unconnected workloads and was then
      // reported as disconnected subgraphs — our blind spot stated as the user's
      // defect, the same failure the *_SERVICE_ADDR gap caused.
      //
      // The safety property matches the env rule: the value must carry a URL
      // SCHEME and its host must resolve to a Service or workload found in this
      // same scan, so `--level=info` or `--port=9898` can never invent a
      // component. Requiring the scheme is what makes a flag list unnecessary.
      for (const raw of podArgValues(w)) {
        const host = connectionUrlHost(raw);
        if (!host) continue;
        for (const toId of resolveHostToIds(host, workloadIdsByServiceName, workloadIdByName)) {
          if (toId === fromId || linkedTargets.has(toId)) continue;
          linkedTargets.add(toId);
          const targetType = String(nodeTypeById.get(toId) ?? '');
          const relation =
            isDbLikeType(targetType) || isQueueLikeNodeType(targetType) || targetType === 'cache'
              ? 'connectionUrl'
              : 'serviceCall';
          edges.push(
            withProvenance(
              {
                id: `e_${fromId}_${toId}_arg`,
                from: fromId,
                to: toId,
                metadata: { relation, protocol: 'tcp', async: false },
              },
              prov(loc.file, loc.line),
            ),
          );
        }
      }

      // Any other connection-shaped key wired through a Secret is worth flagging too,
      // even outside the known key list — same honesty rationale, lower specificity.
      for (const [key, ev] of Object.entries(envVars)) {
        if (CONNECTION_KEY_SET.has(key)) continue; // already handled above
        if (!ev.valueFrom?.secretKeyRef) continue;
        if (!/url|uri|host|connection/i.test(key)) continue;
        warnings.push(
          `${loc.file}:${loc.line}: "${w.metadata?.name}" env "${key}" is wired via a Secret — connection likely present but not detectable from the manifest`,
        );
      }
    }

    // ---- Pass 5: Ingress -> backend edges, across the whole scan ----
    for (const { doc: ing, file, line } of ingresses) {
      const name = ing.metadata?.name;
      if (!name) continue;
      const gwId = `k8s_ing_${name}`;
      nodes.push(withProvenance({ id: gwId, type: 'gateway', name, config: { k8sKind: 'Ingress' } }, prov(file, line)));

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
              prov(file, line),
            ),
          );
        }
      }
    }

    const canon = canonicalizeIds(nodes, edges);
    return [{ extractor: 'kubernetes', nodes: canon.nodes, edges: canon.edges, warnings }];
  },
};
