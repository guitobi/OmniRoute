import { handleFreebuffRequest } from "@/lib/providers/freebuff";
import { getConfiguredFreebuffConnectionConfig } from "@/lib/providers/freebuffConnection";

export const runtime = "nodejs";

export async function handleConfiguredFreebuffRequest(request: Request): Promise<Response> {
  const config = await getConfiguredFreebuffConnectionConfig();
  return handleFreebuffRequest(request, config);
}

export const GET = handleConfiguredFreebuffRequest;
export const POST = handleConfiguredFreebuffRequest;
export const PUT = handleConfiguredFreebuffRequest;
export const PATCH = handleConfiguredFreebuffRequest;
export const DELETE = handleConfiguredFreebuffRequest;
export const OPTIONS = handleConfiguredFreebuffRequest;
export const HEAD = handleConfiguredFreebuffRequest;
