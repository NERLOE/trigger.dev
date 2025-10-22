import express from "express";
import { WarmStartRegistry } from "./registry";
import { logger } from "./logger";

const app = express();
app.use(express.json());

const registry = new WarmStartRegistry({
  defaultConnectionTimeoutMs: parseInt(
    process.env.DEFAULT_CONNECTION_TIMEOUT_MS || "30000"
  ),
  defaultKeepaliveMs: parseInt(process.env.DEFAULT_KEEPALIVE_MS || "300000"),
  workerTimeoutMs: parseInt(process.env.WORKER_TIMEOUT_MS || "310000"),
});

// Health check
app.get("/healthcheck", (_req, res) => {
  res.json({ ok: true, ...registry.getStats() });
});

// Connect endpoint - returns warm start config
app.get("/connect", (_req, res) => {
  res.json({
    connectionTimeoutMs: registry.config.defaultConnectionTimeoutMs,
    keepaliveMs: registry.config.defaultKeepaliveMs,
  });
});

// Long-polling endpoint for workers waiting for next run
app.get("/warm-start", async (req, res) => {
  const headers = {
    controllerId: req.headers["x-trigger-workload-controller-id"] as string,
    deploymentId: req.headers["x-trigger-deployment-id"] as string,
    deploymentVersion: req.headers["x-trigger-deployment-version"] as string,
    machineCpu: req.headers["x-trigger-machine-cpu"] as string,
    machineMemory: req.headers["x-trigger-machine-memory"] as string,
    workerInstanceName: req.headers["x-trigger-worker-instance-name"] as string,
  };

  if (!headers.controllerId || !headers.deploymentId || !headers.deploymentVersion) {
    return res.status(400).json({ error: "Missing required headers" });
  }

  logger.debug("Worker waiting for warm start", { headers });

  try {
    const result = await registry.waitForRun(headers, req, res);

    if (result) {
      return res.json(result);
    }
    // If result is null, the response was already sent (timeout or aborted)
    return;
  } catch (error) {
    logger.error("Error in warm start wait", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    if (!res.headersSent) {
      return res.status(500).json({ error: "Internal server error" });
    }
    return;
  }
});

// Supervisor tries to assign a run to a warm worker
app.post("/warm-start", async (req, res) => {
  const body = req.body;

  if (!body.dequeuedMessage) {
    return res.status(400).json({ error: "Missing dequeuedMessage" });
  }

  const dequeuedMessage = body.dequeuedMessage;

  logger.debug("Supervisor attempting warm start", {
    runId: dequeuedMessage.run?.id,
    deploymentId: dequeuedMessage.deployment?.id,
  });

  try {
    const didWarmStart = await registry.assignRunToWorker(dequeuedMessage);
    return res.json({ didWarmStart });
  } catch (error) {
    logger.error("Error assigning run to worker", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return res.status(500).json({ error: "Internal server error" });
  }
});

// Stats endpoint for monitoring
app.get("/stats", (_req, res) => {
  res.json(registry.getStats());
});

const PORT = process.env.PORT || 3040;
const server = app.listen(PORT, () => {
  logger.log(`🔥 Warm start service listening on port ${PORT}`);
});

// Increase keep-alive timeout for long-polling
server.keepAliveTimeout = 330 * 1000; // 330 seconds (longer than keepalive)
server.headersTimeout = 335 * 1000; // Slightly longer than keepAliveTimeout

// Graceful shutdown
const shutdown = async () => {
  logger.log("Shutting down warm start service...");

  server.close(() => {
    logger.log("HTTP server closed");
  });

  await registry.shutdown();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

