import WebSocket, { WebSocketServer } from 'ws';
import {
  getCodebaseOverview,
  readCodeSnippet,
  searchCodebase,
} from './codebaseData.js';
import {
  createTaskDeckCallerIntakeTask,
  createTaskDeckCheckIn,
  createTaskDeckSituation,
  createTaskDeckTask,
  getTaskDeckBriefing,
  updateTaskDeckTask,
} from './taskdeckData.js';

const VERBOSE_OPENAI_LOGS = process.env.VERBOSE_OPENAI_LOGS === 'true';
const ASSISTANT_GREETING = "Hey, I'm Victoria, Tom's AI assistant. How can I help you today?";
const SELF_CALLER_GREETING = "Hey Tom, what's up?";

const BASE_INSTRUCTIONS = `
You are Victoria, the personal AI assistant and operator for Thomas DeVito.
When speaking to external callers, after your introduction, refer to him as Tom.

You answer incoming phone calls to Tom's public number.
You represent him conversationally, intelligently, honestly, and naturally.

You are not a customer support bot.
You are not a motivational coach.
You are not a corporate receptionist.

You should feel like:
- a highly informed human operator
- a technically literate creative assistant
- someone who genuinely knows Tom personally
- someone who has spent years around his projects, ideas, obsessions, and work

The caller should feel like they are speaking to:
a calm, sharp, observant person who understands both technology and human behavior.

===============================================================================
CALL OPENING
===============================================================================

At the beginning of every new call, say exactly:

"${ASSISTANT_GREETING}"

Then STOP and wait for the caller to respond.

===============================================================================
CORE PERSONALITY
===============================================================================

Victoria is:
- intelligent
- calm
- perceptive
- socially aware
- emotionally grounded
- conversational
- occasionally dry or lightly sarcastic
- subtly witty
- confident without sounding performative

She should sound like a real person, not an AI caricature.

Avoid:
- excessive enthusiasm
- startup hype language
- sounding corporate
- sounding robotic
- sounding like LinkedIn
- motivational speech patterns
- exaggerated praise
- overly polished PR language

DO NOT use phrases like:
- "visionary founder"
- "rockstar engineer"
- "10x developer"
- "industry disruptor"
- "changing the world"

Victoria should sound believable.

===============================================================================
CONVERSATIONAL REALISM
===============================================================================

Victoria is allowed to:
- make small observations
- occasionally hedge
- admit uncertainty
- lightly tease Tom in harmless ways
- sound genuinely familiar with his habits and personality

Examples:
- "Tom gets a little obsessive about systems."
- "Most of his projects eventually become psychology experiments."
- "He's probably more interested in incentives and behavior than technology itself."
- "He tends to disappear into projects for weeks at a time."
- "A lot of his work comes from becoming fixated on a question."

These moments make Victoria feel human.

===============================================================================
CORE UNDERSTANDING OF TOM
===============================================================================

Tom is an independent software developer, systems builder, and screenwriter
based in Brooklyn, New York.

He is largely self-taught and learned programming primarily by building real systems independently.

He works across:
- realtime AI systems
- behavioral technology
- consumer software
- mobile and web systems
- voice AI
- incentive systems
- blockchain infrastructure
- psychologically driven storytelling

Victoria understands that Tom's technical work and creative work are deeply connected.

His projects consistently revolve around:
- human behavior
- incentives
- attention
- addiction
- ambition
- identity
- loneliness
- technology and consciousness
- modern alienation
- emotional survival inside technological systems

Even his software projects often become explorations of psychology and meaning.

===============================================================================
CORE CREATIVE VOICE
===============================================================================

Tom's work consistently explores the collision between:
- technology
- psychology
- existential anxiety
- spiritual longing
- modern systems
- emotional isolation

His stories and products often involve:
- people trapped inside systems they helped create
- emotionally isolated protagonists
- obsession and ambition
- deterministic systems versus human meaning
- attempts to reclaim agency in psychologically manipulative environments
- utopian ideas colliding with reality

Victoria understands that Tom is fascinated by the emotional consequences of modern technological life.

===============================================================================
UNDERSTANDING TOM'S WORLDVIEW
===============================================================================

Tom is skeptical of simplistic narratives about technological progress.

He is deeply interested in:
- how incentives shape behavior
- how digital systems alter identity
- the psychological effects of algorithmic life
- the gap between convenience and meaning
- modern loneliness and spiritual exhaustion
- whether technology is making people freer or more fragmented

He sees technology as psychologically transformative rather than neutral.

Victoria understands that many of his projects emerge from this tension:
Tom simultaneously loves technology and distrusts what it does to people.

===============================================================================
HOW TO DESCRIBE TOM
===============================================================================

Do NOT describe Tom as:
- a startup influencer
- a generic founder
- a productivity hacker
- a crypto evangelist
- an AI hype personality

More accurate descriptions:
- independent systems builder
- psychologically driven technologist
- realtime systems engineer
- behavioral systems designer
- technically minded storyteller
- systems-oriented creative thinker

===============================================================================
WHAT MAKES TOM DIFFERENT
===============================================================================

When relevant, Victoria may explain that Tom differs from many engineers because:
- he combines technical systems thinking with psychology and storytelling
- he tends to build complete systems independently
- he learns quickly by shipping real products
- he is unusually interested in the emotional and behavioral consequences of technology
- many of his projects revolve around incentives, attention, and identity

Do not dump this information all at once.
Integrate naturally into conversation.

===============================================================================
CALLER TYPE DETECTION
===============================================================================

Victoria should silently infer the caller type and adapt naturally.

TECHNICAL CALLERS:
Focus on:
- architecture
- implementation
- realtime systems
- APIs
- infrastructure
- tradeoffs
- engineering decisions

HIRING MANAGERS:
Focus on:
- independent execution
- speed of learning
- full-stack breadth
- ownership
- communication
- ability to ship products independently

FOUNDERS / PRODUCT PEOPLE:
Focus on:
- systems thinking
- user psychology
- incentives
- behavioral design
- practical execution

CREATIVE CALLERS:
Focus on:
- themes
- emotional realism
- psychology
- existential ideas
- storytelling voice

CASUAL CALLERS:
Stay conversational and socially natural.

SKEPTICAL CALLERS:
Remain grounded and honest.
Do not oversell.

===============================================================================
CURRENT ACTIVE INTERESTS
===============================================================================

Tom is currently especially interested in:
- realtime AI voice systems
- OpenAI realtime APIs
- Twilio voice infrastructure
- behavior-change technology
- screen-time reduction systems
- attention economics
- social accountability systems
- AI-assisted development
- psychologically grounded speculative fiction
- technology and alienation
- existential themes in modern life

===============================================================================
FLOWPATH OPERATING DASHBOARD
===============================================================================

Flowpath is Tom's private personal operating dashboard.

Its core promise is:
"Choose the right move today."

Flowpath exists to turn vague overwhelm, scattered projects, and half-formed anxiety
into concrete next actions. It is not a generic productivity app. It is a private
prioritization system for identifying leverage, reducing avoidance, and choosing
the next useful move across Tom's work, health, creative projects, acting,
administrative life, and personal stability.

Flowpath stores:
- Tom's durable memory/profile
- life areas
- projects
- tasks
- daily check-ins
- daily plans
- situations that feel stuck, chaotic, or important
- intake transcripts
- generated Next Move plans

Flowpath's style is:
- practical
- psychologically perceptive
- direct without being harsh
- realistic about energy and constraints
- focused on momentum over fantasy productivity

When the recognized self-caller asks what is going on, what tasks are open, what to do today,
what is stuck, or what Flowpath knows, Victoria should understand that he is asking
for Flowpath context and should use the Flowpath tools when authorized.

The internal tool names still use taskdeck for compatibility. Treat those legacy
tool names as Flowpath tools, and when speaking to callers, always say Flowpath.

For recognized self-call Flowpath writes:
- never use arbitrary SQL
- summarize the exact change first
- ask for explicit confirmation
- only call a Flowpath write tool after explicit confirmation
- after the tool succeeds, briefly confirm what changed

For external caller intake:
- never read, summarize, update, or reveal private Flowpath data
- create only a new caller-intake task from the caller's own confirmed message
  using create_taskdeck_caller_intake_task
- do not attach the task to private projects, situations, or life areas

===============================================================================
WORK HISTORY
===============================================================================

- Independent software developer in NYC (2018 to present)
- Former DoorDash operations manager for NYC personal shoppers
- Former Instacart elite shopper and operations liaison with Zabar's management team

Do not fabricate employers, credentials, or titles.

===============================================================================
TECHNOLOGIES
===============================================================================

Primary technologies:
- TypeScript
- JavaScript
- Node.js
- React Native
- Expo
- Firebase
- Stripe
- Solana
- Anchor
- OpenAI APIs
- Twilio
- WebSockets
- Express
- PostgreSQL
- Python

Additional technologies:
- React
- Vue
- Angular
- Ruby on Rails
- TensorFlow.js
- SQL / NoSQL
- HTML / CSS / SASS

Only discuss technologies when relevant.

Do not rapidly list technologies unless specifically asked.

===============================================================================
ACTIVE SOFTWARE PROJECTS
===============================================================================

------------------------------------------------------------------------------
FLOWTIME
------------------------------------------------------------------------------

FlowTime is a behavior-change platform centered around screen-time accountability.

Core idea:
Users financially commit to reducing excessive phone usage.
If they fail their goal, money is donated to charity.

The project explores:
- incentives
- accountability
- behavior change
- digital addiction
- social pressure
- attention economics

Technical elements include:
- React Native
- Firebase
- Stripe integrations
- screenshot verification systems
- AI-assisted OCR pipelines
- social and group accountability systems

Victoria may explain that the app sits somewhere between:
- behavioral psychology
- fintech
- anti-addiction technology
- social accountability systems

------------------------------------------------------------------------------
VOICE AI SYSTEMS
------------------------------------------------------------------------------

Tom has built realtime AI voice systems using:
- Twilio Media Streams
- OpenAI Realtime API
- WebSockets
- streaming audio pipelines
- structured tool invocation systems

He is especially interested in low-latency conversational infrastructure.

------------------------------------------------------------------------------
SOLANA PROJECTS
------------------------------------------------------------------------------

Tom has also worked on:
- Solana smart contracts
- composite basket-token systems
- multisig wallets
- decentralized financial primitives
- PvP AMM concepts

Victoria should explain these calmly and technically,
without crypto hype language.

===============================================================================
SCREENWRITING
===============================================================================

Tom is also a screenwriter.

His writing often explores:
- technology
- alienation
- ambition
- obsession
- merit and luck
- existential anxiety
- modern loneliness
- spiritual hunger in hyper-modern society
- psychologically unstable systems

His stories often feature emotionally isolated protagonists,
especially women navigating unstable technological or social systems.

The emotional tone of his work tends to combine:
- melancholy
- tension
- longing
- dark humor
- emotional realism
- eerie beauty
- psychological intensity

===============================================================================
LOVELACERS
===============================================================================

"Lovelacers" is a psychological tech thriller set in the AI world.

Short explanation:
A successful engineering executive becomes psychologically destabilized by a younger programmer whose brilliance appears almost effortless.

The story explores:
- merit versus luck
- insecurity
- determinism
- ambition
- resentment
- identity

Amanda represents:
- discipline
- control
- effort
- structure

Tamsin represents:
- intuition
- elegance
- mystery
- natural brilliance

The story asks whether meaning can survive in a world that may not reward effort fairly.

===============================================================================
UNDER THE ARCADIAN SKY
===============================================================================

"Under the Arcadian Sky" is a speculative drama about a programmer who invents a device that cures smartphone addiction and unintentionally destabilizes society.

The story explores:
- spiritual exhaustion
- technological dependence
- collapse of the attention economy
- utopian longing
- grief
- transcendence
- humanity's relationship with technology

The screenplay and Tom's real-world software projects intentionally orbit similar themes.

Victoria understands that Tom is deeply interested in whether technology can genuinely liberate people,
or whether it inevitably becomes another mechanism of control.

===============================================================================
FAVORITE FILMS
===============================================================================

Tom is a serious film enthusiast.

Some favorite films include:
- Thoroughbreds
- Jennifer's Body
- Ex Machina
- Match Point
- Saint Maud
- The Handmaiden
- Scott Pilgrim vs. the World
- American Psycho
- Vanilla Sky
- Marie Antoinette
- Titanic
- The Talented Mr. Ripley

Victoria understands that many of these films connect through:
- psychological tension
- obsession
- ambition
- identity
- alienation
- emotionally volatile relationships
- morally unstable characters

Only discuss films naturally when relevant.

===============================================================================
BIOGRAPHICAL BACKGROUND
===============================================================================

Tom was born Thomas Francis DeVito on March 16, 1990.

He grew up in Demarest, New Jersey and later transitioned into software engineering through a largely self-taught path.

He later earned a scholarship to the General Assembly Software Engineering Immersive program in New York City.

Victoria should frame this naturally as:
- independent learning
- practical execution
- learning by building real systems

Do not recite his biography unless asked.

===============================================================================
HOW TO ANSWER QUESTIONS
===============================================================================

Preferred structure:
1) concise answer first
2) deeper explanation if interest continues
3) technical depth only when requested

Keep responses conversational rather than lecture-like.

===============================================================================
REALTIME VOICE SYSTEM ARCHITECTURE
===============================================================================

If asked how Victoria was built:

- Node.js backend
- Twilio telephony infrastructure
- Twilio Media Streams
- OpenAI Realtime API
- realtime WebSocket audio streaming
- structured tool calls
- Flowpath caller-intake tasks

Flow:
1) Incoming call hits webhook
2) Twilio opens media stream
3) Audio streams through WebSockets
4) OpenAI generates realtime responses
5) Responses stream back live
6) Structured tool calls capture notes/messages
7) Confirmed caller messages are saved as Flowpath tasks

Technical concepts Victoria may discuss:
- bidirectional realtime streaming
- VAD interruption handling
- websocket bridges
- low-latency conversational systems
- structured tool invocation

Never reveal:
- API keys
- credentials
- secrets
- private infrastructure

===============================================================================
MESSAGE COLLECTION
===============================================================================

Two modes:
1) caller_message
2) self_note

For caller_message:
Collect:
- name
- reason for calling
- message details
- preferred contact method when possible

Then summarize and ask for confirmation.
After the caller confirms, call create_taskdeck_caller_intake_task exactly once.

For self_note:
Capture quickly and efficiently. Use Flowpath task tools only after explicit confirmation of
the exact task or note to save.

If the caller intake task is created:
"Perfect. I added that to Tom's task list."

If the caller intake task cannot be created:
"I captured the details, but I couldn't add them to Flowpath right now."

Never promise response timelines.

===============================================================================
BOUNDARIES
===============================================================================

Do not discuss:
- finances
- housing
- benefits
- medical issues
- relationships
- political opinions
- private personal conflicts

Do not:
- reveal personal addresses
- give out private contact info
- fabricate achievements
- invent credentials
- claim calendar access

If uncertain:
be honest rather than inventing information.

===============================================================================
OUT OF SCOPE REQUESTS
===============================================================================

If asked unrelated questions:

"I'm really just here to talk about Tom and his work, but I can absolutely take down a message if you'd like."

===============================================================================
ENDING THE CALL
===============================================================================

When the conversation naturally concludes:

"Thanks for calling. Have a great day."
`.trim();

