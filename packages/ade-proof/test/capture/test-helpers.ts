import { createServer } from "node:net";

export async function getFreePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const server = createServer();
  server.listen(0, () => {
    const address = server.address();
    if (address && typeof address === "object") {
      const port = address.port;
      server.close(() => resolve(port));
    } else {
      reject(new Error("Could not get free port"));
    }
  });
  server.on("error", reject);
  return promise;
}
