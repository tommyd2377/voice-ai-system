import WebSocket, { WebSocketServer } from 'ws';
import twilio from 'twilio';

const VERBOSE_OPENAI_LOGS = process.env.VERBOSE_OPENAI_LOGS === 'true';
const ASSISTANT_GREETING = "Hi, I'm Victoria. This is Thomas DeVito's personal AI assistant. How can I help you?";

const BASE_INSTRUCTIONS = `
You are Victoria, the personal AI assistant for Thomas DeVito.
After your introduction, always refer to him as Tom.

Start every call by saying exactly:
"${ASSISTANT_GREETING}"
Then stop and wait.

You handle two call types:
1) caller_message: external callers who want to send Tom a message.
2) self_note: Tom calling to leave himself a note.

For caller_message mode:
- Collect name, reason for calling, message details, and at least one contact method if possible.
- Ask whether they want a callback.
- Before sending, read back a concise summary and ask for confirmation.

For self_note mode:
- Capture the note quickly in plain language.
- Read back a short summary and ask for confirmation.

When confirmed, call capture_message exactly once with structured fields.
After tool output:
- If delivered=true, say the message was passed along.
- If delivered=false, say delivery may be delayed.

Style:
- Sound professional, clear, and concise.
- Be personable but do not be theatrical.
- Do not fabricate facts about Tom.

Restrictions:
- Do not discuss private personal details.
- Do not promise response timelines.
- Do not claim calendar access.
`.trim();

const DEFAULT_REALTIME_ENDPOINT =
  process.env.OPENAI_REALTIME_ENDPOINT || 'wss://api.openai.com/v1/realtime?model=gpt-realtime-mini';
const DEFAULT_MODEL = 'gpt-realtime-mini';

const CAPTURE_MESSAGE_TOOL = {
  type: 'function',
  name: 'capture_message',
  description: 'Capture a caller message or self-note and dispatch it to Tom via SMS.',
  parameters: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['caller_message', 'self_note'],
        description: 'Message type. Use self_note when Tom is calling himself.',
      },
      callerName: {
        type: 'string',
        nullable: true,
        description: 'Caller name. Nullable for self_note mode.',
      },
      contactPhone: {
        type: 'string',
        nullable: true,
        description: 'Best callback phone number, if available.',
      },
      contactEmail: {
        type: 'string',
        nullable: true,
        description: 'Best callback email, if available.',
      },
      subject: {
        type: 'string',
        description: 'Short subject line for the message.',
      },
      messageBody: {
        type: 'string',
        description: 'Main message content in the caller\'s own intent.',
      },
      callbackRequested: {
        type: 'boolean',
        description: 'Whether the caller asked Tom to call back.',
      },
      priority: {
        type: 'string',
        enum: ['low', 'normal', 'high'],
        description: 'Estimated urgency.',
      },
    },
    required: ['mode', 'subject', 'messageBody', 'callbackRequested', 'priority'],
    additionalProperties: false,
  },
};

const INVALID_PHONE_VALUES = new Set([
  '',
  'caller id',
  'callerid',
  'unknown',
  'n/a',
  'na',
  'none',
  'null',
  'undefined',
  'caller',
]);

const normalizeCallerPhone = (value) => {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (INVALID_PHONE_VALUES.has(trimmed.toLowerCase())) return null;
  return trimmed;
};

const normalizeEmail = (value) => {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (!trimmed.includes('@')) return null;
  return trimmed;
};

const normalizeMode = (value, fallback) => {
  if (value === 'caller_message' || value === 'self_note') {
    return value;
  }
  return fallback;
};

const normalizePriority = (value) => {
  if (value === 'low' || value === 'normal' || value === 'high') {
    return value;
  }
  return 'normal';
};

const normalizeBoolean = (value, fallback = false) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (lower === 'true' || lower === 'yes') return true;
    if (lower === 'false' || lower === 'no') return false;
  }
  return fallback;
};

const sanitizeText = (value, maxLength = 500) => {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.slice(0, maxLength);
};