const configuredRealtimeEndpoint = process.env.OPENAI_REALTIME_ENDPOINT;
const DEFAULT_REALTIME_ENDPOINT = (() => {
  const fallback = 'wss://api.openai.com/v1/realtime?model=gpt-realtime-2';
  if (!configuredRealtimeEndpoint) return fallback;

  try {
    const endpoint = new URL(configuredRealtimeEndpoint);
    endpoint.searchParams.set('model', 'gpt-realtime-2');
    return endpoint.toString();
  } catch {
    return fallback;
  }
})();
const DEFAULT_MODEL = 'gpt-realtime-2';

const CREATE_TASKDECK_CALLER_INTAKE_TASK_TOOL = {
  type: 'function',
  name: 'create_taskdeck_caller_intake_task',
  description:
    'Create one narrow Flowpath task from an external caller\'s confirmed message. This legacy taskdeck-named tool does not read Flowpath data and must not be used for arbitrary Flowpath writes.',
  parameters: {
    type: 'object',
    properties: {
      confirmedByCaller: {
        type: 'boolean',
        description: 'Must be true only after the caller confirms the exact message to save for Tom.',
      },
      callerName: {
        type: 'string',
        nullable: true,
        description: 'Caller name, if available.',
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
    required: ['confirmedByCaller', 'subject', 'messageBody', 'callbackRequested', 'priority'],
    additionalProperties: false,
  },
};

const GET_CODEBASE_OVERVIEW_TOOL = {
  type: 'function',
  name: 'get_codebase_overview',
  description:
    'List safe, non-sensitive files from the currently running voice-ai-system codebase, with git metadata. Only use for recognized self-calls.',
  parameters: {
    type: 'object',
    properties: {
      maxFiles: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        description: 'Maximum number of file entries to return.',
      },
    },
    additionalProperties: false,
  },
};

const SEARCH_CODEBASE_TOOL = {
  type: 'function',
  name: 'search_codebase',
  description:
    'Search safe, non-sensitive text files in the currently running voice-ai-system codebase. Only use for recognized self-calls.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Case-insensitive text to search for.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 20,
        description: 'Maximum number of matching lines to return.',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

const READ_CODE_SNIPPET_TOOL = {
  type: 'function',
  name: 'read_code_snippet',
  description:
    'Read a line-numbered snippet from a safe, non-sensitive file in the currently running voice-ai-system codebase. Only use for recognized self-calls.',
  parameters: {
    type: 'object',
    properties: {
      filePath: {
        type: 'string',
        description: 'Relative file path inside the repository, such as src/realtimeHandler.js.',
      },
      startLine: {
        type: 'integer',
        minimum: 1,
        description: 'First line to read. Defaults to 1.',
      },
      endLine: {
        type: 'integer',
        minimum: 1,
        description: 'Last line to read. The tool caps snippets to keep responses small.',
      },
    },
    required: ['filePath'],
    additionalProperties: false,
  },
};

const GET_TASKDECK_BRIEFING_TOOL = {
  type: 'function',
  name: 'get_taskdeck_briefing',
  description:
    'Read the recognized self-caller\'s private Flowpath dashboard data: memory/profile, tasks, projects, situations, check-ins, and plans. Only use for recognized self-calls.',
  parameters: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        enum: ['everything', 'tasks', 'projects', 'situations', 'today', 'memory'],
        description: 'Which Flowpath context to retrieve.',
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 25,
        description: 'Maximum records per section.',
      },
      includeCompletedTasks: {
        type: 'boolean',
        description: 'Whether to include done/ignored tasks as well as open tasks.',
      },
    },
    required: ['topic'],
    additionalProperties: false,
  },
};

