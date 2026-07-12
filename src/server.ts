import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import { knowledgeGraph, graph, seedGraph, analyzeBlastRadius } from './graph';
import { classifyHealthSeverity } from './neo4jService';
import { WebClient } from '@slack/web-api';
import Groq from 'groq-sdk';
import { fetchFileContentViaMCP, fetchLatestCommitContextViaMCP, fetchRecentRepoActivityViaMCP } from './mcpGithubClient';
 

const app = express();

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
const slackUser = new WebClient(process.env.SLACK_USER_TOKEN);
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

const DRIFT_CHANNEL = process.env.SLACK_DRIFT_CHANNEL || 'engineering-alerts';

// ============================================================
// RTS FALLBACK — DEFAULT ON
// ============================================================
// Slack's search.messages API only works on paid plans. On a free
// workspace it fails for every query regardless of how good the search
// terms are, so this fallback fires whenever the real search errors or
// comes back empty. Set RTS_DEV_MODE=false to disable it entirely.
const RTS_DEV_MODE = process.env.RTS_DEV_MODE !== 'false';

// ------------------------------------------------------------
// FIX: seeded reviewer IDs now come from environment variables,
// not hardcoded placeholder strings. Slack cannot resolve a fake ID
// like "U_PRIYA_DEV" to a real mention — it just prints the literal
// text, which is exactly what showed up unlinked and gray in the demo
// screenshots. Set these in .env to real member IDs (Slack profile →
// "..." menu → Copy member ID, looks like U012ABC3DE).
// ------------------------------------------------------------
function isValidSlackUserId(id: string | undefined): id is string {
  return !!id && /^U[A-Z0-9]{6,}$/i.test(id);
}

const RAW_SEED_REVIEWERS = {
  priya: process.env.SEED_REVIEWER_PRIYA_ID,
  marcus: process.env.SEED_REVIEWER_MARCUS_ID,
  dana: process.env.SEED_REVIEWER_DANA_ID
};

const SEED_RTS_MESSAGES: Array<{ file: string; text: string; user: string | undefined }> = [
  {
    file: 'ratelimiter',
    text: 'redis kept dropping connections on rateLimiter under load, reverting to in-memory for now until we can dig into the connection pool config',
    user: RAW_SEED_REVIEWERS.priya
  },
  {
    file: 'auth',
    text: 'heads up — switched the auth middleware back to session cookies, the JWT refresh flow was causing logout loops for mobile clients',
    user: RAW_SEED_REVIEWERS.marcus
  },
  {
    file: 'billing',
    text: 'billing webhook retries are now capped at 3 attempts, Stripe was hammering us with retries during their incident last week',
    user: RAW_SEED_REVIEWERS.dana
  }
];

// Loud startup warning so a bad ID never silently ships into a demo again.
(function validateSeedReviewers() {
  if (!RTS_DEV_MODE) return;
  for (const [name, id] of Object.entries(RAW_SEED_REVIEWERS)) {
    if (!isValidSlackUserId(id)) {
      console.warn(
        `⚠️  SEED_REVIEWER_${name.toUpperCase()}_ID is missing or not a valid Slack user ID ` +
        `("${id || 'unset'}"). The @-mention for this seed message will render as plain, ` +
        `unlinked text in Slack instead of a real mention. Set it in .env to a real member ID ` +
        `(Slack → profile → "..." → Copy member ID) before recording your demo.`
      );
    }
  }
})();

seedGraph();

const getHealthEmoji = (score: number) => {
  if (score >= 90) return '🟢';
  if (score >= 70) return '🟡';
  return '🔴';
};

