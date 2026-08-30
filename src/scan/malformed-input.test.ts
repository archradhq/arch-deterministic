/**
 * Malformed-input survival for `archrad scan`.
 *
 * A scanner reads other people's repositories, so malformed and templated input
 * is normal rather than exceptional. Two production defects came from assuming
 * otherwise: argo-cd ships a manifest whose `containers:` is a mapping instead
 * of a list, which threw a TypeError and aborted the entire scan; and a Helm
 * template's `name: {{ include "chart.fullname" . }}` parses as a flow mapping,
 * which stringified into a component called "[object Object]".
 *
 * Both were found by scanning a new repository, one at a time. This table exists
 * so the next one is found here instead. Every case asserts the same two things:
 * we do not crash, and we never name a component something that is not a name.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanCodebase } from './scan.js';

const root = mkdtempSync(join(tmpdir(), 'archrad-malformed-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A Deployment whose pod spec body is supplied by the case. */
const pod = (body: string): string =>
  `apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: x\nspec:\n  template:\n    spec:\n${body}`;

const cases: Record<string, [file: string, content: string]> = {
  // ---- Kubernetes: collections written as something else -------------------
  'containers as a mapping': ['d.yaml', pod('      containers:\n        image: i\n        name: c\n')],
  'containers as a scalar': ['d.yaml', pod('      containers: "c"\n')],
  'containers null': ['d.yaml', pod('      containers:\n')],
  'container item a scalar': ['d.yaml', pod('      containers:\n        - "just-a-string"\n')],
  'container item null': ['d.yaml', pod('      containers:\n        - \n')],
  'env as a mapping': ['d.yaml', pod('      containers:\n        - name: c\n          image: i\n          env:\n            KEY: value\n')],
  'env item without a name': ['d.yaml', pod('      containers:\n        - name: c\n          image: i\n          env:\n            - value: v\n')],
  'env name is a mapping': ['d.yaml', pod('      containers:\n        - name: c\n          image: i\n          env:\n            - name: {a: b}\n              value: v\n')],
  'envFrom as a mapping': ['d.yaml', pod('      containers:\n        - name: c\n          image: i\n          envFrom:\n            configMapRef:\n              name: cfg\n')],
  'envFrom item a scalar': ['d.yaml', pod('      containers:\n        - name: c\n          image: i\n          envFrom:\n            - cfg\n')],
  'args as a mapping': ['d.yaml', pod('      containers:\n        - name: c\n          image: i\n          args:\n            flag: v\n')],
  'args item a mapping': ['d.yaml', pod('      containers:\n        - name: c\n          image: i\n          args:\n            - {a: b}\n')],

  // ---- Kubernetes: Helm templating and other unreadable names --------------
  'templated metadata.name': ['d.yaml', 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {{ include "x" . }}\nspec: {}\n'],
  'templated image': ['d.yaml', pod('      containers:\n        - name: c\n          image: {{ .Values.img }}\n')],
  'metadata a scalar': ['d.yaml', 'apiVersion: apps/v1\nkind: Deployment\nmetadata: "oops"\nspec: {}\n'],
  'labels a list': ['d.yaml', 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: x\n  labels:\n    - a\nspec: {}\n'],
  'spec a scalar': ['d.yaml', 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: x\nspec: "oops"\n'],
  'CronJob jobTemplate a scalar': ['c.yaml', 'apiVersion: batch/v1\nkind: CronJob\nmetadata:\n  name: c\nspec:\n  jobTemplate: "oops"\n'],
  'Service ports a scalar': ['s.yaml', 'apiVersion: v1\nkind: Service\nmetadata:\n  name: s\nspec:\n  ports: "80"\n  selector: "app"\n'],
  'Ingress rules a scalar': ['i.yaml', 'apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: i\nspec:\n  rules: "oops"\n'],
  'self-referential anchor': ['d.yaml', 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: x\nspec: &a\n  template: *a\n'],
  'duplicate keys': ['d.yaml', 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: a\n  name: b\nspec: {}\n'],
  'tabs for indentation': ['d.yaml', 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n\tname: x\n'],

  // ---- Compose --------------------------------------------------------------
  'compose services a list': ['docker-compose.yml', 'services:\n  - api\n  - web\n'],
  'compose service a scalar': ['docker-compose.yml', 'services:\n  api: "just a string"\n'],
  'compose service null': ['docker-compose.yml', 'services:\n  api:\n'],
  'compose ports a mapping': ['docker-compose.yml', 'services:\n  api:\n    image: a/b\n    ports:\n      host: 8080\n'],
  'compose environment a scalar': ['docker-compose.yml', 'services:\n  api:\n    image: a/b\n    environment: "NOT_A_MAP"\n'],
  'compose env entry without =': ['docker-compose.yml', 'services:\n  api:\n    image: a/b\n    environment:\n      - PLAIN_NO_EQUALS\n'],
  'compose env value null': ['docker-compose.yml', 'services:\n  api:\n    image: a/b\n    environment:\n      KEY:\n'],
  'compose image a mapping': ['docker-compose.yml', 'services:\n  api:\n    image:\n      repo: a/b\n'],
  'compose depends_on a scalar': ['docker-compose.yml', 'services:\n  api:\n    image: a/b\n    depends_on: db\n'],
  'compose root a scalar': ['docker-compose.yml', 'just a string\n'],
  'compose root a list': ['docker-compose.yml', '- a\n- b\n'],

  // ---- OpenAPI --------------------------------------------------------------
  'openapi paths an array': ['openapi.json', '{"openapi":"3.0.0","info":{"title":"t","version":"1"},"paths":[1,2,3]}'],
  'openapi operation a scalar': ['openapi.json', '{"openapi":"3.0.0","info":{"title":"t","version":"1"},"paths":{"/a":{"get":"oops"}}}'],
  'openapi info a scalar': ['openapi.json', '{"openapi":"3.0.0","info":"oops","paths":{}}'],
  'openapi paths null': ['openapi.json', '{"openapi":"3.0.0","info":{"title":"t","version":"1"},"paths":null}'],
  'openapi blank title': ['openapi.json', '{"openapi":"3.0.0","info":{"title":"   ","version":"1"},"paths":{"/a":{"get":{"responses":{}}}}}'],

  // ---- Dependency manifests -------------------------------------------------
  'package.json an array': ['package.json', '[1,2,3]'],
  'package.json name a number': ['package.json', '{"name":123,"dependencies":{"pg":"^8"}}'],
  'package.json deps a scalar': ['package.json', '{"name":"x","dependencies":"pg"}'],
  'pom.xml truncated mid-tag': ['pom.xml', '<project><artifactId>x</artifactId><dependencies><dependency><groupId>org.postgresql'],
  'go.mod without a path': ['go.mod', 'module\n\ngo 1.23\n'],
  'go.mod only slashes': ['go.mod', 'module ///\n'],

  // ---- Terraform ------------------------------------------------------------
  'terraform unbalanced braces': ['main.tf', 'resource "aws_db_instance" "this" {\n  name = "x"\n'],
  'terraform empty labels': ['main.tf', 'resource "" "" {}\n'],
};

describe('scanCodebase — malformed and templated input', () => {
  for (const [label, [file, content]] of Object.entries(cases)) {
    it(`survives: ${label}`, async () => {
      const dir = join(root, label.replace(/[^a-z0-9]+/gi, '-'));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, file), content);

      // Must not throw: one unreadable file used to abort the whole scan.
      const result = await scanCodebase({ from: dir });

      // Must not invent a name out of something that is not one.
      for (const node of result.ir.graph.nodes as { name: unknown }[]) {
        expect(typeof node.name).toBe('string');
        expect(node.name as string).not.toMatch(/\[object|^undefined$|^null$|^\{|\}$/);
        expect((node.name as string).trim()).not.toBe('');
      }
    });
  }
});