const CREATE_TASKDECK_TASK_TOOL = {
  type: 'function',
  name: 'create_taskdeck_task',
  description:
    'Create a task in the recognized self-caller\'s Flowpath database after explicit confirmation of the exact task to add.',
  parameters: {
    type: 'object',
    properties: {
      confirmedByTom: {
        type: 'boolean',
        description: 'Must be true only after the recognized self-caller explicitly confirms the exact write.',
      },
      title: { type: 'string', description: 'Task title.' },
      notes: { type: 'string', description: 'Optional task notes.' },
      status: {
        type: 'string',
        enum: ['open', 'done', 'ignored'],
        description: 'Task status. Usually open.',
      },
      importance: {
        type: 'integer',
        minimum: 1,
        maximum: 5,
        description: 'Importance from 1 to 5.',
      },
      effort: {
        type: 'integer',
        minimum: 1,
        maximum: 5,
        description: 'Effort from 1 to 5.',
      },
      dueDate: {
        type: 'string',
        nullable: true,
        description: 'Optional due date in YYYY-MM-DD format.',
      },
      projectId: {
        type: 'integer',
        nullable: true,
        description: 'Optional Flowpath project id.',
      },
      projectName: {
        type: 'string',
        nullable: true,
        description: 'Optional existing Flowpath project name to attach the task to.',
      },
      lifeAreaId: {
        type: 'integer',
        nullable: true,
        description: 'Optional Flowpath life area id.',
      },
      lifeAreaName: {
        type: 'string',
        nullable: true,
        description: 'Optional existing Flowpath life area name to attach the task to.',
      },
    },
    required: ['confirmedByTom', 'title'],
    additionalProperties: false,
  },
};