// FIX: "72.0 hours" read as unformatted raw output. Only show a decimal
// when there actually is a fraction to show.
function formatDriftHours(hours: number): string {
  return Number.isInteger(hours) ? `${hours}` : hours.toFixed(1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeRepoFromPayload(body: any): { owner?: string; repo?: string } {
  const fullName = body?.repository?.full_name as string | undefined;
  const [ownerFromFullName, repoFromFullName] = fullName?.split('/') || [];

  return {
    owner: body?.repository?.owner?.login || body?.owner || ownerFromFullName || process.env.GITHUB_OWNER,
    repo: body?.repository?.name || body?.repo || repoFromFullName || process.env.GITHUB_REPO
  };
}

function isPullRequestOpenedEvent(req: express.Request): boolean {
  const githubEvent = String(req.headers['x-github-event'] || '').toLowerCase();
  const action = String(req.body?.action || '').toLowerCase();
  return githubEvent === 'pull_request' && action === 'opened';
}

function getPullRequestNumber(body: any): number | null {
  const pullNumber = Number(body?.pull_request?.number || body?.number || body?.pull_number);
  return Number.isInteger(pullNumber) && pullNumber > 0 ? pullNumber : null;
}

function extractChangedFilesFromPayload(body: any): GithubPullRequestFile[] {
  const files = body?.files || body?.changed_files_detail || body?.pull_request?.files;
  if (!Array.isArray(files)) return [];

  return files
    .filter((file: any) => typeof file?.filename === 'string' || typeof file?.path === 'string')
    .map((file: any) => ({
      filename: file.filename || file.path,
      status: file.status,
      additions: Number(file.additions || 0),
      deletions: Number(file.deletions || 0),
      changes: Number(file.changes || file.additions || 0) + Number(file.deletions || 0),
      patch: file.patch
    }));
}

async function fetchPullRequestFiles(
  owner: string,
  repo: string,
  pullNumber: number
): Promise<GithubPullRequestFile[]> {
  const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  const headers: Record<string, string> = {
    'User-Agent': 'verity-agent',
    Accept: 'application/vnd.github+json'
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const files: GithubPullRequestFile[] = [];
  for (let page = 1; page <= 3; page += 1) {
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pullNumber}/files?per_page=100&page=${page}`,
      { headers }
    );

    if (!response.ok) {
      throw new Error(`GitHub PR files lookup failed with ${response.status}`);
    }

    const pageFiles = await response.json() as GithubPullRequestFile[];
    files.push(...pageFiles);
    if (pageFiles.length < 100) break;
  }

  return files;
}

function changedFileToSignal(file: GithubPullRequestFile): string {
  const patch = file.patch ? `\nPatch:\n${file.patch.slice(0, 1400)}` : '';
  return [
    `File: ${file.filename}`,
    `Status: ${file.status || 'modified'}`,
    `Changes: +${file.additions || 0}/-${file.deletions || 0}`
  ].join('\n') + patch;
}

function predictArtifactHealth(node: any, confidence: number): { predictedHealth: number; predictedDecayHours: number } {
  const now = Date.now();
  const lastUpdated = new Date(node.last_updated || now).getTime();
  const ageHours = Math.max(0, (now - lastUpdated) / (1000 * 60 * 60));
  const currentHealth = typeof node.memory_health_score === 'number' ? node.memory_health_score : 100;
  const riskPenalty = Math.round((confidence / 100) * 18);
  const agePenalty = Math.round(Math.min(25, ageHours / 24 * 4));
  const predictedHealth = clamp(currentHealth - riskPenalty - agePenalty, 0, 100);

  return {
    predictedHealth,
    predictedDecayHours: ageHours
  };
}

function calculatePredictionConfidence(node: any, blastArtifact: any | undefined, file: GithubPullRequestFile): number {
  const relationshipWeight: Record<string, number> = {
    Document: 86,
    ADR: 82,
    Runbook: 88,
    Service: 78,
    Owner: 72,
    Jira: 64,
    Incident: 68,
    'Slack Thread': 58
  };
  const base = relationshipWeight[node.type] || 60;
  const impactBoost = blastArtifact?.impactScore ? Math.round((blastArtifact.impactScore - 50) / 3) : 0;
  const changeBoost = clamp(Math.round((file.changes || 0) / 8), 0, 10);
  const patchBoost = file.patch ? 4 : 0;

  return clamp(base + impactBoost + changeBoost + patchBoost, 30, 98);
}

function summarizeArtifactGroup(artifacts: PredictiveDriftArtifact[], type: string): string {
  const items = artifacts
    .filter(artifact => artifact.type === type)
    .slice(0, 6)
    .map(artifact => `• ${artifact.name} (${artifact.confidence}%)`);

  return items.length > 0 ? items.join('\n') : 'None predicted.';
}

function summarizeChangedFiles(files: GithubPullRequestFile[]): string {
  return files
    .slice(0, 8)
    .map(file => `• ${file.filename} (+${file.additions || 0}/-${file.deletions || 0})`)
    .join('\n') || 'No changed files found.';
}

function truncateForSlack(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 15)).trimEnd()}\n... truncated`;
}

function formatSlackBlockQuote(text: string): string {
  return String(text || '')
    .split('\n')
    .map(line => `> ${line}`)
    .join('\n');
}

function formatHealthBar(health: number): string {
  const filled = Math.round(clamp(health, 0, 100) / 10);
  return `${'█'.repeat(filled)}${'░'.repeat(10 - filled)}`;
}

function normalizeQuestionText(text: string): string {
  return text
    .replace(/<@[A-Z0-9]+>/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getQuestionTerms(question: string): string[] {
  const stopwords = new Set([
    'verity', 'please', 'can', 'could', 'would', 'what', 'when', 'where', 'who', 'why',
    'how', 'the', 'and', 'for', 'with', 'this', 'that', 'about', 'into', 'from', 'system',
    'service', 'services', 'explain', 'summarize', 'summary', 'owner', 'owns', 'changed',
    'change', 'week', 'predict', 'documentation', 'drift', 'architecture', 'unhealthy',
    'health', 'is', 'are', 'was', 'were'
  ]);

  return [...new Set(
    question
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9._/-]{2,}/g) || []
  )].filter(term => !stopwords.has(term));
}

function scoreGraphNode(node: any, terms: string[], question: string): number {
  const haystack = [
    node.name,
    node.type,
    node.content,
    ...(Array.isArray(node.relationships) ? node.relationships : [])
  ].join(' ').toLowerCase();
  const lowerQuestion = question.toLowerCase();
  let score = 0;

  for (const term of terms) {
    if (haystack.includes(term)) score += 3;
    if (String(node.name || '').toLowerCase().includes(term)) score += 3;
  }

  if (/who\s+owns|owner|owns/i.test(question) && node.type === 'Owner') score += 6;
  if (/unhealthy|health|why/i.test(question) && typeof node.memory_health_score === 'number' && node.memory_health_score < 90) score += 5;
  if (/runbook/i.test(lowerQuestion) && node.type === 'Runbook') score += 5;
  if (/incident|unhealthy|why/i.test(lowerQuestion) && node.type === 'Incident') score += 5;
  if (/architecture|explain|summarize/i.test(lowerQuestion) && ['Document', 'ADR', 'Service', 'Code'].includes(node.type)) score += 3;
  if (/drift|documentation/i.test(lowerQuestion) && ['Document', 'ADR', 'Runbook'].includes(node.type)) score += 3;
  if (/changed|week/i.test(lowerQuestion) && node.type === 'Code') score += 2;

  return score;
}

function graphNodeToEvidence(node: any, note?: string): EvidenceSource {
  const health = typeof node.memory_health_score === 'number'
    ? ` Health: ${node.memory_health_score}%.`
    : '';
  const updated = node.last_updated ? ` Last updated: ${node.last_updated}.` : '';
  const content = node.content ? String(node.content) : 'No content stored on this node.';

  return {
    id: `G${Math.abs(String(node.id || node.name).split('').reduce((sum, char) => sum + char.charCodeAt(0), 0))}`,
    title: `${node.type}: ${node.name}`,
    sourceType: 'Neo4j',
    excerpt: truncateForSlack(`${note ? `${note} ` : ''}${content}${health}${updated}`, 700),
    confidence: 'high'
  };
}

async function searchSlackEvidence(question: string, terms: string[]): Promise<EvidenceSource[]> {
  const query = terms.length > 0 ? terms.slice(0, 6).join(' ') : question;
  const evidence: EvidenceSource[] = [];

  try {
    const searchResult = await slackUser.search.messages({
      query,
      sort: 'timestamp',
      sort_dir: 'desc',
      count: 5
    });

    const matches = searchResult?.messages?.matches || [];
    matches.forEach((match: any, index: number) => {
      if (!match?.text) return;
      evidence.push({
        id: `S${index + 1}`,
        title: match.channel?.name ? `Slack #${match.channel.name}` : 'Slack message',
        sourceType: 'Slack RTS',
        excerpt: truncateForSlack(match.text, 700),
        url: match.permalink,
        confidence: 'medium'
      });
    });
  } catch (error: any) {
    const slackErr = error?.data?.error || error?.message;
    console.warn(`Slack RTS conversational search unavailable (${slackErr}).`);
  }

  if (evidence.length === 0 && RTS_DEV_MODE) {
    const lowerQuestion = question.toLowerCase();
    SEED_RTS_MESSAGES
      .filter(seed => terms.some(term => seed.file.includes(term) || seed.text.toLowerCase().includes(term)) || lowerQuestion.includes(seed.file))
      .slice(0, 3)
      .forEach((seed, index) => {
        evidence.push({
          id: `S${index + 1}`,
          title: `Seed Slack discussion: ${seed.file}`,
          sourceType: 'Slack RTS fallback',
          excerpt: seed.text,
          confidence: 'low'
        });
      });
  }

  return evidence;
}

async function getGithubActivityEvidence(question: string): Promise<EvidenceSource[]> {
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  if (!owner || !repo) return [];

  const needsActivity = /changed|week|recent|commit|pr|pull request|drift|why|unhealthy|architecture|explain|summarize/i.test(question);
  if (!needsActivity) return [];

  const activity = await fetchRecentRepoActivityViaMCP(owner, repo);
  const evidence: EvidenceSource[] = [];

  if (activity.commits.length > 0) {
    evidence.push({
      id: 'H1',
      title: `Recent commits in ${owner}/${repo}`,
      sourceType: 'GitHub MCP commit history',
      excerpt: truncateForSlack(activity.commits.join('\n'), 1000),
      confidence: 'high'
    });
  }

  if (activity.pullRequests.length > 0) {
    evidence.push({
      id: 'H2',
      title: `Recent PRs in ${owner}/${repo}`,
      sourceType: 'GitHub PR descriptions',
      excerpt: truncateForSlack(activity.pullRequests.join('\n'), 1200),
      confidence: 'high'
    });
  }

  return evidence;
}

async function collectConversationalEvidence(question: string): Promise<EvidenceSource[]> {
  const terms = getQuestionTerms(question);
  const scoredNodes = knowledgeGraph
    .map(node => ({ node, score: scoreGraphNode(node, terms, question) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || String(a.node.name).localeCompare(String(b.node.name)));

  const graphEvidence: EvidenceSource[] = [];
  for (const item of scoredNodes.slice(0, 7)) {
    graphEvidence.push(graphNodeToEvidence(item.node));

    if (['Code', 'Service'].includes(item.node.type)) {
      try {
        const related = await graph.findRelatedNodes(item.node.id);
        related
          .filter(node => node.type !== 'Code')
          .slice(0, 5)
          .forEach(node => graphEvidence.push(graphNodeToEvidence(node, `Related to ${item.node.name}.`)));
      } catch (error: any) {
        console.warn(`Related graph lookup failed for ${item.node.id}: ${error?.message || error}`);
      }
    }
  }

  const slackEvidence = await searchSlackEvidence(question, terms);
  const githubEvidence = await getGithubActivityEvidence(question);

  const seen = new Set<string>();
  return [...graphEvidence, ...slackEvidence, ...githubEvidence]
    .filter(source => {
      const key = `${source.sourceType}:${source.title}:${source.excerpt}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 16)
    .map((source, index) => {
      const prefix = source.sourceType.startsWith('Neo4j')
        ? 'G'
        : source.sourceType.startsWith('Slack')
          ? 'S'
          : source.sourceType.startsWith('GitHub')
            ? 'H'
            : 'E';
      return { ...source, id: `${prefix}${index + 1}` };
    });
}

function fallbackConversationalAnswer(question: string, sources: EvidenceSource[]): string {
  if (sources.length === 0) {
    return `I do not have enough evidence to answer "${question}". I checked the local graph, Slack search path, and GitHub MCP hooks that are configured for Verity.`;
  }

  const graphSources = sources.filter(source => source.sourceType === 'Neo4j');
  const unhealthy = graphSources.filter(source => /Health: ([0-8]?\d)%/.test(source.excerpt));
  const owners = graphSources.filter(source => source.title.startsWith('Owner:'));

  const lines = [
    `Here is what I can say from the available evidence, without guessing:`
  ];

  sources.slice(0, 5).forEach(source => {
    lines.push(`- [${source.id}] ${source.title}: ${source.excerpt}`);
  });

  if (/who\s+owns|owner|owns/i.test(question) && owners.length === 0) {
    lines.push('I did not find an explicit owner source for this question.');
  }

  if (/unhealthy|why/i.test(question) && unhealthy.length === 0) {
    lines.push('I did not find a graph health source low enough to explain an unhealthy service.');
  }

  return lines.join('\n');
}

async function generateConversationalAnswer(question: string): Promise<ConversationalAnswer> {
  const sources = await collectConversationalEvidence(question);
  if (sources.length === 0 || !process.env.GROQ_API_KEY) {
    return { answer: fallbackConversationalAnswer(question, sources), sources };
  }

  try {
    const evidenceBlock = sources
      .map(source => `[${source.id}] ${source.sourceType} | ${source.title}${source.url ? ` | ${source.url}` : ''}\n${source.excerpt}`)
      .join('\n\n');

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 650,
      messages: [
        {
          role: 'user',
          content:
            `You are Verity, a conversational AI teammate for engineering teams.\n` +
            `Answer the user's Slack question using ONLY the evidence below.\n` +
            `Every factual claim must cite one or more source IDs like [G123] or [H1].\n` +
            `If the evidence does not answer part of the question, say that directly.\n` +
            `Do not invent owners, architecture, causes, incidents, PR details, timelines, or runbook steps.\n` +
            `For prediction questions, label the result as a risk prediction and cite the signals.\n` +
            `Keep the Slack answer concise and useful.\n\n` +
            `Question: ${question}\n\n` +
            `Evidence:\n${evidenceBlock}`
        }
      ]
    });

    const answer = completion.choices[0]?.message?.content?.trim();
    return { answer: answer || fallbackConversationalAnswer(question, sources), sources };
  } catch (error: any) {
    console.error('Conversational Groq answer failed:', error?.message || error);
    return { answer: fallbackConversationalAnswer(question, sources), sources };
  }
}

function formatConversationalSlackResponse(result: ConversationalAnswer): string {
  const sourceLines = result.sources.slice(0, 8).map(source => {
    const link = source.url ? ` <${source.url}|open>` : '';
    return `[${source.id}] ${source.sourceType}: ${source.title}${link}`;
  });

  return truncateForSlack(
    `${result.answer}\n\n*Sources checked:*\n${sourceLines.join('\n') || 'No matching sources found.'}`,
    3600
  );
}

async function postResponseUrl(responseUrl: string, body: any): Promise<void> {
  await fetch(responseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

const processedEvents = new Set<string>();
const eventKey = (file: string, content: string) => `${file}::${content}`;

const draftSuggestions = new Map<string, string>();
const suggestedReviewers = new Map<string, string>();

type GithubPullRequestFile = {
  filename: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  patch?: string;
};

type PredictiveDriftArtifact = {
  id: string;
  name: string;
  type: string;
  currentHealth: number;
  predictedHealth: number;
  predictedDecayHours: number;
  confidence: number;
  impactScore: number;
  severity: string;
  changedFile: string;
  suggestion: string;
};

type PredictiveDriftAnalysis = {
  owner: string;
  repo: string;
  pullNumber: number;
  pullTitle: string;
  pullUrl?: string;
  author?: string;
  changedFiles: GithubPullRequestFile[];
  changedCodeNodes: any[];
  artifacts: PredictiveDriftArtifact[];
  blastRadiusSummary: string;
};

type EvidenceSource = {
  id: string;
  title: string;
  sourceType: string;
  excerpt: string;
  url?: string;
  confidence: 'high' | 'medium' | 'low';
};

type ConversationalAnswer = {
  answer: string;
  sources: EvidenceSource[];
};

function verifySlackSignature(req: express.Request, _res: express.Response, buf: Buffer) {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    console.warn('⚠️  SLACK_SIGNING_SECRET is not set — skipping signature verification (UNSAFE for production).');
    return;
  }

  const timestamp = req.headers['x-slack-request-timestamp'] as string | undefined;
  const slackSignature = req.headers['x-slack-signature'] as string | undefined;

  if (!timestamp || !slackSignature) {
    throw new Error('Missing Slack signature headers');
  }

  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 60 * 5;
  if (Number(timestamp) < fiveMinutesAgo) {
    throw new Error('Slack request timestamp is too old');
  }

  const sigBasestring = `v0:${timestamp}:${buf.toString()}`;
  const mySignature = 'v0=' + crypto
    .createHmac('sha256', signingSecret)
    .update(sigBasestring)
    .digest('hex');

  const a = Buffer.from(mySignature, 'utf8');
  const b = Buffer.from(slackSignature, 'utf8');

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('Slack signature mismatch');
  }
}

function captureRawBody(req: express.Request, _res: express.Response, buf: Buffer) {
  (req as any).rawBody = buf;
}

// Verify GitHub webhook signature against the exact raw payload bytes.
function verifyGitHubWebhook(req: express.Request, res: express.Response, next: express.NextFunction) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('GITHUB_WEBHOOK_SECRET is not set - skipping GitHub signature verification (UNSAFE for production).');
    return next();
  }

  const signature = req.headers['x-hub-signature-256'];
  if (typeof signature !== 'string') {
    return res.status(401).send('Missing signature');
  }

  const rawBody = (req as any).rawBody;
  if (!Buffer.isBuffer(rawBody)) {
    return res.status(400).send('Missing raw body for signature verification');
  }

  const digest = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  const expected = Buffer.from(digest, 'utf8');
  const actual = Buffer.from(signature, 'utf8');

  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    return res.status(401).send('Invalid signature');
  }

  next();
}

