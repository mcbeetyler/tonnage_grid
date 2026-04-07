export default function middleware(request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Basic ')) {
    const decoded = atob(authHeader.slice(6));
    const colonIdx = decoded.indexOf(':');
    const password = decoded.slice(colonIdx + 1);
    if (password === process.env.APP_PASSWORD) {
      // Signal Vercel edge to pass request through to origin
      return new Response(null, {
        status: 200,
        headers: { 'x-middleware-next': '1' },
      });
    }
  }
  return new Response('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Tonnage Tracker"' },
  });
}

export const config = {
  matcher: ['/((?!favicon).*)'],
};