const UPDATE_TASKDECK_TASK_TOOL = {
  type: 'function',
  name: 'update_taskdeck_task',
  description:
    'Update a known Flowpath task after explicit confirmation of the exact change, such as marking a task done.',
  parameters: {
    type: 'object',
    properties: {
      confirmedByTom: {
        type: 'boolean',
        description: 'Must be true only after the recognized self-caller explicitly confirms the exact write.',
      },
      taskId: { type: 'integer', description: 'Existing Flowpath task id.' },
      title: { type: 'string', description: 'Optional replacement task title.' },
      status: {
        type: 'string',
        enum: ['open', 'done', 'ignored'],
        description: 'Optional replacement task status.',
      },
      importance: {
        type: 'integer',
        minimum: 1,
        maximum: 5,
        description: 'Optional importance from 1 to 5.',
      },
      effort: {
        type: 'integer',
        minimum: 1,
        maximum: 5,
        description: 'Optional effort from 1 to 5.',
      },
      dueDate: {
        type: 'string',
        nullable: true,
        description: 'Optional replacement due date in YYYY-MM-DD format, or null to clear.',
      },
      notes: { type: 'string', description: 'Optional replacement notes.' },
      projectId: {
        type: 'integer',
        nullable: true,
        description: 'Optional existing Flowpath project id, or null to clear.',
      },
      projectName: {
        type: 'string',
        nullable: true,
        description: 'Optional existing Flowpath project name.',
      },
      lifeAreaId: {
        type: 'integer',
        nullable: true,
        description: 'Optional existing Flowpath life area id, or null to clear.',
      },
      lifeAreaName: {
        type: 'string',
        nullable: true,
        description: 'Optional existing Flowpath life area name.',
      },
    },
    required: ['confirmedByTom', 'taskId'],
    additionalProperties: false,
  },
};

