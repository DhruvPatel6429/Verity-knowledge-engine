// ============================================================
// NEO4J KNOWLEDGE GRAPH ADAPTER
// ============================================================
import { Neo4jService, type GraphNode } from './neo4jService';

const neo4jService = Neo4jService.getInstance();

export const knowledgeGraph: any[] = [];

const cloneNode = (node: any): any => ({
  ...node,
  relationships: Array.isArray(node.relationships) ? [...node.relationships] : []
});

const syncCache = (nodes: any[]) => {
  knowledgeGraph.splice(0, knowledgeGraph.length, ...nodes.map(cloneNode));
  return knowledgeGraph;
};

const buildSeedNodes = (): GraphNode[] => {
  const now = new Date();
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000).toISOString();
  const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000).toISOString();

  return [
    {
      id: 'code-rate-limiter', type: 'Code', name: 'api/middleware/rateLimiter.js',
      content: 'Uses Redis token-bucket algorithm.', last_updated: now.toISOString(),
      memory_health_score: 100, relationships: ['doc-rate-limiter', 'jira-442', 'adr-rate-limiter', 'runbook-rate-limiter', 'service-api-gateway', 'owner-platform', 'slack-thread-rate-limit', 'incident-rate-limit'],
      relationshipTypes: {
        'doc-rate-limiter': 'DOCUMENTS',
        'jira-442': 'IMPLEMENTS',
        'adr-rate-limiter': 'DOCUMENTS',
        'runbook-rate-limiter': 'DOCUMENTS',
        'service-api-gateway': 'DEPENDS_ON',
        'owner-platform': 'OWNS',
        'slack-thread-rate-limit': 'MENTIONS',
        'incident-rate-limit': 'GENERATED_FROM'
      }
    },
    {
      id: 'doc-rate-limiter', type: 'Document', name: 'Notion: Rate Limiting Architecture',
      content: 'We use a Redis token-bucket for API rate limiting.', last_updated: daysAgo(3),
      memory_health_score: 100, relationships: ['code-rate-limiter'],
      relationshipTypes: { 'code-rate-limiter': 'DOCUMENTS' }
    },
    {
      id: 'jira-442', type: 'Jira', name: 'PROJ-442: Implement Rate Limiting',
      content: 'Task to implement rate limiting.', last_updated: hoursAgo(6),
      memory_health_score: 100, relationships: ['code-rate-limiter'],
      relationshipTypes: { 'code-rate-limiter': 'IMPLEMENTS' }
    },
    {
      id: 'code-auth', type: 'Code', name: 'api/middleware/auth.js',
      content: 'Session-cookie auth middleware after JWT refresh token rotation caused mobile logout loops.', last_updated: now.toISOString(),
      memory_health_score: 100, relationships: ['doc-auth', 'jira-auth', 'service-auth', 'owner-identity', 'runbook-auth', 'incident-auth-mobile', 'slack-thread-auth'],
      relationshipTypes: {
        'doc-auth': 'DOCUMENTS',
        'jira-auth': 'IMPLEMENTS',
        'service-auth': 'DEPENDS_ON',
        'owner-identity': 'OWNS',
        'runbook-auth': 'DOCUMENTS',
        'incident-auth-mobile': 'GENERATED_FROM',
        'slack-thread-auth': 'MENTIONS'
      }
    },
    {
      id: 'doc-auth', type: 'Document', name: 'Notion: Authentication Flow',
      content: 'We use JWT access + refresh tokens for authentication.', last_updated: daysAgo(10),
      memory_health_score: 100, relationships: ['code-auth'],
      relationshipTypes: { 'code-auth': 'DOCUMENTS' }
    },
    {
      id: 'jira-auth', type: 'Jira', name: 'PROJ-501: Harden Auth Middleware',
      content: 'Task to review and harden the auth middleware.', last_updated: hoursAgo(12),
      memory_health_score: 100, relationships: ['code-auth'],
      relationshipTypes: { 'code-auth': 'IMPLEMENTS' }
    },
    {
      id: 'service-auth', type: 'Service', name: 'identity-service',
      content: 'Identity service owns login sessions and auth middleware behavior.', last_updated: hoursAgo(9),
      memory_health_score: 91, relationships: ['code-auth'],
      relationshipTypes: { 'code-auth': 'DEPENDS_ON' }
    },
    {
      id: 'owner-identity', type: 'Owner', name: 'Identity Team',
      content: 'Team owning authentication, login session behavior, and auth runbooks.', last_updated: daysAgo(2),
      memory_health_score: 92, relationships: ['code-auth'],
      relationshipTypes: { 'code-auth': 'OWNS' }
    },
    {
      id: 'runbook-auth', type: 'Runbook', name: 'Runbook: Authentication Incident Response',
      content: 'Runbook for login loops, session cookie failures, and auth rollback checks.', last_updated: daysAgo(4),
      memory_health_score: 82, relationships: ['code-auth'],
      relationshipTypes: { 'code-auth': 'DOCUMENTS' }
    },
    {
      id: 'incident-auth-mobile', type: 'Incident', name: 'INC-188: Mobile logout loops',
      content: 'Mobile clients experienced logout loops while JWT refresh rotation was active.', last_updated: daysAgo(6),
      memory_health_score: 78, relationships: ['code-auth'],
      relationshipTypes: { 'code-auth': 'GENERATED_FROM' }
    },
    {
      id: 'slack-thread-auth', type: 'Slack Thread', name: 'Slack: auth rollback discussion',
      content: 'Thread notes say auth middleware returned to session cookies after mobile JWT refresh issues.', last_updated: hoursAgo(11),
      memory_health_score: 86, relationships: ['code-auth'],
      relationshipTypes: { 'code-auth': 'MENTIONS' }
    },
    {
      id: 'code-billing', type: 'Code', name: 'api/services/billing.js',
      content: 'Handles Stripe webhook retries with a capped retry count.', last_updated: now.toISOString(),
      memory_health_score: 100, relationships: ['doc-billing', 'jira-billing', 'service-billing', 'owner-billing', 'runbook-billing', 'incident-billing-stripe', 'slack-thread-billing'],
      relationshipTypes: {
        'doc-billing': 'DOCUMENTS',
        'jira-billing': 'IMPLEMENTS',
        'service-billing': 'DEPENDS_ON',
        'owner-billing': 'OWNS',
        'runbook-billing': 'DOCUMENTS',
        'incident-billing-stripe': 'GENERATED_FROM',
        'slack-thread-billing': 'MENTIONS'
      }
    },
    {
      id: 'doc-billing', type: 'Document', name: 'Notion: Billing Webhook Handling',
      content: 'We retry failed Stripe webhooks with unlimited retries.', last_updated: hoursAgo(8),
      memory_health_score: 100, relationships: ['code-billing'],
      relationshipTypes: { 'code-billing': 'DOCUMENTS' }
    },
    {
      id: 'jira-billing', type: 'Jira', name: 'PROJ-317: Fix Billing Webhook Retry Storm',
      content: 'Task to cap retry attempts on billing webhooks.', last_updated: daysAgo(5),
      memory_health_score: 100, relationships: ['code-billing'],
      relationshipTypes: { 'code-billing': 'IMPLEMENTS' }
    },
    {
      id: 'service-billing', type: 'Service', name: 'billing-service',
      content: 'Billing service processes Stripe webhook events and retry scheduling.', last_updated: hoursAgo(4),
      memory_health_score: 83, relationships: ['code-billing'],
      relationshipTypes: { 'code-billing': 'DEPENDS_ON' }
    },
    {
      id: 'owner-billing', type: 'Owner', name: 'Payments Team',
      content: 'Payments Team owns billing-service, Stripe webhook handling, and billing runbooks.', last_updated: daysAgo(1),
      memory_health_score: 94, relationships: ['code-billing'],
      relationshipTypes: { 'code-billing': 'OWNS' }
    },
    {
      id: 'runbook-billing', type: 'Runbook', name: 'Runbook: Stripe Webhook Retry Storm',
      content: 'Runbook for identifying Stripe retry storms, pausing consumers, and validating retry caps.', last_updated: daysAgo(3),
      memory_health_score: 80, relationships: ['code-billing'],
      relationshipTypes: { 'code-billing': 'DOCUMENTS' }
    },
    {
      id: 'incident-billing-stripe', type: 'Incident', name: 'INC-231: Stripe retry storm',
      content: 'Stripe incident caused repeated webhook deliveries before retries were capped at 3 attempts.', last_updated: daysAgo(7),
      memory_health_score: 76, relationships: ['code-billing'],
      relationshipTypes: { 'code-billing': 'GENERATED_FROM' }
    },
    {
      id: 'slack-thread-billing', type: 'Slack Thread', name: 'Slack: billing retry cap',
      content: 'Thread confirms billing webhook retries are capped at 3 after the Stripe retry storm.', last_updated: hoursAgo(8),
      memory_health_score: 85, relationships: ['code-billing'],
      relationshipTypes: { 'code-billing': 'MENTIONS' }
    },
    {
      id: 'adr-rate-limiter', type: 'ADR', name: 'ADR-014: Redis Token Bucket',
      content: 'ADR covering adaptive rate limiting.', last_updated: daysAgo(2),
      memory_health_score: 95, relationships: ['code-rate-limiter'],
      relationshipTypes: { 'code-rate-limiter': 'DOCUMENTS' }
    },
    {
      id: 'runbook-rate-limiter', type: 'Runbook', name: 'Runbook: Rate Limiter Incident Response',
      content: 'Runbook for limiter incidents and mitigation.', last_updated: hoursAgo(5),
      memory_health_score: 92, relationships: ['code-rate-limiter'],
      relationshipTypes: { 'code-rate-limiter': 'DOCUMENTS' }
    },
    {
      id: 'service-api-gateway', type: 'Service', name: 'api-gateway',
      content: 'Gateway service consuming rate limits.', last_updated: hoursAgo(3),
      memory_health_score: 88, relationships: ['code-rate-limiter'],
      relationshipTypes: { 'code-rate-limiter': 'DEPENDS_ON' }
    },
    {
      id: 'owner-platform', type: 'Owner', name: 'Platform Team',
      content: 'Team owning the gateway and limiter behavior.', last_updated: daysAgo(1),
      memory_health_score: 90, relationships: ['code-rate-limiter'],
      relationshipTypes: { 'code-rate-limiter': 'OWNS' }
    },
    {
      id: 'slack-thread-rate-limit', type: 'Slack Thread', name: 'Slack: limiter rollback discussion',
      content: 'Thread capturing earlier incident notes.', last_updated: hoursAgo(7),
      memory_health_score: 87, relationships: ['code-rate-limiter'],
      relationshipTypes: { 'code-rate-limiter': 'MENTIONS' }
    },
    {
      id: 'incident-rate-limit', type: 'Incident', name: 'INC-204: Redis connection saturation',
      content: 'Incident report linking Redis connection saturation to rate limiter changes.', last_updated: daysAgo(4),
      memory_health_score: 84, relationships: ['code-rate-limiter'],
      relationshipTypes: { 'code-rate-limiter': 'GENERATED_FROM' }
    }
  ];
};

