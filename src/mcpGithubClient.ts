import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// ============================================================
// GITHUB MCP CLIENT
// ============================================================
let clientInstance: Client | null = null;
let connectingPromise: Promise<Client> | null = null;

export async function getGithubMcpClient(): Promise<Client> {
  if (clientInstance) return clientInstance;
  if (connectingPromise) return connectingPromise;

  connectingPromise = (async () => {
    const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    if (!token) {
      throw new Error('GITHUB_PERSONAL_ACCESS_TOKEN is not set — cannot start GitHub MCP server.');
    }

    const transport = new StdioClientTransport({
      command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: {
        ...process.env,
        GITHUB_PERSONAL_ACCESS_TOKEN: token
      } as Record<string, string>
    });

    const client = new Client({ name: 'verity-mcp-client', version: '1.0.0' });
    await client.connect(transport);

    console.log('✅ Connected to GitHub MCP server.');
    clientInstance = client;
    return client;
  })();

  return connectingPromise;
}

export async function fetchFileContentViaMCP(
  owner: string,
  repo: string,
  path: string
): Promise<string | null> {
  try {
    const client = await getGithubMcpClient();

    const result = await client.callTool({
      name: 'get_file_contents',
      arguments: { owner, repo, path }
    });

    const content = result.content as Array<{ type: string; text?: string }> | undefined;
    const textBlock = content?.find(block => block.type === 'text');

    if (!textBlock?.text) {
      console.warn(`⚠️ MCP get_file_contents returned no text for ${owner}/${repo}/${path}`);
      return null;
    }

    try {
      const parsed = JSON.parse(textBlock.text);

      if (typeof parsed.content === 'string') {
        const strippedForTest = parsed.content.replace(/\s/g, '');
        const looksLikeBase64 = /^[A-Za-z0-9+/]+=*$/.test(strippedForTest) && strippedForTest.length > 0;

        if (looksLikeBase64) {
          return Buffer.from(strippedForTest, 'base64').toString('utf-8');
        }
        return parsed.content;
      }
    } catch {
      // Not JSON — treat as raw text content
    }

    return textBlock.text;
  } catch (error: any) {
    console.error(`⚠️ MCP fetchFileContentViaMCP error:`, error.message);
    return null;
  }
}

export async function fetchLatestCommitContextViaMCP(
  owner: string,
  repo: string,
  path: string
): Promise<string | null> {
  let client: Client;
  try {
    client = await getGithubMcpClient();
  } catch (error: any) {
    console.error(`⚠️ MCP fetchLatestCommitContextViaMCP: could not get client:`, error.message);
    return null;
  }

  const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  const headers: Record<string, string> = {
    'User-Agent': 'verity-agent',
    Accept: 'application/vnd.github+json'
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let latestCommitMessage: string | null = null;
  try {
    const commitResult = await client.callTool({
      name: 'list_commits',
      arguments: { owner, repo, perPage: 5 }
    });

    const content = commitResult.content as Array<{ type: string; text?: string }> | undefined;
    const textBlock = content?.find(block => block.type === 'text');

    if (textBlock?.text) {
      const parsed = JSON.parse(textBlock.text) as Array<{
        commit?: { message?: string };
      }>;

      if (Array.isArray(parsed) && parsed[0]?.commit?.message) {
        latestCommitMessage = parsed[0].commit.message;
      }
    }
  } catch (error: any) {
    console.warn('⚠️ MCP list_commits lookup failed while building commit context:', error.message);
  }

  let latestCommitSha: string | null = null;
  try {
    const commitResponse = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?path=${encodeURIComponent(path)}&per_page=1`,
      { headers }
    );

    if (!commitResponse.ok) {
      throw new Error(`GitHub commits lookup failed with ${commitResponse.status}`);
    }

    const commits = await commitResponse.json() as Array<{
      sha?: string;
      commit?: { message?: string };
    }>;

    const latestCommit = commits?.[0];
    if (latestCommit?.commit?.message) {
      latestCommitMessage = latestCommit.commit.message;
      latestCommitSha = latestCommit.sha || null;
    }
  } catch (error: any) {
    console.warn('⚠️ Path-specific commit lookup failed — falling back to repo-wide MCP result:', error.message);
  }

  let prBody: string | null = null;
  if (latestCommitSha) {
    try {
      const prLookupResponse = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(latestCommitSha)}/pulls`,
        { headers }
      );

      if (prLookupResponse.ok) {
        const prs = await prLookupResponse.json() as Array<{ number?: number; body?: string | null }>;
        const matchedPr = Array.isArray(prs) ? prs[0] : null;

        if (matchedPr?.number) {
          const prResult = await client.callTool({
            name: 'get_pull_request',
            arguments: { owner, repo, pull_number: matchedPr.number }
          });

          const prContent = prResult.content as Array<{ type: string; text?: string }> | undefined;
          const prTextBlock = prContent?.find(block => block.type === 'text');

          if (prTextBlock?.text) {
            const parsed = JSON.parse(prTextBlock.text) as { body?: string | null };
            if (typeof parsed.body === 'string' && parsed.body.trim()) {
              prBody = parsed.body.trim();
            }
          }
        }
      }
    } catch (error: any) {
      console.warn('⚠️ PR lookup/body fetch failed while building commit context:', error.message);
    }
  }

  const combinedContext = [latestCommitMessage, prBody].filter(Boolean).join('\n\n');
  return combinedContext || null;
}

