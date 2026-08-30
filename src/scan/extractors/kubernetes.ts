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
import { basename } from 'node:path';
import type { Extractor, PartialIR } from '../types.js';
import { canonicalizeIds } from '../node-id.js';
import { provenanceEntry, withProvenance } from '../provenance.js';
import {
  inferTypeFromImage,
  connectionUrlHost,
  composePlainEnvHostname,
  addressEnvHost,
  ADDRESS_SHAPED_KEY,
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
type EnvFromSource = { configMapRef?: { name?: string }; secretRef?: { name?: string } };
type Probe = { httpGet?: { path?: string }; grpc?: { port?: number }; tcpSocket?: { port?: number | string } };
type PodSpec = { containers?: { image?: string; env?: EnvVar[]; envFrom?: EnvFromSource[]; command?: string[]; args?: string[]; readinessProbe?: Probe; livenessProbe?: Probe; startupProbe?: Probe }[] };
type K8sDoc = {
  kind?: string;
  apiVersion?: string;
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> };
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
type Entry = { doc: K8sDoc; file: string; line: number; namespace: string };
type ResolvedEnvVar = { raw: EnvVar; value?: string; configMaps: Entry[] };

const declaredNamespace = (doc: K8sDoc): string | undefined =>
  typeof doc.metadata?.namespace === 'string' && doc.metadata.namespace.trim()
    ? doc.metadata.namespace.trim()
    : undefined;
const resourceKey = (namespace: string, name: string): string => `${namespace}\0${name}`;

function parentPath(relPath: string): string {
  const normalized = relPath.replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index < 0 ? '.' : normalized.slice(0, index);
}

function inheritedKustomizeNamespace(file: string, namespacesByDir: Map<string, string>): string | undefined {
  let dir = parentPath(file);
  while (true) {
    const namespace = namespacesByDir.get(dir);
    if (namespace) return namespace;
    if (dir === '.') return undefined;
    dir = parentPath(dir);
  }
}

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
      RECOGNIZED_KINDS.has((d as K8sDoc).kind as string) &&
      // A Helm template's `name: {{ include "chart.fullname" . }}` parses as a
      // flow mapping, not a string, and stringifying it named the component
      // "[object Object]". If we cannot read a document's name we cannot
      // identify what it describes, so we do not pretend to.
      typeof (d as K8sDoc).metadata?.name === 'string'
    ) {
      out.push({ doc: d as K8sDoc, file: relPath, line: starts[i] ?? 1, namespace: declaredNamespace(d as K8sDoc) ?? 'default' });
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

/**
 * The containers of a pod spec, but only if the YAML actually gave us a list.
 *
 * Hand-written manifests drop the list dash — `containers:` followed directly by
 * `image:`/`name:` parses as a mapping, and iterating it threw, aborting the
 * whole scan over one bad file. A scanner reads other people's repositories:
 * malformed input is normal, and the only safe response is to skip the shape we
 * cannot read and keep going.
 */
function containersOf(doc: K8sDoc): NonNullable<PodSpec['containers']> {
  const containers = podSpecOf(doc)?.containers;
  return Array.isArray(containers) ? containers.filter((c) => c && typeof c === 'object') : [];
}

function primaryImage(doc: K8sDoc): string | undefined {
  return containersOf(doc)[0]?.image;
}

function healthSignals(doc: K8sDoc): string[] {
  const signals = new Set<string>();
  for (const container of containersOf(doc)) {
    for (const probe of [container.readinessProbe, container.livenessProbe, container.startupProbe]) {
      if (!probe) continue;
      if (typeof probe.httpGet?.path === 'string') signals.add(probe.httpGet.path);
      else if (probe.grpc) signals.add('grpc-probe');
      else if (probe.tcpSocket) signals.add('tcp-probe');
    }
  }
  return [...signals].sort();
}

/** Every env var across all containers, flattened (later containers win on key collision). Raw — value or valueFrom. */
function unambiguousConfigMapValues(entries: Entry[]): Map<string, { value: string; sources: Entry[] }> {
  const candidates = new Map<string, { values: Set<string>; sources: Entry[] }>();
  for (const entry of entries) {
    const values = { ...(entry.doc.data ?? {}), ...(entry.doc.stringData ?? {}) };
    for (const [key, value] of Object.entries(values)) {
      if (typeof value !== 'string') continue;
      const item = candidates.get(key) ?? { values: new Set<string>(), sources: [] };
      item.values.add(value);
      item.sources.push(entry);
      candidates.set(key, item);
    }
  }
  const resolved = new Map<string, { value: string; sources: Entry[] }>();
  for (const [key, item] of candidates) {
    if (item.values.size === 1) resolved.set(key, { value: [...item.values][0]!, sources: item.sources });
  }
  return resolved;
}

/** Resolve envFrom first, then explicit env entries (Kubernetes precedence). */
function podEnvVars(
  doc: K8sDoc,
  namespace: string,
  configMapsByResource: Map<string, Entry[]>,
): Record<string, ResolvedEnvVar> {
  const env: Record<string, ResolvedEnvVar> = {};
  for (const c of containersOf(doc)) {
    if (Array.isArray(c.envFrom)) {
      for (const source of c.envFrom) {
        const name = source?.configMapRef?.name;
        if (typeof name !== 'string' || !name) continue;
        const entries = configMapsByResource.get(resourceKey(namespace, name)) ?? [];
        for (const [key, resolved] of unambiguousConfigMapValues(entries)) {
          env[key] = {
            raw: { name: key, value: resolved.value },
            value: resolved.value,
            configMaps: resolved.sources,
          };
        }
      }
    }
    if (!Array.isArray(c.env)) continue;
    for (const e of c.env) {
      if (!e || typeof e.name !== 'string') continue;
      let value = typeof e.value === 'string' ? e.value : undefined;
      let configMaps: Entry[] = [];
      const ref = e.valueFrom?.configMapKeyRef;
      if (value === undefined && typeof ref?.name === 'string' && typeof ref.key === 'string') {
        const resolved = unambiguousConfigMapValues(
          configMapsByResource.get(resourceKey(namespace, ref.name)) ?? [],
        ).get(ref.key);
        value = resolved?.value;
        configMaps = resolved?.sources ?? [];
      }
      env[e.name] = { raw: e, value, configMaps };
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
  for (const c of containersOf(doc)) {
    const command = Array.isArray(c.command) ? c.command : [];
    const args = Array.isArray(c.args) ? c.args : [];
    for (const token of [...command, ...args]) {
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
  callerNamespace: string,
  workloadIdsByServiceName: Map<string, string[]>,
  workloadIdByResource: Map<string, string>,
): string[] {
  const parts = host.split('.');
  const shortName = parts[0] ?? host;
  const namespace = parts.length >= 2 && parts[1] !== 'svc' ? parts[1]! : callerNamespace;
  const key = resourceKey(namespace, shortName);
  if (workloadIdsByServiceName.has(key)) return workloadIdsByServiceName.get(key)!;
  const direct = workloadIdByResource.get(key);
  return direct ? [direct] : [];
}

/**
 * Resolve an env var to a plain string value where possible: literal `value`,
 * or a `configMapKeyRef` pointing at a `ConfigMap` present anywhere in the
 * scan with a literal `data`/`stringData` entry for that key. Returns
 * `undefined` when unresolvable (including every `secretKeyRef` — see the
 * module doc / SPEC §3.1 for why that's deliberate, not an oversight).
 */

export const kubernetesExtractor: Extractor = {
  name: 'kubernetes',
  defaultConfidence: 'high',
  extract(tree): PartialIR[] {
    const warnings: string[] = [];

    // Kustomize applies `namespace:` at render time, so the resource YAML often
    // has no metadata.namespace. Capture the nearest enclosing kustomization;
    // explicit resource namespaces still win below.
    const kustomizeNamespacesByDir = new Map<string, string>();
    for (const file of tree.files) {
      if (!/^kustomization\.ya?ml$/i.test(basename(file.relPath))) continue;
      try {
        const parsed = yaml.load(tree.read(file.relPath), { schema: JSON_SCHEMA });
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        const record = parsed as Record<string, unknown>;
        if (record.kind !== 'Kustomization' || typeof record.namespace !== 'string' || !record.namespace.trim()) continue;
        kustomizeNamespacesByDir.set(parentPath(file.relPath), record.namespace.trim());
      } catch {
        // An unreadable kustomization must not suppress otherwise valid manifests.
      }
    }

    // ---- Pass 1: collect every recognized document across the whole tree ----
    const allEntries: Entry[] = [];
    for (const file of tree.files) {
      if (!isYamlFile(file.relPath)) continue;
      const text = tree.read(file.relPath);
      if (!text.trim()) continue;
      allEntries.push(...loadK8sDocs(text, file.relPath));
    }
    for (const entry of allEntries) {
      if (!declaredNamespace(entry.doc)) {
        entry.namespace = inheritedKustomizeNamespace(entry.file, kustomizeNamespacesByDir) ?? 'default';
      }
    }
    if (allEntries.length === 0) return [];

    const workloads = allEntries.filter((e) => WORKLOAD_KINDS.has(e.doc.kind as string));
    const services = allEntries.filter((e) => e.doc.kind === 'Service');
    const ingresses = allEntries.filter((e) => e.doc.kind === 'Ingress');
    const configMaps = allEntries.filter((e) => e.doc.kind === 'ConfigMap');
    if (workloads.length === 0 && ingresses.length === 0) return [];

    const configMapsByResource = new Map<string, Entry[]>();
    for (const entry of configMaps) {
      const cm = entry.doc;
      const name = cm.metadata?.name;
      if (!name) continue;
      const key = resourceKey(entry.namespace, name);
      const group = configMapsByResource.get(key) ?? [];
      group.push(entry);
      configMapsByResource.set(key, group);
    }

    const nodes: Record<string, unknown>[] = [];
    const edges: Record<string, unknown>[] = [];
    const prov = (file: string, line: number) => provenanceEntry('kubernetes', file, line, 'high');

    // ---- Pass 2: workload nodes ----
    const workloadIdByResource = new Map<string, string>();
    const workloadLoc = new Map<string, { file: string; line: number }>();
    for (const { doc: w, file, line, namespace } of workloads) {
      const name = w.metadata?.name;
      if (!name) continue;
      const image = primaryImage(w);
      const isBatch = w.kind === 'Job' || w.kind === 'CronJob';
      const nodeType = isBatch ? 'worker' : image ? inferTypeFromImage(image).type : 'service';
      const id = `k8s_${name}`; // pre-canonical placeholder; canonicalizeIds() below assigns the real id
      workloadIdByResource.set(resourceKey(namespace, name), id);
      workloadLoc.set(id, { file, line });
      const probes = healthSignals(w);
      nodes.push(withProvenance({
        id, type: nodeType, name,
        config: { k8sKind: w.kind, ...(probes.length ? { healthSignals: probes } : {}) },
      }, prov(file, line)));
    }

    /** Node type by id, for choosing an edge relation that matches what the target is. */
    const nodeTypeById = new Map<string, string>();
    for (const n of nodes) {
      if (typeof n.id === 'string') nodeTypeById.set(n.id, typeof n.type === 'string' ? n.type : '');
    }

    // ---- Pass 3: Service -> workload(s) alias, across the whole scan ----
    const workloadIdsByServiceName = new Map<string, string[]>();
    for (const serviceEntry of services) {
      const s = serviceEntry.doc;
      const name = s.metadata?.name;
      if (!name) continue;
      const matched = workloads
        .filter((workload) => workload.namespace === serviceEntry.namespace && selectorMatches(s.spec?.selector, podLabelsOf(workload.doc)))
        .map((workload) => workloadIdByResource.get(resourceKey(workload.namespace, workload.doc.metadata?.name ?? '')))
        .filter((id): id is string => !!id);
      if (matched.length > 0) workloadIdsByServiceName.set(resourceKey(serviceEntry.namespace, name), matched);
    }

    // ---- Pass 4: connection edges from workload env vars ----
    const CONNECTION_KEY_SET = new Set<string>([...CONNECTION_ENV_KEYS, ...HOST_ONLY_ENV_KEYS]);
    for (const { doc: w, namespace } of workloads) {
      const fromId = workloadIdByResource.get(resourceKey(namespace, w.metadata?.name ?? ''));
      if (!fromId) continue;
      const loc = workloadLoc.get(fromId)!;
      const envVars = podEnvVars(w, namespace, configMapsByResource);

      for (const key of CONNECTION_ENV_KEYS) {
        const ev = envVars[key];
        if (!ev) continue;
        const resolved = ev.value;
        const host = resolved ? connectionUrlHost(resolved) : null;
        if (host) {
          for (const toId of resolveHostToIds(host, namespace, workloadIdsByServiceName, workloadIdByResource)) {
            if (toId === fromId) continue;
            let edge = withProvenance(
                { id: `e_${fromId}_${toId}_${key}`, from: fromId, to: toId, metadata: { relation: 'connectionUrl', protocol: 'tcp', async: false, env: key } },
                prov(loc.file, loc.line),
              );
            for (const source of ev.configMaps) edge = withProvenance(edge, prov(source.file, source.line));
            edges.push(edge);
          }
        } else if (!resolved && ev.raw.valueFrom?.secretKeyRef) {
          warnings.push(
            `${loc.file}:${loc.line}: "${w.metadata?.name}" env "${key}" is wired via a Secret — connection likely present but not detectable from the manifest`,
          );
        }
      }
      for (const key of HOST_ONLY_ENV_KEYS) {
        const ev = envVars[key];
        if (!ev) continue;
        const resolved = ev.value;
        const host = resolved ? composePlainEnvHostname(resolved) : null;
        if (host) {
          for (const toId of resolveHostToIds(host, namespace, workloadIdsByServiceName, workloadIdByResource)) {
            if (toId === fromId) continue;
            let edge = withProvenance(
                { id: `e_${fromId}_${toId}_${key}`, from: fromId, to: toId, metadata: { relation: 'connectionUrl', protocol: 'tcp', async: false, env: key } },
                prov(loc.file, loc.line),
              );
            for (const source of ev.configMaps) edge = withProvenance(edge, prov(source.file, source.line));
            edges.push(edge);
          }
        } else if (!resolved && ev.raw.valueFrom?.secretKeyRef) {
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
      // Seeded with whatever the two keyed loops above already linked, so the
      // value-matched rules below cannot restate an edge under a second id.
      const linkedTargets = new Set<string>(
        edges.filter((e) => e.from === fromId).map((e) => String(e.to)),
      );
      for (const [key, ev] of Object.entries(envVars)) {
        if (CONNECTION_KEY_SET.has(key)) continue; // already handled above
        const resolved = ev.value;
        if (!resolved) continue;
        const hasExplicitPort = /:\d{1,5}(?:$|\/)/.test(resolved.trim());
        if (!hasExplicitPort && !ADDRESS_SHAPED_KEY.test(key)) continue;
        // Shared with the compose tier: reads `svc:7070` AND `http://svc:4317`.
        const host = addressEnvHost(resolved);
        if (!host) continue;
        for (const toId of resolveHostToIds(host, namespace, workloadIdsByServiceName, workloadIdByResource)) {
          if (toId === fromId || linkedTargets.has(toId)) continue;
          linkedTargets.add(toId);
          const targetType = String(nodeTypeById.get(toId) ?? '');
          // A datastore reached this way is still a connection; anything else is a call.
          const relation =
            isDbLikeType(targetType) || isQueueLikeNodeType(targetType) || targetType === 'cache'
              ? 'connectionUrl'
              : 'serviceCall';
          let edge = withProvenance(
              {
                id: `e_${fromId}_${toId}_${key}`,
                from: fromId,
                to: toId,
                metadata: { relation, protocol: 'tcp', async: false, env: key },
              },
              prov(loc.file, loc.line),
            );
          for (const source of ev.configMaps) edge = withProvenance(edge, prov(source.file, source.line));
          edges.push(edge);
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
        for (const toId of resolveHostToIds(host, namespace, workloadIdsByServiceName, workloadIdByResource)) {
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
        if (!ev.raw.valueFrom?.secretKeyRef) continue;
        if (!/url|uri|host|connection/i.test(key)) continue;
        warnings.push(
          `${loc.file}:${loc.line}: "${w.metadata?.name}" env "${key}" is wired via a Secret — connection likely present but not detectable from the manifest`,
        );
      }
    }

    // ---- Pass 5: Ingress -> backend edges, across the whole scan ----
    for (const { doc: ing, file, line, namespace } of ingresses) {
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
        for (const toId of workloadIdsByServiceName.get(resourceKey(namespace, svcName)) ?? []) {
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