// Keep the existing array-based API shape for compatibility, while using
// a local in-memory cache that is refreshed from Neo4j on seed/update.
export const graph = {
  findNode: (id: string) => {
    const cached = knowledgeGraph.find((n: any) => n.id === id);
    if (cached) return cached;

    void neo4jService.findNodeById(id).then((node) => {
      if (node) {
        const index = knowledgeGraph.findIndex((existing: any) => existing.id === id);
        if (index !== -1) {
          knowledgeGraph[index] = cloneNode(node);
        } else {
          knowledgeGraph.push(cloneNode(node));
        }
      }
    }).catch((error: unknown) => {
      console.warn(`⚠️ Neo4j lookup failed for ${id}: ${error instanceof Error ? error.message : String(error)}`);
    });
    return null;
  },

  findRelated: (id: string) => {
    const node = knowledgeGraph.find((n: any) => n.id === id);
    if (node && Array.isArray(node.relationships) && node.relationships.length > 0) {
      return knowledgeGraph.filter((n: any) => node.relationships.includes(n.id));
    }

    const related = [] as any[];
    void neo4jService.findRelatedNodes(id).then((nodes) => {
      if (nodes.length > 0) {
        syncCache(knowledgeGraph.map((existing: any) => existing.id === id ? { ...existing, relationships: nodes.map(n => n.id) } : existing).concat(nodes.filter((node) => !knowledgeGraph.some((existing: any) => existing.id === node.id))));
      }
    }).catch(() => undefined);
    return related;
  },

  findRelatedNodes: async (id: string) => {
    const node = knowledgeGraph.find((n: any) => n.id === id);

    if (node && Array.isArray(node.relationships) && node.relationships.length > 0) {
      return knowledgeGraph.filter((n: any) =>
        node.relationships.includes(n.id)
      );
    }

    const nodes = await neo4jService.findRelatedNodes(id);

    if (nodes.length > 0) {
      const relatedIds = nodes.map((n) => n.id);
      const updatedNode = knowledgeGraph.find((existing: any) => existing.id === id);
      const mergedNodes = [
        ...(updatedNode
          ? [{ ...cloneNode(updatedNode), relationships: relatedIds }]
          : []),
        ...knowledgeGraph
          .filter((existing: any) => existing.id !== id)
          .map((existing: any) => cloneNode(existing)),
        ...nodes.map((n) => cloneNode(n))
      ];

      syncCache(mergedNodes);
      return nodes;
    }

    if (node) {
      return [];
    }

    return [];
  },

  updateNode: (id: string, updates: any) => {
    const index = knowledgeGraph.findIndex((n: any) => n.id === id);
    if (index !== -1) {
      const updatedNode = { ...knowledgeGraph[index], ...updates };
      knowledgeGraph[index] = updatedNode;
      void neo4jService.updateNode(id, updates).catch((error: unknown) => {
        console.warn(`⚠️ Neo4j update failed for ${id}: ${error instanceof Error ? error.message : String(error)}`);
      });
      return updatedNode;
    }
    return null;
  }
};

export const analyzeBlastRadius = (id: string, maxDepth = 4) => neo4jService.analyzeBlastRadius(id, maxDepth);

export const seedGraph = () => {
  const seedNodes = buildSeedNodes();
  syncCache(seedNodes);

  console.log('✅ Graph seeded with 3 scenarios (rate limiter / auth / billing), each with independently staggered ages.');

  void neo4jService.initializeSchema().catch((error: unknown) => {
    console.warn(`⚠️ Neo4j schema initialization warning: ${error instanceof Error ? error.message : String(error)}`);
  });

  void neo4jService.seedNodes(seedNodes)
    .then(() => neo4jService.listNodes())
    .then((nodes) => {
      syncCache(nodes);
      console.log(`🧠 Neo4j cache refreshed with ${nodes.length} nodes`);
    })
    .catch((error: unknown) => {
      console.warn(`⚠️ Neo4j seeding warning: ${error instanceof Error ? error.message : String(error)}`);
    });
};