export async function fetchRecentRepoActivityViaMCP(
  owner: string,
  repo: string
): Promise<{ commits: string[]; pullRequests: string[] }> {
  const activity = { commits: [] as string[], pullRequests: [] as string[] };

  let client: Client;
  try {
    client = await getGithubMcpClient();
  } catch (error: any) {
    console.error(`⚠️ MCP fetchRecentRepoActivityViaMCP: could not get client:`, error.message);
    return activity;
  }

  try {
    const commitResult = await client.callTool({
      name: 'list_commits',
      arguments: { owner, repo, perPage: 10 }
    });

    const content = commitResult.content as Array<{ type: string; text?: string }> | undefined;
    const textBlock = content?.find(block => block.type === 'text');

    if (textBlock?.text) {
      const parsed = JSON.parse(textBlock.text) as Array<{
        sha?: string;
        commit?: { message?: string; author?: { date?: string } };
      }>;

      if (Array.isArray(parsed)) {
        activity.commits = parsed
          .map(commit => {
            const shortSha = commit.sha ? commit.sha.slice(0, 7) : 'unknown';
            const date = commit.commit?.author?.date ? ` (${commit.commit.author.date})` : '';
            const message = commit.commit?.message?.split('\n')[0]?.trim();
            return message ? `${shortSha}${date}: ${message}` : null;
          })
          .filter((line): line is string => Boolean(line))
          .slice(0, 10);
      }
    }
  } catch (error: any) {
    console.warn('⚠️ MCP list_commits lookup failed while building recent activity:', error.message);
  }

  try {
    const token = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
    const headers: Record<string, string> = {
      'User-Agent': 'verity-agent',
      Accept: 'application/vnd.github+json'
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=all&sort=updated&direction=desc&per_page=5`,
      { headers }
    );

    if (!response.ok) {
      throw new Error(`GitHub pulls lookup failed with ${response.status}`);
    }

    const pulls = await response.json() as Array<{
      number?: number;
      title?: string;
      state?: string;
      body?: string | null;
      updated_at?: string;
    }>;

    activity.pullRequests = pulls
      .map(pr => {
        const body = pr.body?.trim() ? ` — ${pr.body.trim().slice(0, 180)}` : '';
        return pr.number && pr.title
          ? `#${pr.number} [${pr.state || 'unknown'}] ${pr.title}${pr.updated_at ? ` (${pr.updated_at})` : ''}${body}`
          : null;
      })
      .filter((line): line is string => Boolean(line));
  } catch (error: any) {
    console.warn('⚠️ Recent PR lookup failed while building recent activity:', error.message);
  }

  return activity;
}
