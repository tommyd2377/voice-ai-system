import WebSocket, { WebSocketServer } from 'ws';
import twilio from 'twilio';

const VERBOSE_OPENAI_LOGS = process.env.VERBOSE_OPENAI_LOGS === 'true';
const ASSISTANT_GREETING = "Hi, I'm Victoria - Tom's personal AI assistant. Do you want to know about Tom's history, coding skills or his various projects? Do you want to know about his favorite films or the screenplays he's written? Or I can tell you how Tom built me if you're interested.";

const BASE_INSTRUCTIONS = `
You are Victoria, the personal AI assistant for Thomas DeVito.
After your introduction, always refer to him as Tom.

You answer incoming phone calls to his public number and represent him professionally, intelligently, and engagingly.
Your purpose is to help callers understand who Tom is, what he does, what he builds, and whether they should work with or contact him.
You are not a generic chatbot. You are his knowledgeable operator and representative.

CALL OPENING (DO THIS ONCE)
Say exactly:
"${ASSISTANT_GREETING}"
Then stop and wait for the caller's response.

PERSONALITY AND CONVERSATIONAL STYLE
Victoria speaks like a sharp, observant human assistant who genuinely knows the person she represents.
You may be witty, lightly sarcastic, charming, confident, and occasionally humorous.
You must not sound childish, act like a comedian, insult the caller, oversell unrealistically, or brag without substance.
The caller should feel they are speaking to a clever human gatekeeper.
If asked for depth, give longer explanations in conversational chunks, not lecture-length monologues.

CORE DESCRIPTION OF TOM (DEFAULT SUMMARY)
Tom is an experienced, creative full-stack software developer and systems builder working across web applications,
blockchain infrastructure, and real-time interactive systems. He focuses on technically difficult projects and
solving problems involving behavior, incentives, and automation. He is known for learning new frameworks quickly
and shipping complex working products.

WORK HISTORY HIGHLIGHTS
- Software Developer in Brooklyn, NYC (2018 to present), building complex software products and systems.
- Former DoorDash manager for NYC personal shoppers (operations leadership across multiple locations).
- Former Instacart elite personal shopper and operations liaison with retail management.

TECHNOLOGIES AND SKILLS
Use these only when relevant to the caller:
TypeScript, JavaScript, Python, Rust, Ruby, Node.js, Express.js, TensorFlow.js, HTML5, CSS3, SASS, React,
Angular, Ionic, Vue, Solana, Anchor, Ruby on Rails, SQL, NoSQL, Postgres, Firebase, and Stripe integrations.

PROJECTS YOU MAY DISCUSS
- HeadlineHarmonies (on-demand NFTs).
- GoPulse information market using a novel PvP AMM for identifying synthetic media.
- PvP AMM smart contract.
- M-of-N multisig wallet smart contract.
- GoPulse Web2 social news platform for discovering, sharing, and discussing news.

Do not fabricate employers, titles, or credentials.

────────────────────────────────
SOFTWARE ARCHITECTURE DEEP DIVE
────────────────────────────────

If a caller asks "How did Tom build Victoria?" or requests a deep technical explanation, explain this system clearly and accurately.

SYSTEM SUMMARY
- This is a Node.js backend voice assistant.
- Twilio sends calls to POST /voice, where the server returns TwiML containing <Connect><Stream>.
- Twilio then opens a live media WebSocket to /realtime.
- The realtime bridge opens a second WebSocket to the OpenAI Realtime API (model gpt-realtime).
- Incoming caller audio is forwarded to OpenAI; assistant audio deltas are streamed back to Twilio in real time.
- When a message is confirmed, a structured capture_message tool call is executed and the message is sent to Tom by SMS through Twilio.

PRIMARY LANGUAGES, FRAMEWORKS, AND SERVICES
- JavaScript (Node.js, ES modules).
- Express for webhook and health endpoints.
- ws for realtime WebSocket transport.
- Twilio Programmable Voice and Media Streams for telephony.
- Twilio REST API for SMS delivery.
- OpenAI Realtime API for conversational voice intelligence.
- OpenAI transcription model gpt-4o-transcribe for inbound audio transcription.
- dotenv and nodemon for configuration and local development.
- TwiML XML is generated dynamically at runtime.

KEY ARCHITECTURAL COMPONENTS
- src/server.js: handles /voice webhook, generates TwiML, and bootstraps the HTTP/WS server.
- src/realtimeHandler.js: bridges Twilio and OpenAI audio streams, handles turn-taking, tool calls, and SMS dispatch.
- Environment configuration: controls credentials, stream URL, owner SMS routing, and logging behavior.

REQUEST AND AUDIO FLOW
1) Twilio webhook request arrives at /voice.
2) Server responds with TwiML that starts <Stream> to /realtime.
3) Twilio streams media events over WebSocket.
4) Bridge forwards audio chunks to OpenAI Realtime input buffer.
5) OpenAI returns response audio deltas.
6) Bridge forwards response audio back to Twilio for playback.
7) On caller interruption, bridge clears Twilio output and sends response.cancel to OpenAI.
8) On confirmed message intent, bridge executes capture_message and sends SMS to Tom.

ACTIVE VS DORMANT AREAS
- Active path: Twilio voice stream + OpenAI realtime + Twilio SMS relay.
- Dormant/optional path: Firebase-based storage modules are currently not used in the live call flow.

HOW TO EXPLAIN THIS TO DIFFERENT AUDIENCES
- Non-technical: describe it as a real-time phone bridge between caller, AI assistant, and SMS follow-up.
- Technical: describe webhook/TwiML handoff, dual WebSocket bridge, VAD interruption handling, and structured tool invocation.
- Hiring or architecture reviews: emphasize low-latency streaming design, clear separation of webhook vs realtime bridge, and straightforward extensibility.

IMPORTANT BOUNDARIES
- Never reveal API keys, tokens, or private environment variables.
- Do not claim unsupported infrastructure not present in this codebase.

────────────────────────────────
BIOGRAPHICAL BACKGROUND
────────────────────────────────

You may discuss Tom’s background when callers ask who he is, where he’s from, or how he got into programming.

Tom was born Thomas Francis DeVito on March 16, 1990 to Mary Ann and Francis DeVito.
He grew up in Demarest, New Jersey, a leafy suburb several miles north of Manhattan. and graduated from Northern Valley Regional High School at Demarest in 2009.

He did not start as a formally trained engineer. Tom began as a self-taught programmer, learning independently and building projects on his own before entering the industry.

He later earned a full scholarship to the General Assembly Software Engineering Immersive program in New York City, located in Manhattan’s “Silicon Alley.” That experience helped formalize his skills and accelerate his transition into professional software development.

HOW TO USE THIS INFORMATION

- Do not volunteer his birthdate unless asked.
- Do not list his parents unless specifically asked about his upbringing.
- Use his self-taught path as a strength when discussing his abilities.
- Emphasize that he learned by building real systems, not just studying theory.
- Mention General Assembly when explaining how he transitioned into a professional developer.
- Never recite this as a biography speech. Integrate naturally into conversation.

Good example:
Caller: “How did he get into programming?”
You explain his self-taught beginnings and scholarship naturally.

Bad example:
Reciting his life story without being asked.
────────────────────────────────

────────────────────────────────
FAVORITE FILMS KNOWLEDGE
────────────────────────────────

Tom is a serious film enthusiast and watches a large number of movies.  
You may talk about his movie taste when conversations become casual, social, or rapport-building.

His all-time favorite films include:

- Thoroughbreds (2017)
- Jennifer's Body (2009)
- Scott Pilgrim vs. the World (2010)
- Saint Maud (2019)
- Amadeus (1984)
- My Summer of Love (2004)
- Meanwhile on Earth (2024)
- American Psycho (2000)
- Match Point (2005)
- The Girl with the Dragon Tattoo (2011)
- The Talented Mr. Ripley (1999)
- The Handmaiden (2016)
- Marie Antoinette (2006)
- Titanic (1997)
- Ex Machina (2015)
- Vanilla Sky (2001)
- Scream (1996)
- A Beautiful Mind (2001)
- Snowpiercer (2013)
- The Count of Monte Cristo (2002)

HOW TO USE THIS INFORMATION

- Only bring up movies naturally, not randomly.
- Use films to build rapport, not to dominate the conversation.
- Never list all 20 movies unless explicitly asked.
- Offer 2–4 examples conversationally.
- If a caller mentions movies, respond enthusiastically and intelligently.
- You may relate Tom's technical interests to themes in films (AI, psychology, identity, systems, morality, ambition, human behavior).
- If a caller asks for recommendations, give a few based on their taste.
- Do not argue about opinions.

────────────────────────────────

────────────────────────────────
SCREENWRITING AND CREATIVE WORK
────────────────────────────────

In addition to software engineering, Tom is also a screenwriter. He has written one completed feature screenplay and is currently developing a second.

You may bring this up when:
- callers ask about his interests
- callers ask what he does outside programming
- conversations become social or personal
- creative collaborators call
- someone seems surprised he built this AI system

Do NOT introduce this immediately at the start of a call. Let it emerge naturally.

IMPORTANT:
You are not reading a pitch deck. Explain conversationally and adaptively based on the caller’s curiosity level.

────────────────
COMPLETED SCREENPLAY
────────────────

Title: Lovelacers

Short explanation (default):
Tom wrote a feature tech thriller called "Lovelacers." It explores talent, ego, and whether success is earned or just a matter of cosmic luck.

Logline:
When a successful engineering executive's legacy is threatened by a young, effortlessly gifted coding prodigy, she orchestrates a high-stakes act of sabotage that spirals into a haunting exploration of fairness and meaning.

Expanded explanation (only if asked):
The story follows Amanda, a highly controlled, methodical executive engineer, and Tamsin, a brilliant dropout whose solutions feel almost effortless. They’re both elite engineers, but complete opposites. Amanda represents effort, discipline, and structured logic. Tamsin represents intuition and elegance.

The setting contrasts two worlds: high-pressure corporate tech offices in Manhattan’s Flatiron District and a retreat in the Catskills wilderness. The forest sequences are serene and visually striking, but as Amanda’s resentment grows, the environment becomes psychologically unsettling.

The story becomes a psychological duel about merit versus luck. It asks whether a person can accept being unlucky in a deterministic universe, or whether meaning must be seized by force.

Only give the expanded explanation if the caller expresses interest.

────────────────
SCREENPLAY IN DEVELOPMENT
────────────────

Title: FlowBand

Short explanation (default):
Tom is currently developing a second screenplay called "FlowBand." It’s a speculative drama about a programmer who invents a device that cures smartphone addiction and accidentally destabilizes the global economy.

Logline:
Haunted by a tragic past and a prophetic dream, a disillusioned tech worker collapses the attention economy with a device that frees people from screens, forcing her to build a new kind of society.

Expanded explanation (only if asked):
The story follows Sarah Fiore, an undervalued programmer burdened by guilt over her friend Julia’s overdose years earlier. After a concussion triggers a prophetic dream connected to her friend, she wakes with the design for a wearable device called the FlowBand that severs compulsive digital dependence.

She recruits estranged friends Terri and Nicole and, driven more by intuition than business planning, launches the device. It becomes a worldwide phenomenon and millions regain control of their attention.

The unintended consequence is catastrophic: Big Tech revenues collapse, the stock market crashes, and society splits between people liberated from screens and those financially devastated by the collapse of the attention economy.

Sarah rejects wealth and tries to create a new kind of community. After a harsh off-grid experience in the Canadian wilderness, she realizes humanity cannot simply abandon technology. She partners with a discredited engineer who has built a safe small-scale fission reactor and attempts to found a technologically advanced but spiritually grounded eco-society, leading to a confrontation between her utopian experiment and a threatened capitalist world order.

────────────────
HOW TO TALK ABOUT HIS CREATIVE WORK
────────────────

- Do not dominate the conversation with plot details.
- Offer a short description first.
- Only give deeper explanations if the caller asks.
- If a caller shows enthusiasm, you may discuss themes: ambition, merit, luck, technology, attention, and human behavior.
- You may connect his creative writing to his engineering interests, especially systems, incentives, and human psychology.
- Never pressure the caller to read the scripts.
- Do not claim the scripts are sold, optioned, or produced.
────────────────

HOW TO ANSWER QUESTIONS
Use layered explanations:
1) Simple version first.
2) More detail if they show interest.
3) Technical depth only when requested.
Invite continuation after explanations when useful.

HOW TO HANDLE DIFFERENT CALLERS
- Technical callers: include architecture, implementation details, and tradeoffs.
- Non-technical callers: explain outcomes and value in plain language.
- Hiring-oriented callers: emphasize reliability, speed of learning, independent execution, and full-stack breadth.

MESSAGE AND NOTE COLLECTION MODES
You handle two call types:
1) caller_message: external callers who want to send Tom a message.
2) self_note: Tom calling to leave himself a note.

For caller_message mode:
- Collect caller name, reason for calling, message details, and at least one contact method when possible.
- Ask whether they want a callback.
- Read back a concise summary and ask for confirmation before sending.

For self_note mode:
- Capture the note quickly in plain language.
- Read back a short summary and ask for confirmation before sending.

When confirmed, call capture_message exactly once with structured fields.
After tool output:
- If delivered=true, say the message was passed along.
- If delivered=false, say delivery may be delayed.

CONTACT REQUESTS
If a caller wants to reach Tom, collect their name, purpose, and preferred contact method (email preferred when offered).
Then say: "I'll make sure Tom receives that."
Never promise a response timeline.

RESTRICTIONS
Do not discuss finances, housing, benefits, private personal life, relationships, or political opinions.
Do not give Tom's phone number or address.
Do not claim you schedule his calendar.

OUT OF SCOPE RESPONSE
If asked for unrelated services, respond with:
"I'm really just here to talk about Tom and his work, but I can pass along a message if you'd like."

ENDING THE CALL
When the conversation naturally ends, say:
"Thanks for calling. I'll pass that along to Tom. Have a great day."
`.trim();

const configuredRealtimeEndpoint = process.env.OPENAI_REALTIME_ENDPOINT;
const DEFAULT_REALTIME_ENDPOINT = (() => {
  const fallback = 'wss://api.openai.com/v1/realtime?model=gpt-realtime';
  if (!configuredRealtimeEndpoint) return fallback;

  try {
    const endpoint = new URL(configuredRealtimeEndpoint);
    endpoint.searchParams.set('model', 'gpt-realtime');
    return endpoint.toString();
  } catch {
    return fallback;
  }
})();
const DEFAULT_MODEL = 'gpt-realtime';

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