app.use('/webhook/github', express.json({ verify: captureRawBody }));
app.use('/webhook/github-live', express.json({ verify: captureRawBody }));

const CODE_STOPWORDS = new Set([
  'const', 'let', 'var', 'function', 'return', 'import', 'export', 'from',
  'async', 'await', 'default', 'require', 'module', 'exports', 'true',
  'false', 'null', 'undefined', 'this', 'new', 'class', 'extends', 'type',
  'interface', 'public', 'private', 'static', 'void', 'string', 'number',
  'boolean', 'any', 'throw', 'try', 'catch', 'finally', 'if', 'else', 'for',
  'while', 'switch', 'case', 'break', 'continue', 'typeof', 'instanceof'
]);

function extractSearchTerms(fileBaseName: string, newContent: string): string {
  const identifiers = newContent.match(/\b[a-zA-Z_][a-zA-Z0-9_]{3,}\b/g) || [];

  const keywords = [...new Set(identifiers)]
    .filter(w => !CODE_STOPWORDS.has(w.toLowerCase()))
    .slice(0, 4);

  return `${fileBaseName} ${keywords.join(' ')}`.trim();
}

function findSeedMatch(fileBaseName: string) {
  const lower = fileBaseName.toLowerCase();
  return SEED_RTS_MESSAGES.find(m =>
    (lower.includes(m.file) || m.file.includes(lower)) && isValidSlackUserId(m.user)
  );
}

const CODE_PATH_PROPERTIES = [
  'name',
  'path',
  'file',
  'filename',
  'filePath',
  'filepath',
  'fullPath',
  'repoPath',
  'repositoryPath',
  'sourcePath'
];

function normalizeCodePath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .toLowerCase();
}

function getCodeNodePathCandidates(node: any): string[] {
  const candidates = CODE_PATH_PROPERTIES
    .flatMap((property) => {
      const value = node?.[property];
      return Array.isArray(value) ? value : [value];
    })
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map(normalizeCodePath);

  return [...new Set(candidates)];
}

function logCodeNodeMappingCandidates(targetFile: string) {
  const normalizedTarget = normalizeCodePath(targetFile);
  const targetBaseName = normalizedTarget.split('/').pop() || normalizedTarget;
  const codeNodes = knowledgeGraph.filter(n => n.type === 'Code');

  console.log(`Code node mapping candidates for "${targetFile}" (normalized: "${normalizedTarget}")`);
  if (codeNodes.length === 0) {
    console.log('No Code nodes are currently loaded in the graph cache.');
    return;
  }

  codeNodes.forEach(node => {
    const pathCandidates = getCodeNodePathCandidates(node);
    console.log({
      id: node.id,
      labels: node.labels || ['Entity'],
      type: node.type,
      name: node.name,
      path: node.path,
      file: node.file,
      filename: node.filename,
      filePath: node.filePath || node.filepath,
      pathCandidates,
      matchesTarget: pathCandidates.some(candidate =>
        candidate === normalizedTarget ||
        candidate.endsWith(`/${normalizedTarget}`) ||
        candidate === targetBaseName ||
        candidate.endsWith(`/${targetBaseName}`)
      )
    });
  });
}

function findCodeNodeForTarget(targetFile: string) {
  const normalizedTarget = normalizeCodePath(targetFile);
  const targetBaseName = normalizedTarget.split('/').pop() || normalizedTarget;
  const codeNodes = knowledgeGraph.filter(n => n.type === 'Code');

  const exactMatch = codeNodes.find(n =>
    getCodeNodePathCandidates(n).some(candidate =>
      candidate === normalizedTarget || candidate.endsWith(`/${normalizedTarget}`)
    )
  );
  if (exactMatch) return exactMatch;

  const basenameMatch = codeNodes.find(n => {
    const candidates = getCodeNodePathCandidates(n);
    return candidates.some(candidate =>
      candidate === targetBaseName || candidate.endsWith(`/${targetBaseName}`)
    );
  });

  if (basenameMatch) return basenameMatch;

  if (codeNodes.length === 1) return codeNodes[0];

  logCodeNodeMappingCandidates(targetFile);
  return null;
}

