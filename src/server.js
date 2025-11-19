import http from 'node:http';
import express from 'express';
import dotenv from 'dotenv';
import { attachRealtimeServer } from './realtimeHandler.js';

dotenv.config();

const app = express();

// Twilio sends webhook payloads as application/x-www-form-urlencoded.
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Twilio voice webhook -> return TwiML that connects to the stream endpoint.
app.post('/voice', (req, res) => {
  const twiml = `
    <Response>
      <Connect>
        <Stream url="wss://${process.env.TWILIO_STREAM_URL}" track="inbound_track" />
      </Connect>
    </Response>
  `;

  res.type('text/xml');
  res.send(twiml.trim());
});

const port = process.env.PORT || 8080;
const server = http.createServer(app);

// Attach the existing realtime WebSocket server to this HTTP server.
attachRealtimeServer(server);

server.listen(port, () => {
  console.log(`GoLine Day-1 server listening on port ${port}`);
});