const digitsOnly = (value) => String(value || '').replace(/\D/g, '');

const areSamePhone = (a, b) => {
  const da = digitsOnly(a);
  const db = digitsOnly(b);
  if (!da || !db) return false;
  if (da.length >= 10 && db.length >= 10) {
    return da.slice(-10) === db.slice(-10);
  }
  return da === db;
};

const buildInstructions = ({ isSelfCaller = false, hasCallerPhone = false } = {}) => {
  let instructions = BASE_INSTRUCTIONS;

  if (isSelfCaller) {
    instructions +=
      '\nCALL CONTEXT: Caller ID matches Tom\'s number. Default to self_note mode unless caller explicitly says otherwise.';
  } else {
    instructions += '\nCALL CONTEXT: Treat this caller as an external contact unless clarified otherwise.';
  }

  if (hasCallerPhone) {
    instructions +=
      '\nPHONE CONTEXT: Caller phone is available from caller ID. Use it as fallback contactPhone if none is provided.';
  }

  return instructions;
};

const formatOutboundMessage = (payload, meta = {}) => {
  const lines = [
    'Voice Assistant Message',
    `Mode: ${payload.mode}`,
    `Priority: ${payload.priority}`,
    `Callback requested: ${payload.callbackRequested ? 'yes' : 'no'}`,
    `Subject: ${payload.subject}`,
    `Message: ${payload.messageBody}`,
  ];

  if (payload.callerName) lines.push(`Caller name: ${payload.callerName}`);
  if (payload.contactPhone) lines.push(`Contact phone: ${payload.contactPhone}`);
  if (payload.contactEmail) lines.push(`Contact email: ${payload.contactEmail}`);
  if (meta.callerPhone) lines.push(`Caller ID: ${meta.callerPhone}`);
  if (meta.callSid) lines.push(`CallSid: ${meta.callSid}`);
  if (meta.isSelfCaller != null) lines.push(`Self caller detected: ${meta.isSelfCaller ? 'yes' : 'no'}`);
  if (meta.createdAt) lines.push(`Captured at: ${meta.createdAt}`);

  return lines.join('\n');
};

// Firebase re-entry notes:
// - Re-enable persistence by adding a storage adapter (for example Firestore) behind a single dispatch interface.
// - Keep capture_message payload shape stable so storage and SMS can coexist without prompt/schema changes.
// - If reactivating Firebase later, wire it via a separate module and call it from handleCaptureMessage.

async function sendSmsToOwner(messageBody) {
  const ownerPhone = normalizeCallerPhone(process.env.TWILIO_OWNER_PHONE);
  const smsFrom = normalizeCallerPhone(process.env.TWILIO_SMS_FROM || process.env.PHONE_RELAY_NUMBER);
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!ownerPhone) {
    return { delivered: false, channel: 'sms', reason: 'TWILIO_OWNER_PHONE missing' };
  }
  if (!smsFrom) {
    return { delivered: false, channel: 'sms', reason: 'TWILIO_SMS_FROM missing' };
  }
  if (!accountSid || !authToken) {
    return { delivered: false, channel: 'sms', reason: 'Twilio account credentials missing' };
  }

  try {
    const client = twilio(accountSid, authToken);
    const sms = await client.messages.create({
      to: ownerPhone,
      from: smsFrom,
      body: messageBody,
    });

    return {
      delivered: true,
      channel: 'sms',
      messageSid: sms.sid,
      to: ownerPhone,
      from: smsFrom,
    };
  } catch (err) {
    console.error('[SMS] failed to send to owner', err);
    return { delivered: false, channel: 'sms', reason: 'Twilio SMS send failed' };
  }
}