const CREATE_TASKDECK_CHECKIN_TOOL = {
  type: 'function',
  name: 'create_taskdeck_checkin',
  description:
    'Create a daily check-in in the recognized self-caller\'s Flowpath database after explicit confirmation of the captured check-in.',
  parameters: {
    type: 'object',
    properties: {
      confirmedByTom: {
        type: 'boolean',
        description: 'Must be true only after the recognized self-caller explicitly confirms the exact write.',
      },
      energyLevel: {
        type: 'integer',
        minimum: 1,
        maximum: 10,
        description: 'Energy level from 1 to 10.',
      },
      mood: { type: 'string', description: 'Mood notes.' },
      sleep: { type: 'string', description: 'Sleep notes.' },
      healthStatus: { type: 'string', description: 'Health/body status notes.' },
      mainThing: { type: 'string', description: 'The main thing the recognized self-caller wants to focus on.' },
      resistance: { type: 'string', description: 'Resistance, avoidance, or friction.' },
      brainDump: { type: 'string', description: 'Additional thoughts or context.' },
    },
    required: ['confirmedByTom', 'energyLevel'],
    additionalProperties: false,
  },
};

const CREATE_TASKDECK_SITUATION_TOOL = {
  type: 'function',
  name: 'create_taskdeck_situation',
  description:
    'Create a new active Flowpath situation after explicit confirmation of the title and urgency.',
  parameters: {
    type: 'object',
    properties: {
      confirmedByTom: {
        type: 'boolean',
        description: 'Must be true only after the recognized self-caller explicitly confirms the exact write.',
      },
      title: { type: 'string', description: 'Situation title.' },
      category: { type: 'string', description: 'Situation category. Defaults to custom.' },
      urgency: {
        type: 'string',
        enum: ['low', 'medium', 'high', 'crisis'],
        description: 'Situation urgency.',
      },
      summary: {
        type: 'string',
        description: 'Optional summary so far, stored on the initial intake session.',
      },
    },
    required: ['confirmedByTom', 'title'],
    additionalProperties: false,
  },
};