async function processCodeChangeEvent(
  targetFile: string,
  newContent: string,
  commitContext?: string | null
): Promise<{ ignored: boolean; reason?: string; impact: any[]; blastRadius?: any }> {
  const key = eventKey(targetFile, newContent);
  if (processedEvents.has(key)) {
    console.log(`\n♻️  DUPLICATE EVENT IGNORED: ${targetFile}`);
    return { ignored: true, reason: 'duplicate', impact: [] };
  }

  console.log(`\n⚡ EVENT RECEIVED: Code change detected in ${targetFile}`);

  const codeNode = findCodeNodeForTarget(targetFile);
  if (!codeNode) {
    console.log(`ℹ️ No graph relationships found for ${targetFile}. Ignoring.`);
    return { ignored: true, reason: 'no_mapped_relationships', impact: [] };
  }

  if (codeNode.name !== targetFile) {
    console.log(`ℹ️ Matched webhook path ${targetFile} to graph node ${codeNode.name}.`);
  }

  processedEvents.add(key);

  const commitTime = new Date();
  const codeNodeUpdate: Record<string, any> = {
    content: newContent,
    last_updated: commitTime.toISOString()
  };

  if (commitContext) {
    codeNodeUpdate.commit_context = commitContext;
  }

  graph.updateNode(codeNode.id, codeNodeUpdate);

  const relatedNodes = await graph.findRelatedNodes(codeNode.id);

  console.log(
    "🔗 Related nodes:",
    relatedNodes.map(n => ({
      name: n.name,
      type: n.type,
      last_updated: n.last_updated
    }))
  );

  const impactedArtifacts: Array<{ id: string; name: string; type: string; health: number; driftHours: number }> = [];
  let blastRadius: any = null;

  relatedNodes.forEach(node => {
    const nodeUpdateTime = new Date(node.last_updated).getTime();
    const codeUpdateTime = commitTime.getTime();

    if (nodeUpdateTime < codeUpdateTime) {
      const timeToDriftMs = codeUpdateTime - nodeUpdateTime;
      const timeToDriftHours = timeToDriftMs / (1000 * 60 * 60);

      const daysDrift = timeToDriftHours / 24;
      const newHealthScore = Math.max(0, Math.round(100 - (daysDrift * 5)));

      graph.updateNode(node.id, {
        memory_health_score: newHealthScore
      });

      impactedArtifacts.push({
        id: node.id,
        name: node.name,
        type: node.type,
        health: newHealthScore,
        driftHours: timeToDriftHours
      });
    }
  });

  // DIAGNOSTIC: health scores are computed live from each node's real
  // last_updated timestamp — this file does not hardcode 85% anywhere.
  // If every impacted node comes out identical, the graph's SEED DATA
  // (in graph.ts, not this file) is giving every node the same
  // last_updated timestamp, which produces identical drift math. Flagging
  // this loudly here since it's the root cause of the "everything is 85%"
  // demo screenshots — the fix belongs in graph.ts's seedGraph().
  if (impactedArtifacts.length > 1) {
    const uniqueHealths = new Set(impactedArtifacts.map(a => a.health));
    if (uniqueHealths.size === 1) {
      console.warn(
        `⚠️  All ${impactedArtifacts.length} impacted artifacts came out at the exact same ` +
        `health score (${impactedArtifacts[0].health}%). This usually means their last_updated ` +
        `timestamps in the graph seed are identical. Vary them in graph.ts's seedGraph() so the ` +
        `demo shows realistic spread instead of every card reading the same percentage.`
      );
    }
  }

  if (impactedArtifacts.length > 0) {
    console.log('\n🧠 MEMORY DECAY DETECTED - Sending to Slack...');

    try {
      blastRadius = await analyzeBlastRadius(codeNode.id, 4);
    } catch (error: any) {
      console.warn(`⚠️ Blast radius analysis unavailable: ${error?.message || error}`);
    }

    const worstArtifact = impactedArtifacts.reduce((worst, current) =>
      current.driftHours > worst.driftHours ? current : worst
    );

    // --- RTS: Search Slack for tribal knowledge ---
    let rtsEvidence = "No tribal context found in recent Slack history.";
    let reviewerUserId: string | null = null;
    let usedFallback = false;

    const fileBaseName = targetFile.split('/').pop()?.replace(/\.[^/.]+$/, '') || targetFile;

    try {
      const searchQuery = extractSearchTerms(fileBaseName, newContent);
      console.log(`🔍 RTS query: "${searchQuery}"`);

      const searchResult = await slackUser.search.messages({
        query: searchQuery,
        sort: "timestamp",
        sort_dir: "desc",
        count: 1
      });

      const matches = searchResult?.messages?.matches;
      if (matches && matches.length > 0 && matches[0].text) {
        rtsEvidence = `Found related discussion: "${matches[0].text.substring(0, 120)}..."`;
        reviewerUserId = matches[0].user || null;
        console.log(`✅ RTS hit (live search): ${rtsEvidence}`);
      } else {
        console.log('ℹ️ RTS: live search returned no matches.');
      }
    } catch (error: any) {
      const slackErr = error?.data?.error || error?.message;
      console.error(`⚠️ RTS API Error (${slackErr}) — likely search.messages is unavailable on this workspace's plan.`);
    }

    if (!reviewerUserId && RTS_DEV_MODE) {
      const seed = findSeedMatch(fileBaseName);
      if (seed && isValidSlackUserId(seed.user)) {
        rtsEvidence = `Found related discussion: "${seed.text.substring(0, 120)}..."`;
        reviewerUserId = seed.user!;
        usedFallback = true;
        console.log(`✅ RTS seed fallback used: ${rtsEvidence}`);
      } else if (seed) {
        // A matching seed exists but has no valid Slack user ID configured —
        // better to show no reviewer mention than a broken unlinked one.
        rtsEvidence = `Found related discussion: "${seed.text.substring(0, 120)}..."`;
        console.warn(`⚠️ Seed match found for "${fileBaseName}" but no valid reviewer ID set — omitting mention.`);
      }
    }

    if (reviewerUserId) {
      suggestedReviewers.set(worstArtifact.id, reviewerUserId);
    }

    const codeSnippet = newContent.length > 600
      ? newContent.substring(0, 600) + '\n... (truncated)'
      : newContent;

    const severityRank: Record<string, number> = { Critical: 4, High: 3, Medium: 2, Low: 1 };
    const blastRadiusArtifacts = Array.isArray(blastRadius?.artifacts) ? [...blastRadius.artifacts] : [];
    const topBlastRadiusArtifacts = blastRadiusArtifacts
      .sort((a: any, b: any) =>
        (b.impactScore || 0) - (a.impactScore || 0) ||
        (severityRank[b.severity] || 0) - (severityRank[a.severity] || 0)
      )
      .slice(0, 4);
    const remainingBlastRadiusCount = Math.max(0, blastRadiusArtifacts.length - topBlastRadiusArtifacts.length);

    const blastRadiusText = topBlastRadiusArtifacts.map((artifact: any) =>
      `• ${artifact.name} (${artifact.type}) — ${artifact.severity} • impact score ${artifact.impactScore} • depth ${artifact.depth}`
    ).join('\n') || 'No additional impacted artifacts discovered.';

    const blastRadiusSummary = blastRadius?.summary || 'No graph traversal available.';
    const blastRadiusUrl = `${process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || '3000'}`}/graph/blast-radius/${encodeURIComponent(codeNode.id)}`;
    const severitySummary = worstArtifact.health >= 90
      ? '🟢 Low risk — minor drift, no urgent action needed.'
      : worstArtifact.health >= 70
        ? '🟡 Moderate risk — review recommended within a few days.'
        : '🔴 High risk — recommend reviewing before this drifts further.';
    const blastRadiusOverflowBlocks = remainingBlastRadiusCount > 0
      ? [{
          type: "context",
          elements: [{
            type: "mrkdwn",
            text: `+${remainingBlastRadiusCount} more artifacts — <${blastRadiusUrl}|view full graph>`
          }]
        }]
      : [];

    const driftCard = {
      channel: DRIFT_CHANNEL,
      text: 'Memory Decay Detected',
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: ":brain: MEMORY DECAY DETECTED", emoji: true }
        },
        {
          type: "section",
          fields: [
            { type: "mrkdwn", text: `*Memory Health:*\n${getHealthEmoji(worstArtifact.health)} ${worstArtifact.health}%` },
            { type: "mrkdwn", text: `*Time to Drift:*\n⏱️ ${formatDriftHours(worstArtifact.driftHours)} hours` }
          ]
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: severitySummary }
        },
        { type: "divider" },
        {
          type: "section",
          text: { type: "mrkdwn", text: `*📁 Changed File:*\n${targetFile}` }
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: `*🧭 Blast Radius:*\n${blastRadiusSummary}` }
        },
        {
          type: "section",
          text: { type: "mrkdwn", text: blastRadiusText }
        },
        ...blastRadiusOverflowBlocks,
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*📝 Code that changed:*\n\`\`\`\n${codeSnippet}\n\`\`\``
          }
        },
        { type: "divider" },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `🔍 *Evidence (RTS):* ${rtsEvidence}${reviewerUserId ? `\n👤 *Suggested reviewer:* <@${reviewerUserId}>` : ''}`
            }
          ]
        },
        {
          type: "actions",
          block_id: `actions_${worstArtifact.id}`,
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "📝 View Draft Fix" },
              action_id: "draft_fix",
              style: "primary",
              value: worstArtifact.id
            },
            {
              type: "button",
              text: { type: "plain_text", text: "✅ Mark as Intentional" },
              action_id: "mark_intentional",
              value: worstArtifact.id
            },
            {
              type: "button",
              text: { type: "plain_text", text: "🧭 Open Graph" },
              url: blastRadiusUrl,
              action_id: "open_graph",
              value: codeNode.id
            }
          ]
        }
      ]
    };

    try {
      await slack.chat.postMessage(driftCard);
      console.log(`✅ Successfully posted Drift Card to Slack! (RTS source: ${usedFallback ? 'seed fallback' : (reviewerUserId ? 'live search' : 'none')})`);
      await postFreshDashboard(DRIFT_CHANNEL);
      console.log('✅ Successfully posted Executive Dashboard!');
    } catch (error: any) {
      console.error('❌ Slack Posting Error:', error?.data?.error || error?.message || error);
    }
  }

  return { ignored: false, impact: impactedArtifacts, blastRadius };
}

async function analyzePredictivePullRequest(body: any): Promise<PredictiveDriftAnalysis> {
  const { owner, repo } = normalizeRepoFromPayload(body);
  const pullNumber = getPullRequestNumber(body);

  if (!owner || !repo || !pullNumber) {
    throw new Error('Missing owner, repo, or pull request number for predictive drift analysis.');
  }

  const pullRequest = body.pull_request || {};
  let changedFiles = extractChangedFilesFromPayload(body);
  if (changedFiles.length === 0) {
    changedFiles = await fetchPullRequestFiles(owner, repo, pullNumber);
  }

  const changedCodeNodes: any[] = [];
  const artifactById = new Map<string, PredictiveDriftArtifact>();

  for (const file of changedFiles) {
    const codeNode = findCodeNodeForTarget(file.filename);
    if (!codeNode) continue;

    changedCodeNodes.push(codeNode);

    let blastRadius: any = null;
    try {
      blastRadius = await analyzeBlastRadius(codeNode.id, 4);
    } catch (error: any) {
      console.warn(`⚠️ Predictive blast radius unavailable for ${codeNode.id}: ${error?.message || error}`);
    }

    const blastArtifacts = Array.isArray(blastRadius?.artifacts) ? blastRadius.artifacts : [];
    const directRelated = await graph.findRelatedNodes(codeNode.id);
    const candidates = [
      ...directRelated,
      ...blastArtifacts.map((artifact: any) => knowledgeGraph.find(n => n.id === artifact.id) || artifact)
    ].filter((node: any) => node && node.type !== 'Code');

    for (const node of candidates) {
      const blastArtifact = blastArtifacts.find((artifact: any) => artifact.id === node.id);
      const confidence = calculatePredictionConfidence(node, blastArtifact, file);
      const currentHealth = typeof node.memory_health_score === 'number' ? node.memory_health_score : 100;
      const prediction = predictArtifactHealth(node, confidence);
      const existing = artifactById.get(node.id);

      const candidate: PredictiveDriftArtifact = {
        id: node.id,
        name: node.name,
        type: node.type,
        currentHealth,
        predictedHealth: prediction.predictedHealth,
        predictedDecayHours: prediction.predictedDecayHours,
        confidence,
        impactScore: blastArtifact?.impactScore || confidence,
        severity: blastArtifact?.severity || classifyHealthSeverity(currentHealth),
        changedFile: file.filename,
        suggestion: ''
      };

      if (!existing || candidate.confidence > existing.confidence) {
        artifactById.set(node.id, candidate);
      }
    }
  }

  const artifacts = Array.from(artifactById.values())
    .sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name));

  const suggestionTargets = artifacts.slice(0, 6);
  for (const artifact of suggestionTargets) {
    const sourceFile = changedFiles.find(file => file.filename === artifact.changedFile);
    const graphNode = knowledgeGraph.find(n => n.id === artifact.id);
    artifact.suggestion = await generatePredictiveAISuggestion({
      artifactName: artifact.name,
      artifactType: artifact.type,
      currentContent: graphNode?.content || '',
      changedFile: artifact.changedFile,
      fileSignal: sourceFile ? changedFileToSignal(sourceFile) : artifact.changedFile,
      pullTitle: pullRequest.title || `PR #${pullNumber}`,
      pullBody: pullRequest.body || ''
    });
  }

  const blastRadiusSummary = artifacts.length > 0
    ? `${artifacts.length} likely stale artifacts predicted across ${changedCodeNodes.length} mapped code node(s).`
    : `No mapped documentation drift predicted from ${changedFiles.length} changed file(s).`;

  return {
    owner,
    repo,
    pullNumber,
    pullTitle: pullRequest.title || `PR #${pullNumber}`,
    pullUrl: pullRequest.html_url,
    author: pullRequest.user?.login,
    changedFiles,
    changedCodeNodes,
    artifacts,
    blastRadiusSummary
  };
}

