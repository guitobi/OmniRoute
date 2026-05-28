import { handleFreebuffInterceptRequest } from "@/lib/providers/freebuffIntercept";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return handleFreebuffInterceptRequest(request);
}

export async function POST(request: Request) {
  return handleFreebuffInterceptRequest(request);
}

export async function PUT(request: Request) {
  return handleFreebuffInterceptRequest(request);
}

export async function PATCH(request: Request) {
  return handleFreebuffInterceptRequest(request);
}

export async function DELETE(request: Request) {
  return handleFreebuffInterceptRequest(request);
}

export async function OPTIONS(request: Request) {
  return handleFreebuffInterceptRequest(request);
}

export async function HEAD(request: Request) {
  return handleFreebuffInterceptRequest(request);
}
