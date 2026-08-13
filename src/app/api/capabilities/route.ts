import { NextResponse } from "next/server";
import { getCapabilityMatrix } from "@/lib/adapters";

// GET /api/capabilities — 回傳整個 capability matrix（前端快取）
export async function GET() {
  return NextResponse.json({ capabilities: getCapabilityMatrix() });
}
