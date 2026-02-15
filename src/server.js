import 'dotenv/config';
import http from 'node:http';
import express from 'express';
import { attachRealtimeServer } from './realtimeHandler.js';

const app = express();

// Twilio sends webhook payloads as application/x-www-form-urlencoded.
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const sendTwimlMessage = (res, message) => {
  res.type('text/xml').send(`<Response><Say>${message}</Say></Response>`);
};

const normalizeStreamUrl = (value) => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('wss://') || trimmed.startsWith('ws://')) {
    return trimmed;
  }
  return `wss://${trimmed}`;
};

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Twilio voice webhook -> return TwiML that connects to the realtime stream endpoint.
app.post('/voice', (req, res) => {
  const callSid = req.body?.CallSid || null;
  const fromNumber = req.body?.From || null;
  const toNumber = req.body?.To || null;

  console.log('[Twilio] incoming /voice webhook', { callSid, from: fromNumber, to: toNumber });

  const streamUrl = normalizeStreamUrl(process.env.TWILIO_STREAM_URL);
  if (!streamUrl) {
    console.error('[Twilio] TWILIO_STREAM_URL not configured');
    sendTwimlMessage(res, 'Sorry, we cannot connect your call right now.');
    return;
  }

  const twiml = `
    <Response>
      <Connect>
        <Stream url="${streamUrl}" track="inbound_track">
          <Parameter name="customerPhone" value="${fromNumber || ''}" />
        </Stream>
      </Connect>
    </Response>
  `;

  res.type('text/xml');
  res.send(twiml.trim());
});

const port = process.env.PORT || 8080;
const server = http.createServer(app);

// Attach the realtime WebSocket server to this HTTP server.
attachRealtimeServer(server);

server.listen(port, () => {
  console.log(`Voice AI server listening on port ${port}`);
});