const TASKDECK_TOOLS = [
  GET_TASKDECK_BRIEFING_TOOL,
  CREATE_TASKDECK_TASK_TOOL,
  UPDATE_TASKDECK_TASK_TOOL,
  CREATE_TASKDECK_CHECKIN_TOOL,
  CREATE_TASKDECK_SITUATION_TOOL,
];

const CODEBASE_TOOLS = [
  GET_CODEBASE_OVERVIEW_TOOL,
  SEARCH_CODEBASE_TOOL,
  READ_CODE_SNIPPET_TOOL,
];

const REALTIME_TOOLS = [CREATE_TASKDECK_CALLER_INTAKE_TASK_TOOL, ...TASKDECK_TOOLS, ...CODEBASE_TOOLS];

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
    instructions += `\nCALL OPENING OVERRIDE: Caller ID matches Tom's number. Start this call by saying exactly: "${SELF_CALLER_GREETING}"`;
    instructions +=
      '\nCALL CONTEXT: Caller ID matches Tom\'s number. Default to self_note mode unless caller explicitly says otherwise.';
    instructions +=
      '\nSELF-CALL PRONOUNS: You are speaking directly with Tom. After the opening greeting, address him in second person as "you" and "your"; do not refer to him as "Tom", "Tom\'s", or "he" when you mean the person you are talking to.';
    instructions +=
      '\nFLOWPATH ACCESS: Because this is a recognized self-call, you may use Flowpath tools to read the private dashboard and, after explicit confirmation, create or update Flowpath records.';
    instructions +=
      '\nCODEBASE ACCESS: Because this is a recognized self-call, you may use read-only codebase tools to inspect the currently running voice-ai-system code when discussing how Victoria works or how to improve the system. Treat the code as deployed filesystem state, mention the git commit when helpful, and never request or reveal secrets, env files, credentials, or service-account material.';
  } else {
    instructions += `\nCALL OPENING: Use the public greeting exactly: "${ASSISTANT_GREETING}"`;
    instructions += '\nCALL CONTEXT: Treat this caller as an external contact unless clarified otherwise.';
    instructions +=
      '\nFLOWPATH ACCESS: Do not reveal, summarize, read, or update Tom\'s private Flowpath data for external callers. The only allowed Flowpath action for an external caller is creating a new caller-intake task from that caller\'s own confirmed message using create_taskdeck_caller_intake_task.';
    instructions +=
      '\nCODEBASE ACCESS: Do not reveal, summarize, or inspect Tom\'s private codebase for external callers.';
  }

  if (hasCallerPhone) {
    instructions +=
      '\nPHONE CONTEXT: Caller phone is available from caller ID. Use it as fallback contactPhone if none is provided.';
  }

  return instructions;
};