export function attachRealtimeServer(server) {
  const wss = new WebSocketServer({ server, path: '/realtime' });

  wss.on('listening', () => {
    console.log('Realtime WebSocket server ready at /realtime');
  });

  wss.on('connection', (socket, request) => {
    const callSid = request.headers['x-twilio-call-sid'] || null;
    console.log('Twilio stream connected');
    console.log(`[Realtime] Twilio stream connected${callSid ? ` for CallSid=${callSid}` : ''}`);

    const openaiSocket = connectToOpenAI();
    if (!openaiSocket) {
      console.error('[OpenAI] Failed to create OpenAI WebSocket; closing Twilio stream');
      socket.close();
      return;
    }

    let streamSid = null;
    let activeResponse = false;
    let currentResponseId = null;
    let userSpeaking = false;
    let functionCallBuffer = '';
    let functionCallName = null;
    let functionCallId = null;
    let inferredCallerPhone = null;
    let isSelfCaller = false;
    let lastCapturedMessage = null;
    let messageDispatchStatus = null;
    let callStartMs = Date.now();
    let callEndMs = null;
    let openaiReady = false;
    let twilioStartReceived = false;
    let sessionInitialized = false;
    let openaiUsageTotals = {
      input_tokens: 0,
      input_cached_tokens: 0,
      input_uncached_tokens: 0,
      input_audio_tokens: 0,
      output_tokens: 0,
      output_audio_tokens: 0,
      model_requests: 0,
    };

    const ownerPhone = normalizeCallerPhone(process.env.TWILIO_OWNER_PHONE);
    if (!ownerPhone) {
      console.warn('[Realtime] TWILIO_OWNER_PHONE is not set; SMS delivery will fail until configured');
    }

    const resetFunctionCallState = () => {
      functionCallBuffer = '';
      functionCallName = null;
      functionCallId = null;
    };

    const appendFunctionCallChunk = (message) => {
      functionCallName = message.name || functionCallName;
      functionCallId = message.call_id || message.id || functionCallId;

      const delta = message.delta?.arguments;
      if (delta) {
        functionCallBuffer += delta;
        return;
      }

      if (!functionCallBuffer && message.arguments) {
        functionCallBuffer = message.arguments;
      }
    };

    const cancelActiveResponse = () => {
      if (!activeResponse || !currentResponseId || openaiSocket.readyState !== WebSocket.OPEN) {
        return;
      }
      try {
        openaiSocket.send(
          JSON.stringify({
            type: 'response.cancel',
            response_id: currentResponseId,
          })
        );
        console.log('[OpenAI] sent response.cancel for active response', currentResponseId);
      } catch (err) {
        console.warn('[OpenAI] failed to send response.cancel', err);
      }
    };

    const sendClearToTwilio = () => {
      if (!streamSid || socket.readyState !== WebSocket.OPEN) {
        return;
      }
      try {
        socket.send(
          JSON.stringify({
            event: 'clear',
            streamSid,
          })
        );
        console.log('[Realtime] sent clear event to Twilio');
      } catch (err) {
        console.warn('[Realtime] failed to send clear event to Twilio', err);
      }
    };

    const handleSpeechStarted = () => {
      if (VERBOSE_OPENAI_LOGS) {
        console.log('[OpenAI] event=input_audio_buffer.speech_started');
      }
      userSpeaking = true;
      sendClearToTwilio();
      cancelActiveResponse();
    };

    const forwardAudioToTwilio = (audioChunk) => {
      if (!streamSid || userSpeaking || !activeResponse) {
        return;
      }

      const twilioMedia = {
        event: 'media',
        streamSid,
        media: { payload: audioChunk },
      };

      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(twilioMedia));
      }
    };

    const forceResponse = (instructionsText) => {
      if (openaiSocket.readyState !== WebSocket.OPEN) return;
      openaiSocket.send(
        JSON.stringify({
          type: 'response.create',
          response: {
            instructions: instructionsText,
          },
        })
      );
      activeResponse = true;
    };

    const maybeInitSession = async () => {
      if (sessionInitialized || !openaiReady || !twilioStartReceived) return;

      const hasCallerPhone = Boolean(normalizeCallerPhone(inferredCallerPhone));
      const instructions = buildInstructions({ isSelfCaller, hasCallerPhone });

      if (openaiSocket.readyState !== WebSocket.OPEN) {
        return;
      }

      openaiSocket.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            type: 'realtime',
            model: DEFAULT_MODEL,
            instructions,
            tools: [CAPTURE_MESSAGE_TOOL],
          },
        })
      );

      openaiSocket.send(
        JSON.stringify({
          type: 'response.create',
          response: {
            instructions: `Start the call by saying exactly: ${ASSISTANT_GREETING}`,
          },
        })
      );

      sessionInitialized = true;
      const phoneLast4 = normalizeCallerPhone(inferredCallerPhone)?.slice(-4) || null;
      console.log('[Realtime] session initialized', {
        callSid,
        hasCallerPhone,
        callerPhoneLast4: phoneLast4,
        isSelfCaller,
      });
    };

    const handleCaptureMessage = async (parsedArgs) => {
      const fallbackMode = isSelfCaller ? 'self_note' : 'caller_message';
      const mode = normalizeMode(parsedArgs?.mode, fallbackMode);
      const callerName = sanitizeText(parsedArgs?.callerName, 80);
      const contactPhone =
        normalizeCallerPhone(parsedArgs?.contactPhone) || normalizeCallerPhone(inferredCallerPhone) || null;
      const contactEmail = normalizeEmail(parsedArgs?.contactEmail);
      const subject = sanitizeText(parsedArgs?.subject, 160) || (mode === 'self_note' ? 'Self note' : 'Voice message');
      const messageBody = sanitizeText(parsedArgs?.messageBody, 2000);
      const callbackRequested = normalizeBoolean(parsedArgs?.callbackRequested, false);
      const priority = normalizePriority(parsedArgs?.priority);

      if (!messageBody) {
        forceResponse('Please restate the message in one or two clear sentences.');
        return;
      }

      const payload = {
        mode,
        callerName,
        contactPhone,
        contactEmail,
        subject,
        messageBody,
        callbackRequested,
        priority,
      };

      lastCapturedMessage = payload;

      const smsBody = formatOutboundMessage(payload, {
        callSid,
        callerPhone: normalizeCallerPhone(inferredCallerPhone),
        isSelfCaller,
        createdAt: new Date().toISOString(),
      });

      const smsResult = await sendSmsToOwner(smsBody);
      messageDispatchStatus = smsResult;

      if (functionCallId && openaiSocket.readyState === WebSocket.OPEN) {
        const toolOutput = {
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: functionCallId,
            output: JSON.stringify({
              delivered: smsResult.delivered,
              channel: 'sms',
              reason: smsResult.reason || null,
            }),
          },
        };

        try {
          openaiSocket.send(JSON.stringify(toolOutput));
        } catch (err) {
          console.warn('[capture_message] failed to send tool output', err);
        }
      }

      if (smsResult.delivered) {
        forceResponse('Thanks. I captured your message and passed it along to Tom.');
      } else {
        forceResponse('Thanks. I captured your message. Delivery may be delayed right now.');
      }
    };

    const handleFunctionCallDone = async () => {
      if (!functionCallName || !functionCallBuffer) {
        resetFunctionCallState();
        return;
      }

      try {
        const parsedArgs = JSON.parse(functionCallBuffer);

        if (functionCallName === 'capture_message') {
          await handleCaptureMessage(parsedArgs);
          resetFunctionCallState();
          return;
        }

        if (functionCallId && openaiSocket.readyState === WebSocket.OPEN) {
          openaiSocket.send(
            JSON.stringify({
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: functionCallId,
                output: JSON.stringify({ delivered: false, channel: 'sms', reason: 'Unsupported tool name' }),
              },
            })
          );
        }
      } catch (err) {
        console.warn('[Function Call] failed to process arguments', err);
        forceResponse('Sorry, I missed that. Please repeat your message in one short summary.');
      }

      resetFunctionCallState();
    };

    openaiSocket.on('open', () => {
      openaiReady = true;
      maybeInitSession();
      setTimeout(() => {
        if (!twilioStartReceived) {
          twilioStartReceived = true;
          maybeInitSession();
        }
      }, 1500);
    });

    const handleTwilioMessage = (data, isBinary) => {
      try {
        const message = JSON.parse(isBinary ? data.toString() : data.toString());
        const event = message.event || 'unknown';

        switch (event) {
          case 'media':
            if (message.media?.payload && openaiSocket.readyState === WebSocket.OPEN) {
              openaiSocket.send(
                JSON.stringify({
                  type: 'input_audio_buffer.append',
                  audio: message.media.payload,
                })
              );
            }
            break;
          case 'start':
            if (VERBOSE_OPENAI_LOGS) {
              const sid = message.start?.callSid || callSid || 'unknown';
              console.log(`[Realtime] event=start callSid=${sid}`);
            }
            streamSid = message.start?.streamSid || streamSid;
            if (message.start?.customParameters?.customerPhone) {
              inferredCallerPhone = normalizeCallerPhone(message.start.customParameters.customerPhone);
            }
            if (ownerPhone && inferredCallerPhone) {
              isSelfCaller = areSamePhone(inferredCallerPhone, ownerPhone);
            }
            if (inferredCallerPhone) {
              console.log('[Realtime] inferred caller phone', inferredCallerPhone);
            }
            twilioStartReceived = true;
            maybeInitSession();
            break;
          case 'mark':
            if (VERBOSE_OPENAI_LOGS) {
              const name = message.mark?.name || 'unknown';
              console.log(`[Realtime] event=mark name=${name}`);
            }
            break;
          case 'stop':
            if (VERBOSE_OPENAI_LOGS) {
              const sid = callSid || 'unknown';
              console.log(`[Realtime] event=stop callSid=${sid}`);
            }
            break;
          default:
            if (VERBOSE_OPENAI_LOGS) {
              console.log(`[Realtime] event=${event}`);
            }
        }
      } catch (err) {
        console.warn('[Realtime] Failed to parse Twilio message as JSON', err?.message || err);
      }
    };

    socket.on('message', handleTwilioMessage);

    const handleOpenAiMessage = async (data) => {
      try {
        const message = JSON.parse(data.toString());
        const type = message.type;

        switch (type) {
          case 'input_audio_buffer.speech_started':
            handleSpeechStarted();
            return;
          case 'conversation.item.input_audio_transcription.completed': {
            const transcript =
              message.transcript ||
              message.transcription?.text ||
              message.transcription ||
              message.item?.transcript ||
              message.item?.transcription;
            if (transcript && VERBOSE_OPENAI_LOGS) {
              console.log('[ASR]', { chars: String(transcript).length, text: transcript });
            }
            break;
          }
          case 'response.created':
            currentResponseId = message.response?.id || currentResponseId;
            activeResponse = true;
            userSpeaking = false;
            if (VERBOSE_OPENAI_LOGS) {
              console.log('[OpenAI] event=response.created id=', currentResponseId);
            }
            break;
          case 'session.created':
          case 'session.updated':
            if (message.session && VERBOSE_OPENAI_LOGS) {
              console.log('[OpenAI] session state:', JSON.stringify(message.session, null, 2));
            }
            break;
          case 'response.function_call_arguments.delta':
            appendFunctionCallChunk(message);
            break;
          case 'response.function_call_arguments.done':
            appendFunctionCallChunk(message);
            await handleFunctionCallDone();
            break;
          case 'response.output_audio.delta': {
            const audioChunk =
              typeof message.delta === 'string' ? message.delta : message.delta && message.delta.audio;
            if (audioChunk) {
              forwardAudioToTwilio(audioChunk);
            }
            break;
          }
          case 'response.output_audio.done':
          case 'response.done':
          case 'response.cancelled':
            activeResponse = false;
            if (VERBOSE_OPENAI_LOGS) {
              console.log('[OpenAI] event=response.end type=', type);
            }
            break;
          case 'error':
            if (message.error && message.error.code === 'response_cancel_not_active') {
              if (VERBOSE_OPENAI_LOGS) {
                console.log('[OpenAI] cancel_not_active (safe to ignore)');
              }
            } else {
              console.error('[OpenAI] error event payload:', JSON.stringify(message, null, 2));
            }
            break;
          default:
            if (VERBOSE_OPENAI_LOGS) {
              console.log(`[OpenAI] event=${type}`);
            }
        }

        const usage = message.response?.usage || message.usage;
        if (usage && typeof usage === 'object') {
          openaiUsageTotals.input_tokens += usage.input_tokens || 0;
          openaiUsageTotals.output_tokens += usage.output_tokens || 0;
          openaiUsageTotals.input_audio_tokens += usage.input_audio_tokens || 0;
          openaiUsageTotals.output_audio_tokens += usage.output_audio_tokens || 0;

          if (usage.input_cached_tokens != null) {
            openaiUsageTotals.input_cached_tokens += usage.input_cached_tokens;
          }
          if (usage.input_uncached_tokens != null) {
            openaiUsageTotals.input_uncached_tokens += usage.input_uncached_tokens;
          }

          openaiUsageTotals.model_requests += 1;
        }
      } catch {
        console.warn('[OpenAI] Failed to parse message as JSON');
      }
    };

    openaiSocket.on('message', handleOpenAiMessage);

    socket.on('close', (code, reason) => {
      callEndMs = Date.now();
      const callDurationSeconds = Math.round((callEndMs - callStartMs) / 1000);
      const reasonText = normalizeReason(reason);
      const callerPhone = normalizeCallerPhone(inferredCallerPhone);

      console.log('Twilio stream closed');
      console.log(
        `[Realtime] Twilio stream closed${callSid ? ` (CallSid=${callSid})` : ''}: code=${code} reason=${reasonText}`
      );

      console.log('[Call Summary]', {
        callSid,
        callerPhone,
        isSelfCaller,
        capturedMode: lastCapturedMessage?.mode || null,
        capturedSubject: lastCapturedMessage?.subject || null,
        messageDelivered: messageDispatchStatus?.delivered || false,
        deliveryReason: messageDispatchStatus?.reason || null,
        callDurationSeconds,
        openaiUsageTotals,
      });

      if (openaiSocket && openaiSocket.readyState === WebSocket.OPEN) {
        openaiSocket.close();
      }
    });

    socket.on('error', (error) => {
      console.error(`[Realtime] Twilio stream error${callSid ? ` (CallSid=${callSid})` : ''}:`, error);
    });
  });
}

