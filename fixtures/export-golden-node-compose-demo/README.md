# generated-express

Generated Express app.

Run:

    npm install
    npm start

<!-- ARCHRAD_GOLDEN_PATH -->
## Golden path (local API, ~60s)

```bash
make run
# or: docker compose up --build
```

Service listens on **http://localhost:8080** (maps host **8080** → container **8080**; hot reload: **FastAPI** = uvicorn --reload; **Express** = `node --watch` in compose).

Try validation on a signup-style POST (empty body should fail schema checks):

```bash
curl -sS -X POST http://localhost:8080/signup -H "Content-Type: application/json" -d '{}'
```

Expect **400 Bad Request** (or **422** if mapped) with **details** when routes use Ajv/OpenAPI-style validation — field errors should list missing/invalid keys.

OpenAPI contract for this blueprint (IR-aligned) is in `openapi.yaml` at the project root.

### Zero lock-in

Generated services are **standard FastAPI or Express** stacks. They run with **Docker Compose** and **no ArchRad runtime**. If your org enabled optional policy SDK injection during export, remove `sdk/archrad_*` and related middleware—or set `ARCHRAD_POLICY_SERVICE_URL` empty—see upstream `EXPORT_LOCK_IN_AUDIT.md` in the main product repo.
