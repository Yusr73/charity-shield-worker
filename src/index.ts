export interface Env {
  // We'll add bindings here later
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // Health check endpoint
    if (path === '/api/health' || path === '/health' || path === '/') {
      return new Response(JSON.stringify({ 
        status: 'ok', 
        message: 'CharityShield Worker is running!',
        timestamp: new Date().toISOString()
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    // API endpoint for checking charity
    if (path === '/api/check' && request.method === 'POST') {
      try {
        const body = await request.json() as { url: string };
        const targetUrl = body.url;
        
        if (!targetUrl) {
          return new Response(JSON.stringify({ error: 'URL is required' }), {
            status: 400,
            headers: { 
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }

        // Mock response for now
        return new Response(JSON.stringify({
          url: targetUrl,
          status: 'checked',
          domainAge: '15 years',
          sslValid: true,
          riskScore: 15,
          redFlags: [],
          greenFlags: ['Domain is old', 'SSL certificate valid'],
          summary: 'This charity appears legitimate based on initial checks.'
        }), {
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (error) {
        return new Response(JSON.stringify({ error: 'Invalid request' }), {
          status: 400,
          headers: { 
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  },
};