async function postPredictiveDriftToSlack(analysis: PredictiveDriftAnalysis): Promise<void> {
  const overallConfidence = analysis.artifacts.length > 0
    ? Math.round(analysis.artifacts.reduce((sum, artifact) => sum + artifact.confidence, 0) / analysis.artifacts.length)
    : 0;

  const predictedDriftText = analysis.artifacts.slice(0, 8).map(artifact =>
    `• ${artifact.name} (${artifact.type}) — ${artifact.severity}, ${artifact.confidence}% confidence, predicted health ${getHealthEmoji(artifact.predictedHealth)} ${artifact.predictedHealth}%`
  ).join('\n') || 'No likely stale artifacts found for the mapped files in this PR.';

  const suggestions = analysis.artifacts
    .filter(artifact => artifact.suggestion)
    .slice(0, 4)
    .map(artifact => `*${artifact.name}:*\n${truncateForSlack(artifact.suggestion, 420)}`)
    .join('\n\n') || 'No AI suggestions generated.';

  await slack.chat.postMessage({
    channel: DRIFT_CHANNEL,
    text: 'Predictive Drift Detected',
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '🔮 PREDICTIVE DRIFT DETECTION', emoji: true }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `*PR:* <${analysis.pullUrl || '#'}|#${analysis.pullNumber} ${analysis.pullTitle}>` +
            `${analysis.author ? `\n*Author:* ${analysis.author}` : ''}` +
            `\n*Repository:* ${analysis.owner}/${analysis.repo}`
        }
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Confidence Score:*\n${overallConfidence}%` },
          { type: 'mrkdwn', text: `*Blast Radius:*\n${analysis.blastRadiusSummary}` }
        ]
      },
      { type: 'divider' },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Predicted Drift:*\n${predictedDriftText}` }
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Changed Files Analyzed:*\n${summarizeChangedFiles(analysis.changedFiles)}` }
      },
      { type: 'divider' },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Affected Services:*\n${summarizeArtifactGroup(analysis.artifacts, 'Service')}` },
          { type: 'mrkdwn', text: `*Affected Owners:*\n${summarizeArtifactGroup(analysis.artifacts, 'Owner')}` }
        ]
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Affected Documentation:*\n${[...analysis.artifacts.filter(a => ['Document', 'ADR'].includes(a.type)).slice(0, 6).map(a => `• ${a.name} (${a.confidence}%)`)].join('\n') || 'None predicted.'}` },
          { type: 'mrkdwn', text: `*Affected Runbooks:*\n${summarizeArtifactGroup(analysis.artifacts, 'Runbook')}` }
        ]
      },
      { type: 'divider' },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*AI Suggested Updates:*\n${truncateForSlack(suggestions, 2800)}` }
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: 'Prediction only: memory health is not mutated until the existing post-change drift webhook runs.'
          }
        ]
      }
    ]
  });
}

