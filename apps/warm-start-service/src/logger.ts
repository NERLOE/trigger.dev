export const logger = {
  log: (message: string, meta?: Record<string, unknown>) => {
    console.log(
      JSON.stringify({
        level: "info",
        message,
        ...meta,
        timestamp: new Date().toISOString(),
      })
    );
  },
  debug: (message: string, meta?: Record<string, unknown>) => {
    if (process.env.DEBUG) {
      console.log(
        JSON.stringify({
          level: "debug",
          message,
          ...meta,
          timestamp: new Date().toISOString(),
        })
      );
    }
  },
  error: (message: string, meta?: Record<string, unknown>) => {
    console.error(
      JSON.stringify({
        level: "error",
        message,
        ...meta,
        timestamp: new Date().toISOString(),
      })
    );
  },
};

