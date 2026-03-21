/**
 * Golden-path assets: IR-aligned OpenAPI is supplied by the caller (deterministic exporter).
 * This module only applies Docker Compose, Dockerfile, Makefile, README section, and port patches.
 *
 * `hostPort` is the machine port (left side of docker publish). Container listens on 8080.
 */

export type GoldenLayerOptions = {
  /** Host port for `docker compose` publish (default 8080). Container port stays 8080. */
  hostPort?: number;
};

function fastApiCompose(hostPort: number): string {
  return `version: '3.8'

services:
  api:
    build: .
    ports:
      - "${hostPort}:8080"
    volumes:
      - .:/app
    command: uvicorn app.main:app --host 0.0.0.0 --port 8080 --reload
    environment:
      - PYTHONUNBUFFERED=1
`;
}

const GOLDEN_DOCKERFILE = `FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8080
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
`;

function nodeCompose(hostPort: number): string {
  return `version: '3.8'

services:
  api:
    build: .
    ports:
      - "${hostPort}:8080"
    volumes:
      - .:/app
    working_dir: /app
    command: sh -c "npm install && node --watch app/index.js"
    environment:
      - PORT=8080
      - NODE_ENV=development
`;
}

const GOLDEN_NODE_DOCKERFILE = `FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json ./
RUN npm install
COPY . .
EXPOSE 8080
ENV PORT=8080
CMD ["node", "app/index.js"]
`;

const GOLDEN_MAKEFILE = `.PHONY: run dev install
install:
	pip install -r requirements.txt

# One command to hide Docker details (golden demo)
run:
	docker compose up --build

dev: run
`;

const GOLDEN_NODE_MAKEFILE = `.PHONY: run install
install:
	npm install

run:
	docker compose up --build

dev: run
`;

const README_GOLDEN_MARKER = '<!-- ARCHRAD_GOLDEN_PATH -->';

export type GoldenStack = 'fastapi' | 'express';

function appendGoldenReadmeSection(
  readme: string,
  stack: GoldenStack = 'fastapi',
  hostPort: number = 8080
): string {
  const hp = hostPort;
  const validationBlurb =
    stack === 'express'
      ? `Try validation on a signup-style POST (empty body should fail schema checks):

\`\`\`bash
curl -sS -X POST http://localhost:${hp}/signup -H "Content-Type: application/json" -d '{}'
\`\`\`

Expect **400 Bad Request** (or **422** if mapped) with **details** when routes use Ajv/OpenAPI-style validation — field errors should list missing/invalid keys.`
      : `Try validation on a signup-style POST (empty body should fail FastAPI/Pydantic checks):

\`\`\`bash
curl -sS -X POST http://localhost:${hp}/signup -H "Content-Type: application/json" -d '{}'
\`\`\`

Expect **422 Unprocessable Entity** (default FastAPI) or **400** if routes use custom validation — field errors should list missing/invalid keys.`;

  const section = `

${README_GOLDEN_MARKER}
## Golden path (local API, ~60s)

\`\`\`bash
make run
# or: docker compose up --build
\`\`\`

Service listens on **http://localhost:${hp}** (maps host **${hp}** → container **8080**; hot reload: **FastAPI** = uvicorn --reload; **Express** = \`node --watch\` in compose).

${validationBlurb}

OpenAPI contract for this blueprint (IR-aligned) is in \`openapi.yaml\` at the project root.

### Zero lock-in

Generated services are **standard FastAPI or Express** stacks. They run with **Docker Compose** and **no ArchRad runtime**. If your org enabled optional policy SDK injection during export, remove \`sdk/archrad_*\` and related middleware—or set \`ARCHRAD_POLICY_SERVICE_URL\` empty—see upstream \`EXPORT_LOCK_IN_AUDIT.md\` in the main product repo.
`;
  if (readme.includes(README_GOLDEN_MARKER)) return readme;
  return (readme || '').trimEnd() + section;
}

/** Normalize generated main.py uvicorn port to 8080 if present. */
export function patchMainPyPort8080(content: string): string {
  return content
    .replace(/uvicorn\.run\(\s*app\s*,\s*host=['"]0\.0\.0\.0['"]\s*,\s*port\s*=\s*8000\s*\)/g, "uvicorn.run(app, host='0.0.0.0', port=8080)")
    .replace(/port\s*=\s*8000/g, 'port=8080');
}

/** Merge golden Docker/Makefile/README into an existing FastAPI file map. Caller must already set openapi.yaml from the deterministic exporter. */
export function applyFastApiGoldenLayer(
  filesMap: Record<string, string>,
  options: GoldenLayerOptions = {}
): void {
  const hostPort = options.hostPort ?? 8080;
  filesMap['docker-compose.yml'] = fastApiCompose(hostPort);
  filesMap['Dockerfile'] = GOLDEN_DOCKERFILE;
  filesMap['Makefile'] = GOLDEN_MAKEFILE;

  if (filesMap['app/main.py']) {
    filesMap['app/main.py'] = patchMainPyPort8080(filesMap['app/main.py']);
  }
  filesMap['README.md'] = appendGoldenReadmeSection(
    filesMap['README.md'] || '# Generated API\n',
    'fastapi',
    hostPort
  );
}

/** Normalize Express entry to listen on 8080 by default. */
export function patchExpressIndexPort8080(content: string): string {
  return content
    .replace(/process\.env\.PORT\s*\|\|\s*3000/g, 'Number(process.env.PORT) || 8080')
    .replace(/Number\(process\.env\.PORT\)\s*\|\|\s*3000/g, 'Number(process.env.PORT) || 8080');
}

export function mergePackageJsonScripts(pkg: string): string {
  try {
    const j = JSON.parse(pkg) as { scripts?: Record<string, string> };
    j.scripts = j.scripts || {};
    if (!j.scripts.start) j.scripts.start = 'node app/index.js';
    j.scripts.dev = 'node --watch app/index.js';
    return JSON.stringify(j, null, 2);
  } catch {
    return pkg;
  }
}

/** Golden layer for Express: expects openapi.yaml (and app files) from caller when available. */
export function applyNodeExpressGoldenLayer(
  filesMap: Record<string, string>,
  options: GoldenLayerOptions = {}
): void {
  const hostPort = options.hostPort ?? 8080;
  filesMap['docker-compose.yml'] = nodeCompose(hostPort);
  filesMap['Dockerfile'] = GOLDEN_NODE_DOCKERFILE;
  filesMap['Makefile'] = GOLDEN_NODE_MAKEFILE;

  if (filesMap['app/index.js']) {
    filesMap['app/index.js'] = patchExpressIndexPort8080(filesMap['app/index.js']);
  }
  if (filesMap['package.json']) {
    filesMap['package.json'] = mergePackageJsonScripts(filesMap['package.json']);
  }

  filesMap['README.md'] = appendGoldenReadmeSection(
    filesMap['README.md'] || '# Generated Express API\n',
    'express',
    hostPort
  );
}
