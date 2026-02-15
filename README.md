# GoLine Voice AI System (Day 1)

Day-1 MVP plumbing for the GoLine AI phone-order assistant.

## Prerequisites
- Node.js 18+
- npm

## Setup
1. Copy `.env.example` to `.env` and fill in your secrets.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run the development server with live reload:
   ```bash
   npm run dev
   ```
   Or start once without nodemon:
   ```bash
   npm start
   ```

## Runtime Behavior
- The Express server listens on `PORT` (default `8080`).
- `POST /voice` returns TwiML instructing Twilio to open a `<Stream>` to `wss://YOUR_DOMAIN_HERE/realtime`.
- A WebSocket server accepts connections at `ws://localhost:8080/realtime` and logs incoming media/control frames from Twilio.
- `realtimeHandler.connectToRealtime()` stubs the OpenAI Realtime handshake and logs lifecycle events. No audio forwarding occurs on Day 1.

## Testing the Flow
1. Expose the server using a tunnel such as `ngrok` and configure your Twilio number's Voice webhook to `POST https://<your-ngrok-domain>/voice`.
2. Place a call to your Twilio number.
3. You should hear silence (no greeting); Twilio immediately bridges audio to the backend WebSocket.
4. Server logs will show WebSocket connect/disconnect events, payload summaries, and placeholder OpenAI Realtime logs.
5. Pressing DTMF "0" is reserved for Day-2+ logic and currently only logs the intent.

### Environment Variables

Set the required keys in `.env`:

```
TWILIO_AUTH_TOKEN=
OPENAI_API_KEY=
PHONE_RELAY_NUMBER=
PORT=8080
```

Optional overrides:

```
TWILIO_STREAM_URL=wss://YOUR_DOMAIN_HERE/realtime
OPENAI_REALTIME_ENDPOINT=wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview
```

This scaffolding demonstrates the full telephony plumbing for the MVP without AI order handling or printing.
