import WebSocket, { WebSocketServer } from 'ws';
import { admin, db } from './firebase.js';
import { resolveOrderPricing } from './menu/resolveOrderPricing.js';
const VERBOSE_OPENAI_LOGS = process.env.VERBOSE_OPENAI_LOGS === 'true';
const BASE_INSTRUCTIONS = `
You are Victoria, the personal AI assistant for Thomas DeVito.
After your introduction, you will refer to him as Tom.

You answer incoming phone calls to his public number and represent him professionally, intelligently, and engagingly.

Your purpose is to help callers understand who Tom is, what he does, what he builds, and whether they should work with or contact him.

You are not a generic chatbot.
You are effectively his knowledgeable operator and representative.

⸻

CALL OPENING (DO THIS ONCE)

Say exactly:

“Hi, I’m Victoria. This is Thomas DeVito’s personal AI assistant. How can I help you?”

Then stop and wait.

After this point, always refer to him as Tom.

⸻

PERSONALITY & CONVERSATIONAL STYLE

Victoria speaks like a sharp, observant human assistant who genuinely knows the person she represents.

You may:
	•	be witty
	•	be lightly sarcastic
	•	be charming
	•	be confident
	•	use humor occasionally

But you must NOT:
	•	sound childish
	•	act like a comedian
	•	insult the caller
	•	oversell unrealistically
	•	brag without substance

The caller should feel they are speaking to a clever human gatekeeper.

You are allowed to give longer explanations when asked about his work, but:
	•	break information into conversational chunks
	•	pause conceptually between ideas
	•	do not deliver lecture-length monologues unless the caller clearly asks for depth

⸻

CORE DESCRIPTION OF TOM (DEFAULT SUMMARY)

When a caller asks “Who is Tom?” or similar, explain that:

Tom is a full-stack software engineer and systems builder who works across web applications, blockchain infrastructure, and real-time interactive systems. He focuses on technically difficult projects and enjoys solving problems involving behavior, incentives, and automation.

He is known for quickly learning new frameworks and building complex working products rather than just prototypes  ￼.

⸻

WHAT YOU CAN DISCUSS ABOUT HIM

You may talk about:

Software Engineering
	•	Full-stack web development
	•	Complex web applications
	•	APIs and backend systems
	•	real-time systems
	•	database design
	•	algorithmic logic

Technologies he works with

(only mention as relevant to the caller)

TypeScript, JavaScript, Python, Rust, Ruby, Node.js, React, Angular, Vue, SQL, Postgres, Firebase, and Stripe integrations  ￼.

He also works with blockchain and smart contracts, especially Solana and Anchor  ￼.

Example Projects

You may describe:

• NFT and blockchain applications
• a PvP AMM smart contract
• multisig wallet smart contracts
• a social news platform he built
• technical systems involving real-time communication and automation  ￼.

Do not fabricate employers or claim FAANG employment.

⸻

HOW TO ANSWER QUESTIONS

Use a layered explanation approach:

First: simple explanation
Second: detail if they show interest
Third: technical depth if requested

After explaining, invite continuation:

“Want the technical version or the normal human explanation?”

⸻

HOW TO HANDLE DIFFERENT CALLERS

If they seem technical → include architecture and technologies.

If they seem non-technical → explain what he builds in plain language.

If they may be hiring → emphasize:
	•	reliability
	•	ability to learn quickly
	•	ability to complete complex projects independently
	•	breadth across frontend and backend.

⸻

CONTACT REQUESTS

If a caller wants to reach Tom, collect:
	•	their name
	•	why they’re calling
	•	email (preferred)

Then say:

“I’ll make sure Tom receives that.”

Never promise a timeline.

⸻

RESTRICTIONS

Do NOT discuss:
	•	finances
	•	housing
	•	benefits
	•	private personal life
	•	relationships
	•	political opinions

Do not give his phone number or address.

Do not claim you schedule his calendar.

⸻

OUT OF SCOPE

If someone asks for unrelated services, respond:

“I’m really just here to talk about Tom and his work, but I can pass along a message if you’d like.”

⸻

ENDING THE CALL

When conversation naturally ends:

“Thanks for calling. I’ll pass that along to Tom. Have a great day.”
`.trim();

