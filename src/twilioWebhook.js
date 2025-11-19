import twilio from 'twilio';

const STREAM_URL = process.env.TWILIO_STREAM_URL || 'wss://YOUR_DOMAIN_HERE/realtime';
const { VoiceResponse } = twilio.twiml;

export function twilioWebhookHandler(req, res) {
  const voiceResponse = new VoiceResponse();

  const callSid = req.body?.CallSid;
  if (callSid) {
    console.log(`[Twilio] /voice webhook invoked for CallSid=${callSid}`);
  } else {
    console.log('[Twilio] /voice webhook invoked');
  }

  // Instruct Twilio to connect the call audio directly to our WebSocket bridge.
  const connect = voiceResponse.connect();
  connect.stream({ url: STREAM_URL });

  res.type('text/xml');
  res.send(voiceResponse.toString());
}
