# Warm Start Service

The Warm Start Service enables faster consecutive task runs by keeping runner containers "warm" and ready to execute the next task, eliminating cold start overhead.

## Overview

When a task completes, instead of shutting down immediately, the runner container can wait for a new task to execute. This "warm start" approach significantly reduces latency for consecutive runs by reusing the already-initialized container.

The Warm Start Service acts as a matchmaker between:
- **Waiting Workers**: Containers that have completed a task and are waiting for the next one
- **New Runs**: Tasks that need to be executed

## Architecture

```
┌─────────────┐         ┌──────────────────┐         ┌─────────────┐
│  Supervisor │         │  Warm Start      │         │   Worker    │
│             │─POST───▶│    Service       │◀─GET────│ (waiting)   │
│ (new run)   │         │                  │         │             │
└─────────────┘         └──────────────────┘         └─────────────┘
                               │
                               │ Long-polling
                               │ (up to 5 min)
                               ▼
                        ┌──────────────┐
                        │   Registry   │
                        │  (in-memory) │
                        └──────────────┘
```

### How It Works

1. **Worker Registration**: After completing a task, a worker sends a long-polling GET request to `/warm-start` with its deployment info and machine specs
2. **Waiting**: The worker waits for up to 5 minutes (configurable) for a matching run
3. **Run Assignment**: When the supervisor has a new run, it POSTs to `/warm-start` with the run details
4. **Matching**: The service finds a waiting worker that matches the deployment ID, version, and machine specs
5. **Delivery**: The run details are sent to the matched worker, which immediately starts executing
6. **Fallback**: If no match is found or the worker times out, the supervisor creates a new cold-start container

## API Endpoints

### `GET /connect`
Health check endpoint that returns configuration.

**Response:**
```json
{
  "connectionTimeoutMs": 30000,
  "keepaliveMs": 300000
}
```

### `GET /warm-start`
Long-polling endpoint for workers waiting for the next run.

**Headers:**
- `x-trigger-workload-controller-id`: Unique controller ID
- `x-trigger-deployment-id`: Deployment ID
- `x-trigger-deployment-version`: Deployment version
- `x-trigger-machine-cpu`: CPU allocation (e.g., "0.5")
- `x-trigger-machine-memory`: Memory allocation (e.g., "512")
- `x-trigger-worker-instance-name`: Worker instance name

**Response:** `DequeuedMessage` object when a matching run is available, or 204 No Content on timeout

### `POST /warm-start`
Supervisor endpoint to assign a run to a waiting worker.

**Body:**
```json
{
  "dequeuedMessage": {
    "run": { "id": "...", "friendlyId": "..." },
    "deployment": { "id": "...", "version": "..." },
    "machine": { "cpu": "0.5", "memory": "512" },
    ...
  }
}
```

**Response:**
```json
{
  "didWarmStart": true
}
```

### `GET /healthcheck`
Health check with current statistics.

**Response:**
```json
{
  "ok": true,
  "totalWorkers": 5,
  "workersByDeployment": {
    "deploy-123:v1": 3,
    "deploy-456:v2": 2
  }
}
```

### `GET /stats`
Detailed statistics about waiting workers.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3040` | HTTP server port |
| `NODE_ENV` | `production` | Node environment |
| `DEBUG` | `0` | Enable debug logging (0=off, 1=on) |
| `DEFAULT_CONNECTION_TIMEOUT_MS` | `30000` | Connection timeout for long-polling (30s) |
| `DEFAULT_KEEPALIVE_MS` | `300000` | How long workers wait for next run (5 min) |
| `WORKER_TIMEOUT_MS` | `310000` | Worker cleanup timeout (slightly longer than keepalive) |

## Deployment

### Kubernetes (Helm)

Enable the warm start service in your `values.yaml`:

```yaml
warmStartService:
  enabled: true
  replicaCount: 2
  
  service:
    type: ClusterIP
    port: 3040
  
  resources:
    limits:
      cpu: 200m
      memory: 256Mi
    requests:
      cpu: 100m
      memory: 128Mi
```

The service will automatically be available to supervisors at:
```
http://<release>-warm-start:3040
```

### Docker Compose

1. Navigate to the hosting directory:
```bash
cd hosting/docker/warm-start-service
```

2. Copy the example environment file:
```bash
cp .env.example .env
```

3. Start the service:
```bash
docker-compose up -d
```

4. Update your supervisor configuration to use the warm start service:
```bash
TRIGGER_WARM_START_URL=http://warm-start:3040
```

### Standalone

1. Install dependencies:
```bash
cd apps/warm-start-service
pnpm install
```

2. Build the service:
```bash
pnpm run build
```

3. Start the service:
```bash
PORT=3040 pnpm run start
```

Or for development with hot reload:
```bash
pnpm run dev
```

## Monitoring

### Metrics

The service exposes statistics at `/stats` and `/healthcheck` endpoints:

```bash
# Check current status
curl http://localhost:3040/healthcheck