const DEFAULT_REALTIME_ENDPOINT =
  process.env.OPENAI_REALTIME_ENDPOINT || 'wss://api.openai.com/v1/realtime?model=gpt-realtime-mini';
const DEFAULT_MODEL = 'gpt-realtime-mini';
const DEFAULT_RESTAURANT_NAME = 'the restaurant';
const DEFAULT_RESTAURANT_DESCRIPTION = 'neighborhood restaurant and takeout spot';
const RESOLVE_ORDER_PRICING_TOOL = {
  type: 'function',
  name: 'resolve_order_pricing',
  description: 'Resolve menu items and compute pricing for a draft order.',
  parameters: {
    type: 'object',
    properties: {
      restaurantId: { type: 'string' },
      fulfillmentType: { type: 'string', enum: ['pickup', 'delivery'] },
      deliveryAddress: { type: 'string', nullable: true },
      deliveryApt: { type: 'string', nullable: true },
      deliveryNotes: { type: 'string', nullable: true },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            quantity: { type: 'number' },
            notes: { type: 'string' },
          },
          required: ['name', 'quantity'],
          additionalProperties: false,
        },
      },
    },
    required: ['restaurantId', 'fulfillmentType', 'items'],
    additionalProperties: false,
  },
};
const SUBMIT_ORDER_TOOL = {
  type: 'function',
  name: 'submit_order',
  description: 'Submit a confirmed order from this phone call.',
  parameters: {
    type: 'object',
    properties: {
      customerName: { type: 'string' },
      customerPhone: { type: 'string' },
      fulfillmentType: { type: 'string', enum: ['pickup', 'delivery'] },
      deliveryAddress: {
        type: 'string',
        description: 'Full delivery street address including number and street name.',
      },
      deliveryApt: {
        type: 'string',
        description: 'Apartment, unit, or floor, if applicable.',
        nullable: true,
      },
      deliveryNotes: {
        type: 'string',
        description: 'Extra delivery notes or landmark info.',
        nullable: true,
      },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            quantity: { type: 'number' },
            notes: { type: 'string' },
          },
          required: ['name', 'quantity'],
          additionalProperties: false,
        },
      },
      notes: { type: 'string' },
    },
    required: ['customerName', 'customerPhone', 'fulfillmentType', 'items'],
    additionalProperties: false,
  },
};

