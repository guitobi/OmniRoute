import { getProviderConnections } from "@/models";
import { FREEBUFF_PROVIDER_ID, normalizeFreebuffConnectionConfig } from "./freebuff";

export async function getConfiguredFreebuffConnectionConfig() {
  const connections = await getProviderConnections({ provider: FREEBUFF_PROVIDER_ID });
  const activeConnection = connections.find((connection: any) => connection.isActive !== false);
  return normalizeFreebuffConnectionConfig(activeConnection?.providerSpecificData);
}
