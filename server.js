/**
 * Voice AI Gateway Server (Sidekick Deploy)
 * Connects: Web Caller (caller.html) <-> AssemblyAI Voice Agent API <-> Flutter Mobile App
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
require('dotenv').config();

const PORT = process.env.PORT || 3000;
const ASSEMBLYAI_KEY = process.env.ASSEMBLYAI_API_KEY || '';

// Track mobile app WebSocket clients and active calls
const mobileClients = new Set();
const activeCalls = new Map();
let storedAgentId = null;

// Secretary system prompt
const SECRETARY_SYSTEM_PROMPT = `You are Kabeer's AI Executive Secretary. Your role is to professionally screen and manage incoming calls.

When someone calls:
1. Greet them warmly and introduce yourself as Kabeer's AI secretary
2. Ask for their name if they haven't provided it
3. Ask about the purpose or nature of their call
4. Let them know you're checking if Kabeer is available
5. Engage in polite, professional conversation while waiting for Kabeer's response
6. If Kabeer sends a directive, relay it naturally to the caller

Behavior rules:
- Be warm, professional, and human-like
- Keep responses concise (1-2 sentences max)
- Never reveal you are an AI unless directly asked
- If caller is rude, remain calm and professional
- Ask clarifying questions about their needs
- Remember the caller's name and use it occasionally`;

const SECRETARY_GREETING = "Hello! You've reached Kabeer's line. I'm his secretary. May I know who's calling please?";

// === 1. Create stored agent on startup ===
async function ensureAgent() {
  if (!ASSEMBLYAI_KEY) {
    console.error('[ERROR] ASSEMBLYAI_API_KEY not found in environment');
    return;
  }
  try {
    const res = await fetch('https://agents.assemblyai.com/v1/agents', {
      method: 'POST',
      headers: {
        'Authorization': ASSEMBLYAI_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: "Kabeer's Voice Secretary",
        system_prompt: SECRETARY_SYSTEM_PROMPT,
        greeting: SECRETARY_GREETING,
        voice: { voice_id: 'alba' },
      }),
    });
    const data = await res.json();
    if (data.id) {
      storedAgentId = data.id;
      console.log(`[AssemblyAI] Agent created: ${storedAgentId}`);
    } else {
      console.error('[AssemblyAI] Agent creation response:', JSON.stringify(data));
    }
  } catch (e) {
    console.error('[AssemblyAI] Agent creation error:', e.message);
  }
}

// === 2. HTTP Server ===
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Serve caller.html
  if (req.url === '/' || req.url === '/caller' || req.url === '/caller.html') {
    const filePath = path.join(__dirname, 'web', 'caller.html');
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error loading caller page');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
      }
    });
  }
  // Serve pcm-processor.js (AudioWorklet)
  else if (req.url === '/pcm-processor.js') {
    const filePath = path.join(__dirname, 'web', 'pcm-processor.js');
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/javascript' });
        res.end(data);
      }
    });
  }
  // GET /api/voice-token — mint a temporary AssemblyAI token
  else if (req.url === '/api/voice-token' && req.method === 'GET') {
    try {
      const url = new URL('https://agents.assemblyai.com/v1/token');
      url.searchParams.set('expires_in_seconds', '300');
      url.searchParams.set('max_session_duration_seconds', '600');

      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${ASSEMBLYAI_KEY}` },
      });

      if (!response.ok) {
        const errText = await response.text();
        res.writeHead(response.status, { 'Content-Type': 'text/plain' });
        res.end(errText);
        return;
      }

      const { token } = await response.json();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token, agentId: storedAgentId }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  }
  // POST /api/call — notify mobile app of incoming call
  else if (req.url === '/api/call' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const callId = 'call_' + Date.now();
        const callData = {
          callId,
          callerName: payload.callerName || 'Web Caller',
          topic: payload.topic || 'Voice Call',
          timestamp: new Date().toISOString(),
          status: 'screening',
        };
        activeCalls.set(callId, callData);

        // Immediately notify all mobile clients
        broadcastToMobile({
          type: 'INCOMING_CALL',
          data: callData,
        });

        console.log(`[Call] Incoming ${callId} — notified ${mobileClients.size} mobile client(s)`);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'initiated', callId }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid payload' }));
      }
    });
  }
  else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

// === 3. WebSocket Server for Mobile App ===
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('[WebSocket] New client connected');

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);

      if (msg.type === 'REGISTER_MOBILE') {
        mobileClients.add(ws);
        console.log(`[WebSocket] Mobile client registered (total: ${mobileClients.size})`);
        ws.send(JSON.stringify({ type: 'REGISTERED_SUCCESS' }));
      } else if (msg.type === 'MASTER_DIRECTIVE') {
        const { callId, action, spokenDirective } = msg.data;
        console.log(`[Master] Action: ${action}, CallId: ${callId}`);

        const session = activeCalls.get(callId);
        if (session) {
          session.status = action;
          session.spokenDirective = spokenDirective;
        }

        broadcastToAll({
          type: 'DIRECTIVE_UPDATED',
          data: { callId, action, spokenDirective },
        });
      } else if (msg.type === 'TRANSCRIPT_UPDATE') {
        // Forward live transcript from web caller to mobile clients only
        const { speaker, text, callId } = msg.data || {};
        console.log(`[Transcript] ${speaker}: ${text ? text.substring(0, 60) : ''}`);
        broadcastToMobile({
          type: 'TRANSCRIPT_UPDATE',
          data: { speaker, text, callId },
        });
      }
    } catch (e) {
      console.error('[WebSocket] Parse error:', e.message);
    }
  });

  ws.on('close', () => {
    mobileClients.delete(ws);
    console.log('[WebSocket] Client disconnected');
  });
});

function broadcastToMobile(payload) {
  const jsonStr = JSON.stringify(payload);
  mobileClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(jsonStr);
  });
}

function broadcastToAll(payload) {
  const jsonStr = JSON.stringify(payload);
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(jsonStr);
  });
}

// === 4. Start Server ===
server.listen(PORT, '0.0.0.0', async () => {
  console.log('='.repeat(60));
  console.log(`🎙️  Voice AI Gateway Server (Sidekick)`);
  console.log(`   Port:    ${PORT}`);
  console.log(`   Caller:  http://localhost:${PORT}/caller.html`);
  console.log('='.repeat(60));
  await ensureAgent();
});