# Get detailed statistics
curl http://localhost:3040/stats
```

### Logging

Set `DEBUG=1` to enable detailed logging:
```bash
DEBUG=1 pnpm run start
```

Logs are output as JSON for easy parsing:
```json
{
  "level": "info",
  "message": "Worker registered for warm start",
  "workerId": "deploy-123:v1:controller-456:worker-1",
  "deploymentId": "deploy-123",
  "deploymentVersion": "v1",
  "totalWorkers": 5,
  "timestamp": "2025-01-15T10:30:00.000Z"
}
```

## Scaling

The warm start service is **stateless** and can be scaled horizontally:

```yaml
warmStartService:
  replicaCount: 3  # Scale to 3 replicas
```

### How Scaling Works

- Each instance maintains its own in-memory registry of waiting workers
- Supervisors POST to any instance (via load balancer)
- If no match is found on that instance, it returns `didWarmStart: false`
- The supervisor then creates a cold-start container
- Workers automatically reconnect if they hit a different instance

This design prioritizes simplicity over perfect matching - a worker might miss a run if it's registered on instance A but the supervisor POSTs to instance B. This is acceptable because:
1. The worker will eventually timeout and create a new cold start
2. The next run can match with that worker
3. The system gracefully degrades to cold starts when no warm worker is available

## Performance Considerations

### Memory Usage

Each waiting worker consumes approximately:
- 200-300 bytes for registry entry
- 1-2 KB for HTTP connection overhead

Example: 1000 waiting workers ≈ 2-3 MB of memory

### Connection Limits

The service uses HTTP long-polling with keep-alive. Ensure your load balancer and reverse proxy support:
- Long-lived connections (5+ minutes)
- Appropriate keep-alive timeouts
- Sufficient connection limits

### Timeout Configuration

The relationship between timeouts:
```
connectionTimeoutMs < keepaliveMs < workerTimeoutMs
     (30s)               (300s)         (310s)
```

- **connectionTimeoutMs**: How long each poll attempt waits
- **keepaliveMs**: Total time a worker waits for next run
- **workerTimeoutMs**: Cleanup timeout (should be slightly longer)

## Troubleshooting

### Workers Not Getting Warm Started

1. Check if the service is enabled in Helm:
```bash
kubectl get deployment -l component=warm-start
```

2. Verify the supervisor can reach the service:
```bash
kubectl exec -it <supervisor-pod> -- curl http://<release>-warm-start:3040/healthcheck
```

3. Check supervisor logs for warm start attempts:
```bash
kubectl logs -l component=supervisor | grep "warm start"
```

### High Memory Usage

If memory usage is unexpectedly high:

1. Check the number of waiting workers:
```bash
curl http://localhost:3040/stats
```

2. Reduce the keepalive duration:
```yaml
warmStartService:
  defaultKeepaliveMs: 180000  # 3 minutes instead of 5
```

### Connection Timeouts

If workers are timing out before getting runs:

1. Increase the keepalive duration:
```yaml
warmStartService:
  defaultKeepaliveMs: 600000  # 10 minutes
  workerTimeoutMs: 610000
```

2. Scale up the service replicas for better distribution:
```yaml
warmStartService:
  replicaCount: 5
```

## Development

### Running Tests

```bash
cd apps/warm-start-service
pnpm run test
```

### Local Development

```bash
pnpm run dev
```

The service will start on port 3040 with hot reload enabled.

### Testing the API

Simulate a waiting worker:
```bash
curl -X GET http://localhost:3040/warm-start \
  -H "x-trigger-workload-controller-id: test-controller" \
  -H "x-trigger-deployment-id: test-deploy" \
  -H "x-trigger-deployment-version: v1" \
  -H "x-trigger-machine-cpu: 0.5" \
  -H "x-trigger-machine-memory: 512" \
  -H "x-trigger-worker-instance-name: test-worker"
```

Simulate a supervisor assigning a run (in another terminal):
```bash
curl -X POST http://localhost:3040/warm-start \
  -H "Content-Type: application/json" \
  -d '{
    "dequeuedMessage": {
      "run": {"id": "run-123", "friendlyId": "run-123"},
      "snapshot": {"id": "snap-123", "friendlyId": "snap-123"},
      "deployment": {"id": "test-deploy", "version": "v1"},
      "environment": {"id": "env-123"},
      "machine": {"cpu": "0.5", "memory": "512"},
      "dequeuedAt": "2025-01-15T10:30:00.000Z"
    }
  }'
```

## License

Same as Trigger.dev - see main repository LICENSE file.