export function connectToOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    console.warn('[OpenAI] OPENAI_API_KEY missing; cannot connect to Realtime API.');
    return null;
  }

  console.log('[OpenAI] connecting');

  const ws = new WebSocket(DEFAULT_REALTIME_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });

  ws.on('open', () => {
    console.log('[OpenAI] connected');

    const fallbackInstructions = buildInstructions({
      isSelfCaller: false,
      hasCallerPhone: false,
    });

    const sessionUpdate = {
      type: 'session.update',
      session: {
        type: 'realtime',
        model: DEFAULT_MODEL,
        output_modalities: ['audio'],
        instructions: fallbackInstructions,
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            transcription: {
              model: 'gpt-4o-transcribe',
            },
            turn_detection: {
              type: 'server_vad',
              threshold: 0.45,
              prefix_padding_ms: 200,
              silence_duration_ms: 1100,
              create_response: true,
              interrupt_response: true,
            },
          },
          output: {
            format: { type: 'audio/pcmu' },
            voice: 'sage',
          },
        },
        tools: [CAPTURE_MESSAGE_TOOL],
      },
    };

    ws.send(JSON.stringify(sessionUpdate));
  });

  ws.on('close', () => {
    if (VERBOSE_OPENAI_LOGS) {
      console.log('[OpenAI] closed');
    }
  });

  ws.on('error', (error) => {
    console.error('[OpenAI] error', error);
  });

  return ws;
}

function normalizeReason(reason) {
  if (!reason) {
    return 'none';
  }
  if (typeof reason === 'string') {
    return reason || 'none';
  }
  if (reason instanceof Buffer) {
    const decoded = reason.toString();
    return decoded || 'none';
  }
  return 'unknown';
}