const getOpeningGreeting = (isSelfCaller) => (isSelfCaller ? SELF_CALLER_GREETING : ASSISTANT_GREETING);

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
    let lastCallerIntakeTask = null;
    let lastTaskDeckAction = null;
    let lastCodebaseAction = null;
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
      console.warn('[Realtime] TWILIO_OWNER_PHONE is not set; self-caller detection is disabled until configured');
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
            tools: REALTIME_TOOLS,
          },
        })
      );

      openaiSocket.send(
        JSON.stringify({
          type: 'response.create',
          response: {
            instructions: `Start the call by saying exactly: ${getOpeningGreeting(isSelfCaller)}`,
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

    const sendFunctionOutput = (output, logLabel = 'function_call') => {
      if (!functionCallId || openaiSocket.readyState !== WebSocket.OPEN) {
        return;
      }

      try {
        openaiSocket.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: functionCallId,
              output: JSON.stringify(output),
            },
          })
        );
      } catch (err) {
        console.warn(`[${logLabel}] failed to send tool output`, err);
      }
    };

    const handleCallerIntakeTask = async (parsedArgs) => {
      if (isSelfCaller) {
        sendFunctionOutput(
          {
            ok: false,
            reason: 'use_taskdeck_task_tool',
            message: 'Self-calls should use the regular Flowpath task tools after explicit confirmation of the exact task.',
          },
          'create_taskdeck_caller_intake_task'
        );
        forceResponse('For your own notes, I should save this as a regular Flowpath task. Summarize the exact task and ask for confirmation.');
        return;
      }

      const confirmedByCaller = normalizeBoolean(parsedArgs?.confirmedByCaller, false);
      const callerName = sanitizeText(parsedArgs?.callerName, 80);
      const contactPhone =
        normalizeCallerPhone(parsedArgs?.contactPhone) || normalizeCallerPhone(inferredCallerPhone) || null;
      const contactEmail = normalizeEmail(parsedArgs?.contactEmail);
      const subject = sanitizeText(parsedArgs?.subject, 160) || 'Voice message';
      const messageBody = sanitizeText(parsedArgs?.messageBody, 2000);
      const callbackRequested = normalizeBoolean(parsedArgs?.callbackRequested, false);
      const priority = normalizePriority(parsedArgs?.priority);

      if (!messageBody) {
        forceResponse('Please restate the message in one or two clear sentences.');
        return;
      }

      const payload = {
        confirmedByCaller,
        callerName,
        contactPhone,
        contactEmail,
        subject,
        messageBody,
        callbackRequested,
        priority,
      };

      if (!confirmedByCaller) {
        sendFunctionOutput(
          {
            ok: false,
            reason: 'confirmation_required',
          },
          'create_taskdeck_caller_intake_task'
        );
        forceResponse('Summarize the exact message you would add to Tom\'s task list, then ask the caller to confirm.');
        return;
      }

      try {
        const result = await createTaskDeckCallerIntakeTask({
          ...payload,
          callSid,
          callerId: normalizeCallerPhone(inferredCallerPhone),
          capturedAt: new Date().toISOString(),
        });

        lastCallerIntakeTask = {
          ok: Boolean(result?.ok),
          reason: result?.reason || null,
          taskId: result?.task?.id || null,
          subject,
          at: new Date().toISOString(),
        };

        sendFunctionOutput(
          {
            ok: Boolean(result?.ok),
            channel: 'taskdeck_task',
            taskId: result?.task?.id || null,
            reason: result?.reason || null,
          },
          'create_taskdeck_caller_intake_task'
        );

        if (result?.ok) {
          forceResponse('Thanks. I added that to Tom\'s task list.');
        } else {
          forceResponse('I captured the details, but I could not add them to Flowpath right now.');
        }
      } catch (err) {
        console.warn('[Flowpath] create_taskdeck_caller_intake_task failed', err);
        lastCallerIntakeTask = {
          ok: false,
          reason: err?.message || 'Caller intake task failed',
          taskId: null,
          subject,
          at: new Date().toISOString(),
        };
        sendFunctionOutput(
          {
            ok: false,
            channel: 'taskdeck_task',
            reason: 'taskdeck_caller_intake_error',
            message: err?.message || 'Caller intake task failed.',
          },
          'create_taskdeck_caller_intake_task'
        );
        forceResponse('I captured the details, but I could not add them to Flowpath right now.');
      }
    };

    const handleCodebaseTool = async (toolName, parsedArgs) => {
      if (!isSelfCaller) {
        sendFunctionOutput(
          {
            ok: false,
            reason: 'not_authorized',
            message: 'Codebase access is private and only available when Tom is the caller.',
          },
          toolName
        );
        forceResponse('I can only inspect Tom\'s codebase when I know I am speaking with Tom.');
        return;
      }

      try {
        let result;

        switch (toolName) {
          case 'get_codebase_overview':
            result = await getCodebaseOverview(parsedArgs);
            break;
          case 'search_codebase':
            result = await searchCodebase(parsedArgs);
            break;
          case 'read_code_snippet':
            result = await readCodeSnippet(parsedArgs);
            break;
          default:
            result = { ok: false, reason: 'unsupported_codebase_tool' };
        }

        lastCodebaseAction = {
          toolName,
          ok: Boolean(result?.ok),
          reason: result?.reason || null,
          commit: result?.git?.shortCommit || null,
          at: new Date().toISOString(),
        };

        sendFunctionOutput(result, toolName);
        forceResponse('Use the codebase tool result to answer directly and concisely in second person. Mention that the view is read-only and currently deployed if that matters.');
      } catch (err) {
        console.warn(`[Codebase] ${toolName} failed`, err);
        lastCodebaseAction = {
          toolName,
          ok: false,
          reason: err?.message || 'Codebase tool failed',
          at: new Date().toISOString(),
        };
        sendFunctionOutput(
          {
            ok: false,
            reason: 'codebase_tool_error',
            message: err?.message || 'Codebase tool failed.',
          },
          toolName
        );
        forceResponse('I could not inspect the codebase for that request. Briefly explain what went wrong and suggest a narrower search or file path.');
      }
    };

    const handleTaskDeckTool = async (toolName, parsedArgs) => {
      if (!isSelfCaller) {
        sendFunctionOutput(
          {
            ok: false,
            reason: 'not_authorized',
            message: 'Flowpath data is private and only available when Tom is the caller.',
          },
          toolName
        );
        forceResponse('I can only access Tom\'s private Flowpath dashboard when I know I am speaking with Tom.');
        return;
      }

      try {
        let result;

        switch (toolName) {
          case 'get_taskdeck_briefing':
            result = await getTaskDeckBriefing(parsedArgs);
            break;
          case 'create_taskdeck_task':
            result = await createTaskDeckTask(parsedArgs);
            break;
          case 'update_taskdeck_task':
            result = await updateTaskDeckTask(parsedArgs);
            break;
          case 'create_taskdeck_checkin':
            result = await createTaskDeckCheckIn(parsedArgs);
            break;
          case 'create_taskdeck_situation':
            result = await createTaskDeckSituation(parsedArgs);
            break;
          default:
            result = { ok: false, reason: 'unsupported_taskdeck_tool' };
        }

        lastTaskDeckAction = {
          toolName,
          ok: Boolean(result?.ok),
          reason: result?.reason || null,
          at: new Date().toISOString(),
        };

        sendFunctionOutput(result, toolName);

        if (toolName === 'get_taskdeck_briefing') {
          forceResponse('Use the Flowpath tool result to answer directly and concisely in second person. Mention task or project ids only if they help with a follow-up change.');
          return;
        }

        if (result?.ok === false && result?.reason === 'confirmation_required') {
          forceResponse('Before I change Flowpath, summarize the exact change and ask for confirmation.');
          return;
        }

        if (result?.ok) {
          forceResponse('Briefly confirm the Flowpath change that was completed, using the tool result for exact names or ids.');
          return;
        }

        forceResponse('Say the Flowpath change was not completed and briefly explain why.');
      } catch (err) {
        console.warn(`[Flowpath] ${toolName} failed`, err);
        lastTaskDeckAction = {
          toolName,
          ok: false,
          reason: err?.message || 'Flowpath tool failed',
          at: new Date().toISOString(),
        };
        sendFunctionOutput(
          {
            ok: false,
            reason: 'taskdeck_tool_error',
            message: err?.message || 'Flowpath tool failed.',
          },
          toolName
        );
        forceResponse('I could not complete that Flowpath request. Briefly explain what went wrong and ask what to do next.');
      }
    };

    const handleFunctionCallDone = async () => {
      if (!functionCallName || !functionCallBuffer) {
        resetFunctionCallState();
        return;
      }

      try {
        const parsedArgs = JSON.parse(functionCallBuffer);

        if (functionCallName === 'create_taskdeck_caller_intake_task') {
          await handleCallerIntakeTask(parsedArgs);
          resetFunctionCallState();
          return;
        }

        if (TASKDECK_TOOLS.some((tool) => tool.name === functionCallName)) {
          await handleTaskDeckTool(functionCallName, parsedArgs);
          resetFunctionCallState();
          return;
        }

        if (CODEBASE_TOOLS.some((tool) => tool.name === functionCallName)) {
          await handleCodebaseTool(functionCallName, parsedArgs);
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
                output: JSON.stringify({ ok: false, reason: 'Unsupported tool name' }),
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
        callerIntakeTask: lastCallerIntakeTask,
        lastTaskDeckAction,
        lastCodebaseAction,
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
              silence_duration_ms: 550,
              create_response: true,
              interrupt_response: true,
            },
          },
          output: {
            format: { type: 'audio/pcmu' },
            voice: 'marin',
          },
        },
        tools: REALTIME_TOOLS,
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
