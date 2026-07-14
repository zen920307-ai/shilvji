/**
 * Cloudflare Pages Function：代理 xAI API
 */
export async function onRequest(context) {
  const { request, params } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(request),
    });
  }

  const pathParts = params.path;
  const subPath = Array.isArray(pathParts)
    ? pathParts.join('/')
    : pathParts || 'v1/chat/completions';

  const target = `https://api.x.ai/${subPath}`;
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.set('host', 'api.x.ai');

  let body = null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    body = await request.arrayBuffer();
  }

  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body,
  });

  const out = new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
  const cors = corsHeaders(request);
  cors.forEach((v, k) => out.headers.set(k, v));
  return out;
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '*';
  return new Headers({
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
  });
}