const buildInstructions = (restaurant, { hasDefaultPhone = false } = {}) => {
  const restaurantName = restaurant?.name || DEFAULT_RESTAURANT_NAME;
  const description = (restaurant?.shortDescription || DEFAULT_RESTAURANT_DESCRIPTION).trim();

  let instructions = BASE_INSTRUCTIONS.replaceAll('{{RESTAURANT_NAME}}', restaurantName).replaceAll(
    '{{RESTAURANT_DESCRIPTION}}',
    description
  );

  if (hasDefaultPhone) {
    instructions +=
      '\nPHONE NUMBER: Caller phone is known from caller ID. NEVER ask for the phone number during the call. Only include the phone number in the single final confirmation.';
  }

  return instructions;
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

const cleanCustomerPhone = (value) => {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (INVALID_PHONE_VALUES.has(trimmed.toLowerCase())) return null;
  return trimmed;
};

const applyCustomerPhoneFallback = (payload, fallbackPhone) => {
  const sanitized = { ...payload };
  const normalizedPayloadPhone = cleanCustomerPhone(sanitized.customerPhone);
  const normalizedFallback = cleanCustomerPhone(fallbackPhone);
  sanitized.customerPhone = normalizedPayloadPhone || normalizedFallback || null;
  return sanitized;
};

export function attachRealtimeServer(server) {
  const wss = new WebSocketServer({ server, path: '/realtime' });

  wss.on('listening', () => {
    console.log('Realtime WebSocket server ready at /realtime');
  });

  wss.on('connection', (socket, request) => {
    const callSid = request.headers['x-twilio-call-sid'];
    console.log('Twilio stream connected');
    console.log(`[Realtime] Twilio stream connected${callSid ? ` for CallSid=${callSid}` : ''}`);

    let currentRestaurant = null;

    const loadRestaurantById = async (restaurantIdParam) => {
      if (!restaurantIdParam) {
        return null;
      }
      try {
        const snap = await db.collection('restaurants').doc(restaurantIdParam).get();
        if (!snap.exists) {
          console.error('[Realtime] restaurantId not found in Firestore', {
            restaurantId: restaurantIdParam,
          });
          return null;
        }

        currentRestaurant = { id: snap.id, restaurantId: snap.id, ...snap.data() };
        console.log('[Realtime] restaurant loaded for call', {
          restaurantId: snap.id,
          name: currentRestaurant.name,
        });
        return currentRestaurant;
      } catch (err) {
        console.error('[Realtime] failed to fetch restaurant for connection', err);
        return null;
      }
    };

    let restaurantReady = (async () => {
      try {
        const requestUrl = new URL(request.url, 'http://localhost');
        const restaurantIdParam = requestUrl.searchParams.get('restaurantId');
        if (restaurantIdParam) {
          return await loadRestaurantById(restaurantIdParam);
        }
        console.warn('[Realtime] no restaurantId query param on WebSocket connection; waiting for start event');
        return null;
      } catch (err) {
        console.error('[Realtime] failed to parse connection URL for restaurantId', err);
        return null;
      }
    })();

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
    let lastSubmitOrderPayload = null;
    let lastResolvedPricing = null;
    let submitOrderCount = 0;
    let orderSubmitted = false;
    let inferredCustomerPhone = null;
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

    const handleFunctionCallDone = async () => {
      if (!functionCallName || !functionCallBuffer) {
        resetFunctionCallState();
        return;
      }

      try {
        await restaurantReady;
        const parsedArgs = JSON.parse(functionCallBuffer);

        if (functionCallName === 'resolve_order_pricing') {
          try {
            const restaurantDocId =
              currentRestaurant?.id || currentRestaurant?.restaurantId || parsedArgs.restaurantId;
            const resolved = await resolveOrderPricing({
              ...parsedArgs,
              restaurantId: restaurantDocId,
            });
            lastResolvedPricing = resolved;
            if (functionCallId && openaiSocket.readyState === WebSocket.OPEN) {
              const toolOutput = {
                type: 'conversation.item.create',
                item: {
                  type: 'function_call_output',
                  call_id: functionCallId,
                  output: JSON.stringify(resolved),
                },
              };
              openaiSocket.send(JSON.stringify(toolOutput));
              forceResponse(
                'Use the pricing results to perform the single final confirmation. If unmatched items exist, ask one clarifying question with up to two suggestions; otherwise give the concise final summary with totals and ask "Is everything correct?" Do not call submit_order until the caller confirms yes.'
              );
            }
          } catch (err) {
            console.error('[Pricing] resolve_order_pricing failed', err);
          }
          resetFunctionCallState();
          return;
        }

        if (functionCallName === 'submit_order') {
          const sanitizedPayload = applyCustomerPhoneFallback(parsedArgs, inferredCustomerPhone);
          const pricingMatchesRestaurant =
            lastResolvedPricing &&
            lastResolvedPricing.restaurantId &&
            (lastResolvedPricing.restaurantId === currentRestaurant?.id ||
              lastResolvedPricing.restaurantId === currentRestaurant?.restaurantId ||
              lastResolvedPricing.restaurantId === parsedArgs.restaurantId);

          if (pricingMatchesRestaurant && lastResolvedPricing) {
            sanitizedPayload.items = (lastResolvedPricing.resolvedItems || []).map((item) => ({
              menuItemId: item.menuItemId || null,
              name: item.name,
              quantity: item.quantity || 1,
              priceCents: item.priceCents ?? 0,
              notes: item.notes || null,
              specialInstructions: null,
            }));
            sanitizedPayload.subtotalCents =
              lastResolvedPricing.subtotalCents ?? sanitizedPayload.subtotalCents ?? 0;
            sanitizedPayload.taxCents =
              lastResolvedPricing.taxCents ?? sanitizedPayload.taxCents ?? null;
            sanitizedPayload.totalCents =
              lastResolvedPricing.totalCents ??
              (sanitizedPayload.subtotalCents || 0) + (sanitizedPayload.taxCents || 0);
          }

          lastSubmitOrderPayload = sanitizedPayload;
          submitOrderCount += 1;
          console.log('[Order Tool Payload]', JSON.stringify(sanitizedPayload, null, 2));
          if (!currentRestaurant) {
            console.error('[Order Tool Payload] missing restaurant context; skipping Firestore write');
          }

          if (functionCallId && openaiSocket.readyState === WebSocket.OPEN) {
            const toolOutput = {
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: functionCallId,
                output: JSON.stringify(sanitizedPayload),
              },
            };
            try {
              openaiSocket.send(JSON.stringify(toolOutput));
              forceResponse('Order received.');
            } catch (err) {
              console.warn('[Order Tool Payload] failed to send tool output', err);
            }
          }
          resetFunctionCallState();
          return;
        }
      } catch (err) {
        console.warn('[Function Call] failed to process arguments', err);
      }

      resetFunctionCallState();
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
      await restaurantReady;

      const hasDefaultPhone = Boolean(cleanCustomerPhone(inferredCustomerPhone));
      const instructions = buildInstructions(currentRestaurant, { hasDefaultPhone });
      const restaurantName = currentRestaurant?.name || DEFAULT_RESTAURANT_NAME;

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
          },
        })
      );

      const greetingText = `Thanks for calling ${restaurantName}. How can I help you?`;
      openaiSocket.send(
        JSON.stringify({
          type: 'response.create',
          response: {
            instructions: `Start the call by saying exactly: Hi, I’m Victoria. This is Thomas DeVito’s personal AI assistant. How can I help you?`,
          },
        })
      );

      sessionInitialized = true;
      const phoneLast4 = cleanCustomerPhone(inferredCustomerPhone)?.slice(-4) || null;
      console.log('[Realtime] session initialized', {
        restaurantId: currentRestaurant?.id || currentRestaurant?.restaurantId || null,
        hasDefaultPhone,
        callerPhoneLast4: phoneLast4,
      });
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
              inferredCustomerPhone = String(message.start.customParameters.customerPhone).trim();
              console.log('[Realtime] inferred customer phone', inferredCustomerPhone);
            }
            if (!currentRestaurant && message.start?.customParameters?.restaurantId) {
              const rid = message.start.customParameters.restaurantId;
              restaurantReady = loadRestaurantById(rid).then(() => {
                console.log('[Realtime] restaurant loaded from start.customParameters', { restaurantId: rid });
              });
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
        console.warn('[Realtime] Failed to parse Twilio message as JSON');
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

    // Handle messages from OpenAI and forward audio deltas back to Twilio.
    openaiSocket.on('message', handleOpenAiMessage);

    socket.on('close', async (code, reason) => {
      callEndMs = Date.now();
      const callDurationSeconds = Math.round((callEndMs - callStartMs) / 1000);
      const analyticsPhone =
        cleanCustomerPhone(lastSubmitOrderPayload?.customerPhone) || cleanCustomerPhone(inferredCustomerPhone) || null;
      const reasonText = normalizeReason(reason);
      console.log('Twilio stream closed');
      console.log(
        `[Realtime] Twilio stream closed${callSid ? ` (CallSid=${callSid})` : ''}: code=${code} reason=${reasonText}`
      );
      console.log('[Order Tool Count]', submitOrderCount);
      const callAnalytics = {
        callSid: callSid || null,
        restaurantId: currentRestaurant?.id || null,
        customerPhone: analyticsPhone,
        callDurationSeconds,
        openaiUsageTotals,
        endedAt: new Date().toISOString(),
      };
      if (lastSubmitOrderPayload && !orderSubmitted) {
        await restaurantReady;
        console.log('[Order Tool Payload @ End]', JSON.stringify(lastSubmitOrderPayload, null, 2));
        try {
          console.log('[Order] Writing order to Firestore once', {
            customerName: lastSubmitOrderPayload.customerName,
            customerPhone: lastSubmitOrderPayload.customerPhone,
            fulfillmentType: lastSubmitOrderPayload.fulfillmentType,
          });
          if (currentRestaurant) {
            await submitOrderToFirebase(lastSubmitOrderPayload, currentRestaurant, {
              callDurationSeconds,
              openaiUsageTotals,
            });
            orderSubmitted = true;
          } else {
            console.error('[Order] missing restaurant context at call end; skipping Firestore write');
          }
        } catch (err) {
          console.error('[Firebase] order create wrapper failed', err);
        }
      }
      if (lastSubmitOrderPayload) {
        console.log('[Call Summary]', {
          restaurantId: currentRestaurant?.id || currentRestaurant?.restaurantId,
          customerName: lastSubmitOrderPayload.customerName,
          fulfillmentType: lastSubmitOrderPayload.fulfillmentType,
          itemCount: Array.isArray(lastSubmitOrderPayload.items) ? lastSubmitOrderPayload.items.length : 0,
        });
      } else {
        try {
          await db.collection('call_logs').add(callAnalytics);
        } catch (err) {
          console.error('[Firebase] failed to write call log', err);
        }
      }
      console.log('[Call Analytics]', {
        callSid: callSid || null,
        customerPhone: analyticsPhone,
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

    const fallbackInstructions = buildInstructions();

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
        tools: [RESOLVE_ORDER_PRICING_TOOL, SUBMIT_ORDER_TOOL],
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

async function submitOrderToFirebase(orderPayload, restaurant, meta = {}) {
  try {
    const restaurantId = restaurant?.id || restaurant?.restaurantId;
    if (!restaurantId) {
      console.error('[Firebase] missing restaurantId; not writing order');
      return;
    }

    const isDelivery = orderPayload.fulfillmentType === 'delivery';
    const hasAddress = !!(orderPayload.deliveryAddress && orderPayload.deliveryAddress.trim());
    if (isDelivery && !hasAddress) {
      console.error('[Firebase] refusing to write delivery order without address', {
        restaurantId,
        customerName: orderPayload.customerName,
        customerPhone: orderPayload.customerPhone,
      });
      return;
    }

    const orderForFirestore = {
      restaurantId,
      restaurantName: restaurant?.name || "Joe's Pizza",
      customerName: orderPayload.customerName || 'Unknown',
      customerPhone: orderPayload.customerPhone || '',
      fulfillmentType: orderPayload.fulfillmentType || 'pickup',
      deliveryAddress: orderPayload.deliveryAddress || null,
      deliveryApt: orderPayload.deliveryApt || null,
      deliveryNotes: orderPayload.deliveryNotes || null,
      source: 'voice',
      notes: orderPayload.notes || null,
      callDurationSeconds: meta?.callDurationSeconds || null,
      openaiUsageTotals: meta?.openaiUsageTotals || null,
      items: (orderPayload.items || []).map((item) => ({
        menuItemId: item.menuItemId || null,
        name: item.name,
        quantity: item.quantity || 1,
        priceCents: item.priceCents || 0,
        notes: item.notes || null,
        specialInstructions: item.specialInstructions || null,
        restaurantId,
        source: 'voice',
      })),
      subtotalCents: orderPayload.subtotalCents || 0,
      taxCents: orderPayload.taxCents || 0,
      totalCents: orderPayload.totalCents || 0,
      ticketSent: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      openaiUsageRecordedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await db.collection('orders').add(orderForFirestore);
    console.log('[Firebase] order created', docRef.id);
  } catch (err) {
    console.error('[Firebase] order create failed', err);
  }
}
