import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const MARKETING = process.env.NEXT_PUBLIC_SITE_MODE === "marketing";

export function proxy(request: NextRequest) {
  // A landing-only deploy has no API behind it, so there is nothing to sign in to.
  if (MARKETING) {
    return NextResponse.redirect(new URL("/", request.url));
  }
  // Only checks the cookie exists; the API validates it on every request.
  if (request.nextUrl.pathname.startsWith("/app") && !request.cookies.has("session")) {
    return NextResponse.redirect(new URL("/signin", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/app/:path*", "/signin"],
};
