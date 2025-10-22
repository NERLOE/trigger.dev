import type { Request, Response } from "express";
import { EventEmitter } from "events";
import { logger } from "./logger";

interface WarmWorker {
  id: string;
  controllerId: string;
  deploymentId: string;
  deploymentVersion: string;
  machineCpu: string;
  machineMemory: string;
  workerInstanceName: string;
  registeredAt: Date;
  timeout: NodeJS.Timeout;
  req: Request;
  res: Response;
}

interface DequeuedMessage {
  run: {
    id: string;
    friendlyId: string;
    machine?: {
      name: string;
      cpu: number;
      memory: number;
      centsPerMs: number;
    };
  };
  snapshot: {
    id: string;
    friendlyId: string;
  };
  deployment: {
    id: string;
    friendlyId: string;
  };
  backgroundWorker?: {
    id: string;
    friendlyId: string;
    version: string;
  };
  environment: {
    id: string;
  };
  dequeuedAt: string;
}

export class WarmStartRegistry extends EventEmitter {
  private workers: Map<string, WarmWorker> = new Map();
  public config: {
    defaultConnectionTimeoutMs: number;
    defaultKeepaliveMs: number;
    workerTimeoutMs: number;
  };

  constructor(config: {
    defaultConnectionTimeoutMs: number;
    defaultKeepaliveMs: number;
    workerTimeoutMs: number;
  }) {
    super();
    this.config = config;
  }

  /**
   * Worker calls this to wait for the next run
   */
  async waitForRun(
    headers: {
      controllerId: string;
      deploymentId: string;
      deploymentVersion: string;
      machineCpu: string;
      machineMemory: string;
      workerInstanceName: string;
    },
    req: Request,
    res: Response
  ): Promise<DequeuedMessage | null> {
    const workerId = this.generateWorkerId(headers);

    // Remove any existing worker with same ID (reconnection)
    this.removeWorker(workerId);

    // Set up timeout to clean up worker after keepalive
    const timeout = setTimeout(() => {
      logger.debug("Worker timeout", { workerId });
      this.removeWorker(workerId);

      if (!res.headersSent) {
        // Return empty response to indicate timeout
        res.status(204).end();
      }
    }, this.config.workerTimeoutMs);

    // Register worker
    const worker: WarmWorker = {
      id: workerId,
      ...headers,
      registeredAt: new Date(),
      timeout,
      req,
      res,
    };

    this.workers.set(workerId, worker);

    logger.log("Worker registered for warm start", {
      workerId,
      deploymentId: headers.deploymentId,
      deploymentVersion: headers.deploymentVersion,
      totalWorkers: this.workers.size,
    });

    // Handle client disconnect
    req.on("close", () => {
      logger.debug("Worker connection closed", { workerId });
      this.removeWorker(workerId);
    });

    // Return null - the response will be sent when a run is assigned
    return null;
  }

  /**
   * Supervisor calls this to try to assign a run to a waiting worker
   */
  async assignRunToWorker(dequeuedMessage: DequeuedMessage): Promise<boolean> {
    const deployment = dequeuedMessage.deployment;
    const machine = dequeuedMessage.run?.machine;
    const version = dequeuedMessage.backgroundWorker?.version;

    if (!machine) {
      logger.error("No machine info in dequeued message", {
        deploymentId: deployment.id,
        runId: dequeuedMessage.run?.friendlyId,
      });
      return false;
    }

    if (!version) {
      logger.error("No version info in dequeued message", {
        deploymentId: deployment.id,
        runId: dequeuedMessage.run?.friendlyId,
      });
      return false;
    }

    // Use friendlyId for matching (workers send friendlyId, not database id)
    const deploymentId = deployment.friendlyId || deployment.id;

    logger.debug("Looking for matching worker", {
      deploymentId,
      deploymentVersion: version,
      machineCpu: machine.cpu,
      machineMemory: machine.memory,
      availableWorkers: this.workers.size,
    });

    // Find a matching worker
    const matchingWorker = this.findMatchingWorker(
      deploymentId,
      version,
      String(machine.cpu),
      String(machine.memory)
    );

    if (!matchingWorker) {
      logger.debug("No matching worker found");
      return false;
    }

    logger.log("Assigning run to warm worker", {
      workerId: matchingWorker.id,
      runId: dequeuedMessage.run.friendlyId,
    });

    // Send the run to the worker
    try {
      if (!matchingWorker.res.headersSent) {
        matchingWorker.res.json(dequeuedMessage);
      }
    } catch (error) {
      logger.error("Failed to send run to worker", {
        workerId: matchingWorker.id,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      return false;
    } finally {
      // Remove the worker from registry (it's now busy)
      this.removeWorker(matchingWorker.id);
    }

    return true;
  }

  /**
   * Find a worker that matches the requirements
   */
  private findMatchingWorker(
    deploymentId: string,
    deploymentVersion: string,
    machineCpu: string,
    machineMemory: string
  ): WarmWorker | undefined {
    for (const worker of this.workers.values()) {
      if (
        worker.deploymentId === deploymentId &&
        worker.deploymentVersion === deploymentVersion &&
        worker.machineCpu === machineCpu &&
        worker.machineMemory === machineMemory
      ) {
        return worker;
      }
    }
    return undefined;
  }

  /**
   * Generate a unique worker ID
   */
  private generateWorkerId(headers: {
    controllerId: string;
    deploymentId: string;
    deploymentVersion: string;
    workerInstanceName: string;
  }): string {
    return `${headers.deploymentId}:${headers.deploymentVersion}:${headers.controllerId}:${headers.workerInstanceName}`;
  }

  /**
   * Remove a worker from the registry
   */
  private removeWorker(workerId: string): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      clearTimeout(worker.timeout);
      this.workers.delete(workerId);

      logger.debug("Worker removed from registry", {
        workerId,
        remainingWorkers: this.workers.size,
      });
    }
  }

  /**
   * Clean shutdown
   */
  async shutdown(): Promise<void> {
    logger.log("Shutting down warm start registry", {
      activeWorkers: this.workers.size,
    });

    // Close all pending worker connections
    for (const worker of this.workers.values()) {
      try {
        if (!worker.res.headersSent) {
          worker.res.status(503).json({ error: "Service shutting down" });
        }
      } catch (error) {
        logger.error("Error closing worker connection", { error });
      }
      clearTimeout(worker.timeout);
    }

    this.workers.clear();
  }

  /**
   * Get current statistics
   */
  getStats() {
    return {
      totalWorkers: this.workers.size,
      workersByDeployment: this.groupWorkersByDeployment(),
    };
  }

  private groupWorkersByDeployment() {
    const groups: Record<string, number> = {};
    for (const worker of this.workers.values()) {
      const key = `${worker.deploymentId}:${worker.deploymentVersion}`;
      groups[key] = (groups[key] || 0) + 1;
    }
    return groups;
  }
}