app.get('/graph/blast-radius/:nodeId', async (req, res) => {
  try {
    const analysis = await analyzeBlastRadius(req.params.nodeId, 4);
    const nodes = analysis.artifacts.flatMap((artifact: any) => artifact.pathNodeIds);
    const uniqueNodeIds = Array.from(new Set([analysis.startNodeId, ...nodes]));

    const edges = analysis.artifacts.flatMap((artifact: any) => {
      const ids = artifact.pathNodeIds || [];
      return ids.slice(0, -1).map((sourceId: string, index: number) => ({
        source: sourceId,
        target: ids[index + 1],
        relationshipType: artifact.relationshipTypes[index] || 'RELATED_TO'
      }));
    });

    const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Verity Blast Radius</title>
    <style>
      body { font-family: Inter, Arial, sans-serif; margin: 0; background: #07111f; color: #f8fafc; }
      .shell { display: grid; grid-template-columns: 2.2fr 1fr; min-height: 100vh; }
      .canvas { padding: 24px; background: linear-gradient(135deg, #0f172a, #111827); }
      .panel { padding: 24px; border-left: 1px solid #334155; background: #020617; }
      svg { width: 100%; height: 72vh; border: 1px solid #334155; border-radius: 16px; background: radial-gradient(circle at top, #172554 0%, #020617 65%); }
      .node { cursor: pointer; transition: all 0.2s ease; }
      .node-label { fill: #e2e8f0; font-size: 12px; font-weight: 600; }
      .edge { stroke: #60a5fa; stroke-width: 2; stroke-opacity: 0.75; transition: all 0.2s ease; }
      .edge.is-highlighted { stroke: #f59e0b; stroke-width: 3; }
      .node.is-highlighted { filter: drop-shadow(0 0 8px #f59e0b); }
      .summary { margin-bottom: 16px; }
      .chip { display: inline-block; padding: 4px 8px; border-radius: 999px; margin-right: 6px; margin-bottom: 6px; background: #1e293b; color: #e2e8f0; font-size: 12px; }
      .details { margin-top: 16px; padding: 12px; border: 1px solid #334155; border-radius: 12px; background: #0f172a; }
      .legend { margin-top: 16px; padding: 12px; border: 1px solid #334155; border-radius: 12px; background: #0f172a; }
      .legend-item { display: flex; align-items: center; gap: 8px; margin: 6px 0; color: #cbd5e1; font-size: 13px; }
      .legend-dot { width: 10px; height: 10px; border-radius: 999px; display: inline-block; }
      .legend-dot.critical { background: #ef4444; }
      .legend-dot.high { background: #f97316; }
      .legend-dot.medium { background: #eab308; }
      .legend-dot.low { background: #22c55e; }
      button { border: 0; background: #2563eb; color: white; padding: 8px 12px; border-radius: 8px; cursor: pointer; }
      code { color: #93c5fd; }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="canvas">
        <h2>🧭 Verity Blast Radius</h2>
        <p>${analysis.summary}</p>
        <svg id="graph" viewBox="0 0 900 640"></svg>
      </div>
      <div class="panel">
        <div class="summary">
          <div class="chip">Start: ${analysis.startNodeName}</div>
          <div class="chip">Depth: ${analysis.maxDepth}</div>
          <div class="chip">Artifacts: ${analysis.artifactCount}</div>
        </div>
        <div id="details" class="details">Select a node to inspect its path and severity.</div>
        <div class="legend">
          <div class="legend-item"><span class="legend-dot critical"></span>Critical</div>
          <div class="legend-item"><span class="legend-dot high"></span>High</div>
          <div class="legend-item"><span class="legend-dot medium"></span>Medium</div>
          <div class="legend-item"><span class="legend-dot low"></span>Low</div>
        </div>
        <div style="margin-top: 16px;">
          <h3>Impacted nodes</h3>
          ${analysis.artifacts.map((artifact: any) => `<div class="chip">${artifact.name} · ${artifact.severity}</div>`).join('')}
        </div>
      </div>
    </div>
    <script>
      const analysis = ${JSON.stringify(analysis)};
      const svg = document.getElementById('graph');
      const detailBox = document.getElementById('details');
      const width = 900;
      const height = 640;
      const nodes = ${JSON.stringify(uniqueNodeIds)}.map((id, index) => ({ id, x: 120 + (index % 3) * 260, y: 140 + Math.floor(index / 3) * 160 }));
      const nodeById = Object.fromEntries(nodes.map(node => [node.id, node]));
      const edges = ${JSON.stringify(edges)};
      const edgeElements = [];
      const nodeElements = [];
      const artifactById = Object.fromEntries(analysis.artifacts.map(artifact => [artifact.id, artifact]));

      const getSeverityColor = (severity) => {
        if (severity === 'Critical') return '#ef4444';
        if (severity === 'High') return '#f97316';
        if (severity === 'Medium') return '#eab308';
        if (severity === 'Low') return '#22c55e';
        return '#2563eb';
      };

      const createSvgElement = (tag, attrs = {}) => {
        const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
        Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
        return el;
      };

      edges.forEach(edge => {
        const source = nodeById[edge.source];
        const target = nodeById[edge.target];
        if (!source || !target) return;
        const line = createSvgElement('line', { x1: source.x, y1: source.y, x2: target.x, y2: target.y, class: 'edge' });
        line.dataset.relationship = edge.relationshipType;
        line.addEventListener('mouseenter', () => {
          detailBox.innerHTML = '<strong>' + edge.relationshipType + '</strong><br/>' + edge.source + ' → ' + edge.target;
        });
        svg.appendChild(line);
        edgeElements.push(line);
      });

      nodes.forEach(node => {
        const g = createSvgElement('g', { class: 'node' });
        const artifactForNode = artifactById[node.id];
        const circle = createSvgElement('circle', { cx: node.x, cy: node.y, r: 26, fill: getSeverityColor(artifactForNode?.severity) });
        const label = createSvgElement('text', { x: node.x, y: node.y + 44, class: 'node-label', 'text-anchor': 'middle' });
        label.textContent = node.id;
        g.appendChild(circle);
        g.appendChild(label);
        g.addEventListener('click', () => {
          const artifact = analysis.artifacts.find(item => item.pathNodeIds.includes(node.id));
          detailBox.innerHTML = artifact
            ? '<strong>' + artifact.name + '</strong><br/>Type: ' + artifact.type + '<br/>Severity: ' + artifact.severity + '<br/>Impact score: ' + artifact.impactScore + '<br/>Depth: ' + artifact.depth + '<br/>' + artifact.explanation
            : '<strong>' + node.id + '</strong><br/>Connected through the blast radius.';
          edgeElements.forEach(el => el.classList.remove('is-highlighted'));
          nodeElements.forEach(el => el.classList.remove('is-highlighted'));
          edgeElements.filter(el => el.dataset.relationship).forEach(el => {
            if (el.dataset.relationship) {
              el.classList.add('is-highlighted');
            }
          });
          g.classList.add('is-highlighted');
        });
        svg.appendChild(g);
        nodeElements.push(g);
      });
    </script>
  </body>
</html>`;

    res.type('html').send(html);
  } catch (error: any) {
    res.status(500).send(`<pre>${error?.message || error}</pre>`);
  }
});

app.post('/webhook/github', verifyGitHubWebhook, async (req, res) => {
  if (isPullRequestOpenedEvent(req)) {
    try {
      const analysis = await analyzePredictivePullRequest(req.body || {});
      await postPredictiveDriftToSlack(analysis);

      return res.status(200).send({
        message: 'Predictive drift analysis processed for opened pull request',
        pullRequest: analysis.pullNumber,
        changedFiles: analysis.changedFiles.map(file => file.filename),
        predictedArtifacts: analysis.artifacts.map(artifact => ({
          id: artifact.id,
          name: artifact.name,
          type: artifact.type,
          confidence: artifact.confidence,
          predictedHealth: artifact.predictedHealth
        }))
      });
    } catch (error: any) {
      console.error('❌ Predictive PR analysis failed:', error?.message || error);
      return res.status(500).send({
        message: 'Predictive drift analysis failed',
        error: error?.message || String(error)
      });
    }
  }

  const commitData = req.body || {};
  const targetFile = commitData.file || 'api/middleware/rateLimiter.js';
  const newContent = commitData.new_content || 'Uses in-memory limiter. Redis reverted due to connection drops.';

  const result = await processCodeChangeEvent(targetFile, newContent);
  res.status(200).send({
    message: result.ignored ? `Event ignored (${result.reason})` : 'Event processed',
    impact: result.impact
  });
});

app.post('/webhook/github-live', verifyGitHubWebhook, async (req, res) => {
  const body = req.body || {};
  const owner = body.owner || process.env.GITHUB_OWNER;
  const repo = body.repo || process.env.GITHUB_REPO;
  const targetPath = body.path || 'api/middleware/rateLimiter.js';

  if (!owner || !repo) {
    return res.status(400).send({
      message: 'Missing owner/repo — provide them in the request body or set GITHUB_OWNER / GITHUB_REPO in .env'
    });
  }

  console.log(`\n🔎 MCP: Fetching live content for ${owner}/${repo}/${targetPath}...`);
  const liveContent = await fetchFileContentViaMCP(owner, repo, targetPath);

  if (liveContent === null) {
    return res.status(502).send({
      message: 'Failed to fetch file via GitHub MCP server — check GITHUB_PERSONAL_ACCESS_TOKEN, repo access, and that the path exists.'
    });
  }

  console.log(`🔎 MCP: Fetching latest commit context for ${targetPath}...`);
  const commitContext = await fetchLatestCommitContextViaMCP(owner, repo, targetPath);
  if (commitContext) {
    console.log(`✅ MCP: Commit context found — "${commitContext.slice(0, 100)}..."`);
  } else {
    console.log('ℹ️ MCP: No commit context available (missing scope, no history, or unsupported by server).');
  }

  const result = await processCodeChangeEvent(targetPath, liveContent, commitContext);

  res.status(200).send({
    message: result.ignored ? `Event ignored (${result.reason})` : 'Event processed via live GitHub MCP pull',
    impact: result.impact,
    source: 'github-mcp',
    mcpCalls: {
      fileContent: true,
      commitContext: Boolean(commitContext)
    }
  });
});

// Temporary debug endpoint for local predictive analyzer testing.
// Safe to remove after verification; does not post to Slack or mutate webhook behavior.
app.get('/test-predictive', async (_req, res) => {
  try {
    const debugPayload = {
      owner: process.env.GITHUB_OWNER || 'debug-owner',
      repo: process.env.GITHUB_REPO || 'debug-repo',
      number: 0,
      pull_request: {
        number: 999999,
        title: 'Debug predictive drift test',
        body: 'Temporary local test for predictive drift analysis.',
        html_url: 'http://localhost/test-predictive',
        user: { login: 'debug' }
      },
      files: [
        {
          filename: 'api/middleware/rateLimiter.js',
          status: 'modified',
          additions: 1,
          deletions: 0,
          changes: 1,
          patch: '@@ debug predictive analyzer invocation for api/middleware/rateLimiter.js @@'
        }
      ]
    };

    const analysis = await analyzePredictivePullRequest(debugPayload);
    console.log('TEST PREDICTIVE ANALYSIS RESULT:', JSON.stringify(analysis, null, 2));

    res.status(200).json(analysis);
  } catch (error: any) {
    console.error('TEST PREDICTIVE ANALYSIS FAILED:', error?.message || error);
    res.status(500).json({
      message: 'Test predictive analysis failed',
      error: error?.message || String(error)
    });
  }
});

app.post(
  '/slack/events',
  express.json({
    verify: (req: any, _res: any, buf: Buffer) => {
      verifySlackSignature(req, _res, buf);
    }
  }),
  async (req, res) => {
    const body = req.body || {};

    if (body.type === 'url_verification') {
      return res.status(200).send({ challenge: body.challenge });
    }

    res.status(200).send();

    try {
      const event = body.event || {};
      if (event.type !== 'app_mention' || event.bot_id) return;

      const question = normalizeQuestionText(event.text || '');
      if (!question) {
        await slack.chat.postMessage({
          channel: event.channel,
          thread_ts: event.thread_ts || event.ts,
          text: 'Ask me about a system, service, owner, incident, recent change, architecture, or documentation drift.'
        });
        return;
      }

      const result = await generateConversationalAnswer(question);
      await slack.chat.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts || event.ts,
        text: formatConversationalSlackResponse(result)
      });
    } catch (error: any) {
      console.error('Error handling Slack app mention:', error?.data?.error || error?.message || error);
    }
  }
);

app.post(
  '/slack/commands',
  express.urlencoded({
    extended: true,
    verify: (req: any, _res: any, buf: Buffer) => {
      verifySlackSignature(req, _res, buf);
    }
  }),
  async (req, res) => {
    const text = (req.body?.text || '').trim();
    const command = String(req.body?.command || '').toLowerCase();

    if (command === '/verity') {
      if (!text) {
        return res.status(200).send({
          response_type: 'ephemeral',
          text:
            'Usage: `/verity <question>`\n' +
            'Examples: `/verity explain authentication`, `/verity who owns billing`, `/verity what changed this week`'
        });
      }

      res.status(200).send({
        response_type: 'ephemeral',
        text: 'Verity is checking Neo4j, Slack, GitHub, PRs, docs, runbooks, and incidents...'
      });

      try {
        const result = await generateConversationalAnswer(text);
        await postResponseUrl(req.body.response_url, {
          response_type: 'in_channel',
          replace_original: true,
          text: formatConversationalSlackResponse(result)
        });
      } catch (error: any) {
        await postResponseUrl(req.body.response_url, {
          response_type: 'ephemeral',
          replace_original: true,
          text: `Verity could not answer that safely: ${error?.message || error}`
        });
      }
      return;
    }

    if (!text) {
      return res.status(200).send({
        response_type: 'ephemeral',
        text:
          'Usage: `/verity-status <file-or-artifact-name>`\n' +
          'Example: `/verity-status rateLimiter`\n' +
          'For questions, use `/verity explain authentication` or mention `@Verity explain authentication`.'
      });
    }

    const query = text.toLowerCase();
    const matches = knowledgeGraph.filter(n =>
      n.name.toLowerCase().includes(query)
    );

    if (matches.length === 0) {
      return res.status(200).send({
        response_type: 'ephemeral',
        text: `No knowledge graph nodes matched "${text}".`
      });
    }

    const lines = matches
      .slice(0, 10)
      .map(n => `• *${n.name}* (${n.type}) — ${getHealthEmoji(n.memory_health_score)} ${n.memory_health_score}%`)
      .join('\n');

    return res.status(200).send({
      response_type: 'ephemeral',
      text: `*Drift status for "${text}":*\n${lines}`
    });
  }
);

app.post(
  '/slack/actions',
  express.urlencoded({
    extended: true,
    verify: (req: any, _res: any, buf: Buffer) => {
      verifySlackSignature(req, _res, buf);
    }
  }),
  async (req, res) => {
    res.status(200).send();

    try {
      const payload = JSON.parse(req.body.payload);

      if (payload.type === 'view_submission') {
        await handleEditSubmission(payload);
        return;
      }

      const action = payload.actions?.[0];
      if (!action) return;

      const actionId = action.action_id as string;
      const nodeId = action.value as string;
      const responseUrl = payload.response_url as string;

      console.log(`\n🖱️  BUTTON CLICKED: ${actionId} on node ${nodeId} by ${payload.user?.username}`);

      if (actionId === 'mark_intentional') {
        await handleMarkIntentional(nodeId, responseUrl, payload);
      } else if (actionId === 'draft_fix') {
        await handleDraftFix(nodeId, payload);
      } else if (actionId === 'verity_approve') {
        await handleApprove(nodeId, payload);
      } else if (actionId === 'verity_edit') {
        await handleEditOpen(nodeId, payload);
      } else if (actionId === 'verity_discard') {
        await handleDiscard(nodeId, payload);
      } else if (actionId === 'open_graph') {
        console.log(`🧭 Open Graph clicked for node ${nodeId} by ${payload.user?.username} — link-only button, no server action needed.`);
      }
    } catch (err: any) {
      console.error('❌ Error handling Slack action:', err.data?.error || err.message);
    }
  }
);

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err) {
    console.error('⚠️  Rejected request:', err.message);
    return res.status(400).send('Bad Request');
  }
});

async function handleMarkIntentional(nodeId: string, responseUrl: string, payload: any) {
  const node = knowledgeGraph.find(n => n.id === nodeId);

  if (node) {
    graph.updateNode(node.id, {
      memory_health_score: 100,
      last_updated: new Date().toISOString(),
      intentional: true
    });
    console.log(`✅ ${node.name} marked as intentional — health reset to 100%.`);
  } else {
    console.warn(`⚠️ mark_intentional: node ${nodeId} not found in graph.`);
  }

  const userId = payload.user?.id;
  const originalBlocks = payload.message?.blocks || [];

  const updatedBlocks = originalBlocks.map((block: any) => {
    if (block.type === 'actions') {
      return {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `:white_check_mark: Marked as intentional by <@${userId}> — drift acknowledged, no fix needed.`
          }
        ]
      };
    }
    return block;
  });

  await fetch(responseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      replace_original: true,
      text: 'Memory decay marked as intentional',
      blocks: updatedBlocks
    })
  });
}

// FIX: prompt now explicitly forbids inventing a causal story. The demo
// screenshot showed the AI claiming "this change was introduced as part
// of a new file creation" — that wasn't true, it was a modification, and
// for a tool whose whole pitch is "we catch stale/hallucinated knowledge,"
// having the AI draft itself hallucinate is a real credibility risk.
async function generateAIDraft(
  previousContent: string,
  newCodeContent: string,
  artifactName: string,
  fileName: string,
  commitContext?: string | null
): Promise<string> {
  try {
    const commitContextBlock = commitContext
      ? `\n\nRelevant commit/PR context (via GitHub MCP):\n"${commitContext}"\n`
      : '';

    const noContextInstruction = commitContext
      ? ''
      : `\nNo commit or PR context was available for this change. Do NOT invent or speculate ` +
        `about why the change was made, when the file was created, or any other detail not ` +
        `directly observable in the code itself. Describe only what changed and its effect.\n`;

    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 400,
      messages: [
        {
          role: 'user',
          content:
            `You are an internal documentation assistant. A codebase file changed, ` +
            `and a linked knowledge artifact is now out of date.\n\n` +
            `File: ${fileName}\n` +
            `Artifact needing update: ${artifactName}\n\n` +
            `Current (stale) artifact content:\n"${previousContent}"\n\n` +
            `New code behavior:\n"${newCodeContent}"` +
            `${commitContextBlock}` +
            `${noContextInstruction}\n` +
            `Write a concise (2-4 sentence) suggested replacement for the artifact ` +
            `content that reflects the new code behavior. If commit/PR context is ` +
            `provided above, you may use it to explain the *reason* for the change. ` +
            `If it is NOT provided, do not guess at a reason — describe only what the ` +
            `code now does. Never state or imply this is a newly created file unless the ` +
            `commit context explicitly says so. Mention any relevant tradeoffs briefly. ` +
            `Output ONLY the suggested replacement text — no preamble, no headers, no ` +
            `quotation marks.`
        }
      ]
    });

    const text = completion.choices[0]?.message?.content;
    return text ? text.trim() : 'Groq returned no text content — please review manually.';
  } catch (error: any) {
    console.error('⚠️ Groq API error:', error.message);
    return `[AI unavailable — fallback] Consider updating this artifact to reflect: "${newCodeContent}"`;
  }
}

async function generatePredictiveAISuggestion(input: {
  artifactName: string;
  artifactType: string;
  currentContent: string;
  changedFile: string;
  fileSignal: string;
  pullTitle: string;
  pullBody: string;
}): Promise<string> {
  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 220,
      messages: [
        {
          role: 'user',
          content:
            `You are Verity, an internal documentation drift assistant. A pull request was opened, ` +
            `but it has not merged yet. Predict what should be updated if the PR merges.\n\n` +
            `PR title: ${input.pullTitle}\n` +
            `PR body: ${input.pullBody || 'No PR body provided.'}\n\n` +
            `Changed file signal:\n${input.fileSignal}\n\n` +
            `Likely stale artifact: ${input.artifactName} (${input.artifactType})\n` +
            `Current artifact content:\n"${input.currentContent || 'No current content available.'}"\n\n` +
            `Write one concise pre-merge suggested update. Be explicit that this is conditional on ` +
            `the PR merging. Do not invent behavior beyond the changed file signal or PR context. ` +
            `Output only the suggestion text.`
        }
      ]
    });

    const text = completion.choices[0]?.message?.content;
    return text ? text.trim() : 'Review this artifact before merge; the PR changes a mapped code dependency.';
  } catch (error: any) {
    console.error('⚠️ Predictive Groq API error:', error.message);
    return `If this PR merges, review this ${input.artifactType.toLowerCase()} against ${input.changedFile}; the mapped code dependency is changing.`;
  }
}

async function handleDraftFix(nodeId: string, payload: any) {
  const artifact = knowledgeGraph.find(n => n.id === nodeId);

  const codeNode =
    knowledgeGraph.find(n => n.type === 'Code' && artifact?.relationships?.includes(n.id)) ||
    knowledgeGraph.find(n => n.type === 'Code');

  const thinkingMsg = await slack.chat.postMessage({
    channel: payload.channel?.id,
    thread_ts: payload.message.ts,
    text: '🤖 Generating AI draft...'
  });

  const commitContext = (codeNode as any)?.commit_context || null;

  const suggestedText = await generateAIDraft(
    artifact?.content || '',
    codeNode?.content || '',
    artifact?.name || 'Unknown artifact',
    codeNode?.name || 'unknown file',
    commitContext
  );

  draftSuggestions.set(nodeId, suggestedText);

  const reviewerUserId = suggestedReviewers.get(nodeId);

  const codeForDraft = (codeNode?.content || '').length > 400
    ? (codeNode?.content || '').substring(0, 400) + '\n... (truncated)'
    : (codeNode?.content || '');

  const draftText =
    `*Suggested Documentation Update*\n\n` +
    `*📁 File that changed:* ${codeNode?.name || 'unknown'}\n\n` +
    `*📝 Current code:*\n\`\`\`\n${codeForDraft}\n\`\`\`\n\n` +
    `*Previous (stale doc):*\n${formatSlackBlockQuote(`"${artifact?.content}"`)}\n\n` +
    `*Suggested (AI-generated via Groq/Llama 3.3):*\n"${suggestedText}"\n\n` +
    `*Sources:* ✓ GitHub Commit${commitContext ? ' + PR Context (MCP)' : ''} | ✓ Slack Discussion | ✓ Previous Doc` +
    (reviewerUserId ? `\n*Suggested reviewer:* <@${reviewerUserId}> (last discussed this area)` : '');

  try {
    if (thinkingMsg.ts) {
      await slack.chat.update({
        channel: payload.channel?.id,
        ts: thinkingMsg.ts,
        text: 'AI Draft Generated',
        blocks: [
          { type: "header", text: { type: "plain_text", text: ":robot_face: AI DRAFT GENERATOR", emoji: true } },
          { type: "section", text: { type: "mrkdwn", text: draftText } },
          { type: "divider" },
          {
            type: "actions",
            block_id: "approval_actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "✅ Approve & Restore Memory" },
                action_id: "verity_approve",
                style: "primary",
                value: nodeId
              },
              {
                type: "button",
                text: { type: "plain_text", text: "✏️ Edit" },
                action_id: "verity_edit",
                value: nodeId
              },
              {
                type: "button",
                text: { type: "plain_text", text: "🗑️ Discard" },
                action_id: "verity_discard",
                value: nodeId,
                style: "danger"
              }
            ]
          }
        ]
      });
    }

    const originalBlocks = payload.message?.blocks || [];
    const updatedBlocks = originalBlocks.map((block: any) => {
      if (block.type === 'actions') {
        return {
          type: "context",
          elements: [{ type: "mrkdwn", text: "⏳ *Status:* AI Draft generated. Awaiting human review in thread." }]
        };
      }
      return block;
    });

    await slack.chat.update({
      channel: payload.channel?.id,
      ts: payload.message.ts,
      text: 'Awaiting Approval',
      blocks: updatedBlocks
    });

    console.log(`✅ Draft fix thread posted for ${nodeId} (${artifact?.name || 'unknown'}).`);
  } catch (error: any) {
    console.error('❌ Error posting draft fix thread:', error?.data?.error || error?.message || error);
  }
}

async function postFreshDashboard(channel: string) {
  const nonCodeNodes = knowledgeGraph.filter(n => n.type !== 'Code');
  const healthByType = new Map<string, { total: number; count: number }>();
  nonCodeNodes.forEach(n => {
    const bucket = healthByType.get(n.type) || { total: 0, count: 0 };
    bucket.total += n.memory_health_score;
    bucket.count += 1;
    healthByType.set(n.type, bucket);
  });

  const overallHealth = nonCodeNodes.length > 0
    ? Math.round(nonCodeNodes.reduce((sum, n) => sum + n.memory_health_score, 0) / nonCodeNodes.length)
    : 100;

  const typeFields: { type: "mrkdwn"; text: string }[] = Array.from(healthByType.entries()).map(([type, { total, count }]) => {
    const avg = Math.round(total / count);
    return { type: "mrkdwn" as const, text: `*${type}*\n${getHealthEmoji(avg)} ${avg}%` };
  });

  const activeEvents = nonCodeNodes.filter(n => n.memory_health_score < 90).length;
  const overallHealthBar = formatHealthBar(overallHealth);

  await slack.chat.postMessage({
    channel,
    text: 'Memory Health Update',
    blocks: [
      { type: "header", text: { type: "plain_text", text: ":bar_chart: ORGANIZATIONAL MEMORY HEALTH", emoji: true } },
      { type: "context", elements: [{ type: "mrkdwn", text: "Continuous alignment tracking across engineering systems." }] },
      { type: "divider" },
      {
        type: "section",
        text: { type: "mrkdwn", text: `\`${overallHealthBar}\` ${overallHealth}%\nOverall System Health` }
      },
      {
        type: "section",
        fields: typeFields.slice(0, 10)
      },
      { type: "divider" },
      {
        type: "context",
        elements: [{
          type: "mrkdwn",
          text: `${activeEvents === 0 ? '🟢' : '🟡'} *System Status:* ${activeEvents === 0 ? 'Fully Aligned' : 'Partial Drift Remaining'} | *Active Events:* ${activeEvents}`
        }]
      }
    ]
  });
}

async function handleApprove(nodeId: string, payload: any) {
  const now = new Date().toISOString();

  const artifact = knowledgeGraph.find(n => n.id === nodeId);
  const codeNode =
    knowledgeGraph.find(n => n.type === 'Code' && artifact?.relationships?.includes(n.id)) ||
    knowledgeGraph.find(n => n.type === 'Code');

  const siblingArtifacts = codeNode
    ? knowledgeGraph.filter(n => n.type !== 'Code' && n.relationships?.includes(codeNode.id))
    : (artifact ? [artifact] : []);

  const restoredNames: string[] = [];
  siblingArtifacts.forEach(node => {
    graph.updateNode(node.id, { memory_health_score: 100, last_updated: now });
    restoredNames.push(node.name);
  });

  await slack.chat.update({
    channel: payload.channel?.id,
    ts: payload.message.ts,
    text: 'Memory Restored',
    blocks: [
      { type: "header", text: { type: "plain_text", text: ":white_check_mark: MEMORY RESTORED", emoji: true } },
      {
        type: "context",
        elements: [{
          type: "mrkdwn",
          text: `Organizational alignment has been restored for: ${restoredNames.join(', ') || 'the linked artifact'}.`
        }]
      }
    ]
  });

  await postFreshDashboard(payload.channel?.id || DRIFT_CHANNEL);
  console.log(`✅ Memory restored to 100% for: ${restoredNames.join(', ') || nodeId}.`);
}

const EDIT_BLOCK_ID = 'edit_block';
const EDIT_INPUT_ACTION_ID = 'edit_input';

async function handleEditOpen(nodeId: string, payload: any) {
  const triggerId = payload.trigger_id;
  if (!triggerId) {
    console.warn('⚠️ verity_edit: missing trigger_id, cannot open modal.');
    return;
  }

  const artifact = knowledgeGraph.find(n => n.id === nodeId);
  const prefill = draftSuggestions.get(nodeId) || artifact?.content || '';

  const privateMetadata = JSON.stringify({
    nodeId,
    channel: payload.channel?.id,
    messageTs: payload.message?.ts,
    threadTs: payload.message?.thread_ts || payload.message?.ts
  });

  try {
    await slack.views.open({
      trigger_id: triggerId,
      view: {
        type: 'modal',
        callback_id: 'edit_draft_modal',
        private_metadata: privateMetadata,
        title: { type: 'plain_text', text: 'Edit Draft' },
        submit: { type: 'plain_text', text: 'Save & Restore' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [
          {
            type: 'input',
            block_id: EDIT_BLOCK_ID,
            label: { type: 'plain_text', text: `Update: ${artifact?.name || 'artifact'}` },
            element: {
              type: 'plain_text_input',
              action_id: EDIT_INPUT_ACTION_ID,
              multiline: true,
              initial_value: prefill
            }
          }
        ]
      }
    });
    console.log(`✅ Edit modal opened for ${nodeId}.`);
  } catch (error: any) {
    console.error('❌ Error opening edit modal:', error.data?.error || error.message);
  }
}

async function handleEditSubmission(payload: any) {
  if (payload.view?.callback_id !== 'edit_draft_modal') return;

  let meta: { nodeId: string; channel: string; messageTs: string; threadTs: string };
  try {
    meta = JSON.parse(payload.view.private_metadata || '{}');
  } catch {
    console.error('❌ Could not parse private_metadata on edit submission.');
    return;
  }

  const editedText =
    payload.view.state?.values?.[EDIT_BLOCK_ID]?.[EDIT_INPUT_ACTION_ID]?.value?.trim();

  if (!editedText) {
    console.warn('⚠️ Edit submission had no text — ignoring.');
    return;
  }

  const { nodeId, channel, messageTs, threadTs } = meta;
  const now = new Date().toISOString();

  const artifact = knowledgeGraph.find(n => n.id === nodeId);
  if (artifact) {
    graph.updateNode(artifact.id, {
      content: editedText,
      memory_health_score: 100,
      last_updated: now
    });
  } else {
    console.warn(`⚠️ edit submission: node ${nodeId} not found in graph.`);
  }

  try {
    if (channel && messageTs) {
      await slack.chat.update({
        channel,
        ts: messageTs,
        text: 'Memory Restored (edited)',
        blocks: [
          { type: "header", text: { type: "plain_text", text: "✅ MEMORY RESTORED (edited by human)", emoji: true } },
          {
            type: "section",
            text: { type: "mrkdwn", text: `*Final content:*\n"${editedText}"` }
          },
          {
            type: "context",
            elements: [{ type: "mrkdwn", text: `✏️ Edited and saved by <@${payload.user?.id}>` }]
          }
        ]
      });
    }

    if (channel && threadTs) {
      await slack.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: `✅ Draft edited and saved by <@${payload.user?.id}> — memory restored to 100%.`
      });
    }

    if (channel) {
      await postFreshDashboard(channel);
    }

    console.log(`✅ Edited draft saved for ${nodeId}, health restored to 100%.`);
  } catch (error: any) {
    console.error('❌ Error finalizing edit submission:', error.data?.error || error.message);
  }
}

async function handleDiscard(nodeId: string, payload: any) {
  const artifact = knowledgeGraph.find(n => n.id === nodeId);
  const channel = payload.channel?.id;
  const messageTs = payload.message?.ts;
  const threadTs = payload.message?.thread_ts;

  draftSuggestions.delete(nodeId);

  try {
    if (channel && messageTs) {
      await slack.chat.update({
        channel,
        ts: messageTs,
        text: 'Draft Discarded',
        blocks: [
          { type: "header", text: { type: "plain_text", text: ":wastebasket: DRAFT DISCARDED", emoji: true } },
          {
            type: "context",
            elements: [{
              type: "mrkdwn",
              text: `Discarded by <@${payload.user?.id}>. "${artifact?.name || 'This artifact'}" is still marked as decayed — generate a new draft or mark it intentional from the original card.`
            }]
          }
        ]
      });
    }

    if (channel && threadTs) {
      const rootHistory = await slack.conversations.replies({
        channel,
        ts: threadTs,
        limit: 1,
        inclusive: true
      });
      const rootMessage = rootHistory.messages?.[0];

      if (rootMessage?.blocks) {
        const restoredBlocks = rootMessage.blocks.map((block: any) => {
          if (block.type === 'context' && block.elements?.[0]?.text?.includes('Awaiting human review')) {
            return {
              type: "actions",
              block_id: `actions_${nodeId}`,
              elements: [
                {
                  type: "button",
                  text: { type: "plain_text", text: "📝 View Draft Fix" },
                  action_id: "draft_fix",
                  style: "primary",
                  value: nodeId
                },
                {
                  type: "button",
                  text: { type: "plain_text", text: "✅ Mark as Intentional" },
                  action_id: "mark_intentional",
                  value: nodeId
                }
              ]
            };
          }
          return block;
        });

        await slack.chat.update({
          channel,
          ts: threadTs,
          text: 'Memory Decay Detected',
          blocks: restoredBlocks
        });
      }
    }

    console.log(`🗑️ Draft discarded for ${nodeId} by ${payload.user?.username}.`);
  } catch (error: any) {
    console.error('❌ Error handling discard:', error.data?.error || error.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Verity Decay Engine running on http://localhost:${PORT}`);
  console.log(`👉 Ready to receive webhooks.`);
  console.log(`👉 Slack interactions endpoint: /slack/actions`);
  console.log(`👉 Slack slash command endpoint: /slack/commands (/verity-status <file>)`);
  console.log(`👉 Posting drift cards to: ${DRIFT_CHANNEL}`);
  console.log(`👉 RTS fallback mode: ${RTS_DEV_MODE ? 'ON (default)' : 'OFF'}`);
});
