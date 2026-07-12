import neo4j, { Driver } from 'neo4j-driver';

export type GraphNode = {
  id: string;
  type: string;
  name: string;
  content?: string;
  last_updated?: string;
  memory_health_score?: number;
  relationships?: string[];
  relationshipTypes?: Record<string, string>;
  [key: string]: any;
};

export type BlastRadiusArtifact = {
  id: string;
  type: string;
  name: string;
  depth: number;
  impactScore: number;
  severity: string;
  relationshipTypes: string[];
  pathNodeIds: string[];
  explanation: string;
  last_updated?: string;
  memory_health_score?: number;
};

export type BlastRadiusAnalysis = {
  startNodeId: string;
  startNodeName: string;
  maxDepth: number;
  artifactCount: number;
  artifacts: BlastRadiusArtifact[];
  summary: string;
};

export const calculateImpactScore = (depth: number, relationshipType: string): number => {
  const relationshipWeights: Record<string, number> = {
    IMPLEMENTS: 1.3,
    DOCUMENTS: 1.1,
    DEPENDS_ON: 1.5,
    GENERATED_FROM: 1.2,
    OWNS: 1.0,
    MENTIONS: 0.8,
    PART_OF: 1.1,
    REVIEWED_BY: 0.9,
    RELATED_TO: 0.8
  };

  const weight = relationshipWeights[relationshipType.toUpperCase()] || 1;
  const score = 45 + Math.max(0, depth - 1) * 12 + weight * 10;
  return Math.max(10, Math.min(99, Math.round(score)));
};

export const classifyHealthSeverity = (health: number): string => {
  if (health < 60) return 'Critical';
  if (health < 80) return 'High';
  if (health < 90) return 'Medium';
  return 'Low';
};

const RELATIONSHIP_TYPES = [
  'IMPLEMENTS',
  'DOCUMENTS',
  'RELATED_TO',
  'DEPENDS_ON',
  'GENERATED_FROM',
  'OWNS',
  'MENTIONS',
  'PART_OF',
  'REVIEWED_BY'
] as const;

export class Neo4jService {
  private static instance: Neo4jService | null = null;
  private driver: Driver | null = null;
  private connected = false;
  private reconnecting = false;

  private readonly uri = process.env.NEO4J_URI || 'bolt://localhost:7687';
  private readonly user = process.env.NEO4J_USER || 'neo4j';
  private readonly password = process.env.NEO4J_PASSWORD || 'password';

  static getInstance(): Neo4jService {
    if (!Neo4jService.instance) {
      Neo4jService.instance = new Neo4jService();
    }
    return Neo4jService.instance;
  }

  async connect(): Promise<void> {
    if (this.driver && this.connected) return;
    if (this.reconnecting) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (this.driver && this.connected) return;
    }

    this.reconnecting = true;
    try {
      this.driver = neo4j.driver(this.uri, neo4j.auth.basic(this.user, this.password), {
        disableLosslessIntegers: true
      });
      await this.driver.verifyConnectivity();
      this.connected = true;
      console.log(`✅ Neo4j connected to ${this.uri}`);
    } catch (error) {
      this.connected = false;
      this.driver = null;
      console.warn(`⚠️ Neo4j unavailable at ${this.uri}: ${this.formatError(error)}`);
      throw error;
    } finally {
      this.reconnecting = false;
    }
  }

  async close(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
      this.connected = false;
    }
  }

  async initializeSchema(): Promise<void> {
    try {
      await this.connect();
      const queries = [
        'CREATE CONSTRAINT entity_id_unique IF NOT EXISTS FOR (n:Entity) REQUIRE n.id IS UNIQUE',
        'CREATE INDEX entity_type IF NOT EXISTS FOR (n:Entity) ON (n.type)',
        'CREATE INDEX entity_name IF NOT EXISTS FOR (n:Entity) ON (n.name)'
      ];

      for (const query of queries) {
        await this.runCypher(query, {}, 'write');
      }
    } catch (error) {
      console.warn(`⚠️ Neo4j schema initialization skipped: ${this.formatError(error)}`);
    }
  }

  async clearGraph(): Promise<void> {
    await this.runCypher('MATCH (n:Entity) DETACH DELETE n', {}, 'write');
  }

  async seedNodes(nodes: GraphNode[]): Promise<void> {
    await this.connect();
    await this.clearGraph();

    for (const node of nodes) {
      const normalizedType = this.normalizeNodeType(node.type);
      const properties = {
        id: node.id,
        type: normalizedType,
        name: node.name,
        content: node.content || '',
        last_updated: node.last_updated || new Date().toISOString(),
        memory_health_score: typeof node.memory_health_score === 'number' ? node.memory_health_score : 100,
        relationships: Array.isArray(node.relationships) ? node.relationships : []
      };

      await this.runCypher(
        `
          MERGE (n:Entity { id: $id })
          SET n.type = $type,
              n.name = $name,
              n.content = $content,
              n.last_updated = $last_updated,
              n.memory_health_score = $memory_health_score,
              n.relationships = $relationships
        `,
        properties,
        'write'
      );
    }

    for (const node of nodes) {
      const relatedTargets = Array.isArray(node.relationships) ? node.relationships : [];
      const relationshipTypes = node.relationshipTypes || {};

      for (const targetId of relatedTargets) {
        const relType = relationshipTypes[targetId] || 'RELATED_TO';
        await this.createRelationship(node.id, targetId, relType);
      }
    }
  }

  async findNodeById(id: string): Promise<GraphNode | null> {
    const rows = await this.runCypher(
      `
        MATCH (n:Entity { id: $id })
        OPTIONAL MATCH (n)-[r]->(m:Entity)
        WITH n, collect(DISTINCT m.id) AS relationships
        RETURN n { .*, labels: labels(n), relationships: relationships } AS node
      `,
      { id },
      'read'
    );

    const first = rows[0] as Record<string, any> | undefined;
    return first?.node ? this.normalizeNode(first.node) : null;
  }

  async listNodes(): Promise<GraphNode[]> {
    const rows = await this.runCypher(
      `
        MATCH (n:Entity)
        OPTIONAL MATCH (n)-[r]->(m:Entity)
        WITH n, collect(DISTINCT m.id) AS relationships
        RETURN n { .*, labels: labels(n), relationships: relationships } AS node
        ORDER BY n.name
      `,
      {},
      'read'
    );

    return (rows as Array<Record<string, any>>)
      .map(row => this.normalizeNode(row.node))
      .filter((node): node is GraphNode => node !== null);
  }

  async findRelatedNodes(id: string): Promise<GraphNode[]> {
    const rows = await this.runCypher(
      `
        MATCH (source:Entity { id: $id })-[r]->(target:Entity)
        RETURN target { .*, labels: labels(target), relationships: [] } AS node
        ORDER BY target.name
      `,
      { id },
      'read'
    );

    return (rows as Array<Record<string, any>>)
      .map(row => this.normalizeNode(row.node))
      .filter((node): node is GraphNode => node !== null);
  }

  async analyzeBlastRadius(startNodeId: string, maxDepth = 4): Promise<BlastRadiusAnalysis> {
    await this.connect();
    const allowedTypes = ['Document', 'ADR', 'Runbook', 'Jira', 'Service', 'Owner', 'Slack Thread', 'Incident', 'PR'];
    const safeMaxDepth = Number.isInteger(maxDepth) ? Math.max(1, Math.min(8, maxDepth)) : 4;
    const relationshipPattern = '[:IMPLEMENTS|DOCUMENTS|RELATED_TO|DEPENDS_ON|GENERATED_FROM|OWNS|MENTIONS|PART_OF|REVIEWED_BY*..' + safeMaxDepth + ']';

    const rows = await this.runCypher(
      `
        MATCH (start:Entity { id: $startNodeId })
        MATCH (target:Entity)
        WHERE target <> start
          AND target.type IN $allowedTypes
        MATCH p = shortestPath((start)-${relationshipPattern}-(target))
        WITH target, p, length(p) AS depth,
             [rel IN relationships(p) | type(rel)] AS relationshipTypes,
             [node IN nodes(p) | node.id] AS pathNodeIds
        RETURN {
          id: target.id,
          type: target.type,
          name: target.name,
          content: target.content,
          last_updated: target.last_updated,
          memory_health_score: target.memory_health_score,
          depth: depth,
          relationshipTypes: relationshipTypes,
          pathNodeIds: pathNodeIds
        } AS artifact
        ORDER BY depth ASC, target.name
      `,
      { startNodeId, allowedTypes },
      'read'
    );

    const artifacts: BlastRadiusArtifact[] = (rows as Array<Record<string, any>>)
      .map(row => row.artifact)
      .filter(Boolean)
      .map((artifact: any) => {
        const relationshipType = Array.isArray(artifact.relationshipTypes) && artifact.relationshipTypes.length > 0
          ? artifact.relationshipTypes[artifact.relationshipTypes.length - 1]
          : 'RELATED_TO';
        const impactScore = calculateImpactScore(artifact.depth || 1, relationshipType);
        const health = typeof artifact.memory_health_score === 'number' ? artifact.memory_health_score : 100;
        const severity = classifyHealthSeverity(health);
        console.info(
          `[blast-radius severity] id=${artifact.id} name="${artifact.name}" ` +
          `memory_health_score=${health} severity=${severity} impactScore=${impactScore}`
        );
        const pathNodeIds = Array.isArray(artifact.pathNodeIds) ? artifact.pathNodeIds : [];
        const explanation = pathNodeIds.length > 2
          ? `Reached through ${artifact.relationshipTypes?.join(' → ') || 'RELATED_TO'} across ${artifact.depth} hops.`
          : `Reached through ${relationshipType} at depth ${artifact.depth || 1}.`;

        return {
          id: artifact.id,
          type: this.normalizeNodeType(artifact.type),
          name: artifact.name,
          depth: artifact.depth || 1,
          impactScore,
          severity,
          relationshipTypes: Array.isArray(artifact.relationshipTypes) ? artifact.relationshipTypes : [],
          pathNodeIds,
          explanation,
          last_updated: artifact.last_updated,
          memory_health_score: health
        };
      });

    const startNode = await this.findNodeById(startNodeId);
    const summary = artifacts.length > 0
      ? `${artifacts.length} impacted artifacts discovered via recursive Neo4j traversal from ${startNode?.name || startNodeId}.`
      : `No additional impacted artifacts discovered from ${startNode?.name || startNodeId}.`;

    return {
      startNodeId,
      startNodeName: startNode?.name || startNodeId,
      maxDepth,
      artifactCount: artifacts.length,
      artifacts,
      summary
    };
  }

  async updateNode(id: string, updates: Record<string, any>): Promise<GraphNode | null> {
    await this.connect();
    const updateEntries = Object.entries(updates).filter(([, value]) => value !== undefined);
    if (updateEntries.length === 0) {
      return this.findNodeById(id);
    }

    const setClauses = updateEntries.map(([key]) => `n.${key} = $${key}`).join(', ');
    const parameters = { id, ...Object.fromEntries(updateEntries.map(([key, value]) => [key, value])) };

    await this.runCypher(`MERGE (n:Entity { id: $id }) SET ${setClauses}`, parameters, 'write');
    return this.findNodeById(id);
  }

  private async createRelationship(sourceId: string, targetId: string, relationshipType: string): Promise<void> {
    const type = this.normalizeRelationshipType(relationshipType);
    await this.runCypher(
      `
        MATCH (source:Entity { id: $sourceId }), (target:Entity { id: $targetId })
        MERGE (source)-[r:${type}]->(target)
      `,
      { sourceId, targetId },
      'write'
    );
  }

  private async runCypher(
    query: string,
    parameters: Record<string, any> = {},
    mode: 'read' | 'write' = 'read'
  ): Promise<Array<Record<string, any>>> {
    await this.ensureConnected();
    if (!this.driver) {
      return [];
    }

    const session = this.driver.session();
    try {
      const result = mode === 'write'
        ? await session.executeWrite(tx => tx.run(query, parameters))
        : await session.executeRead(tx => tx.run(query, parameters));

      return result.records.map(record => record.toObject());
    } catch (error) {
      if (this.isTransientError(error)) {
        await this.reconnect();
        return this.runCypher(query, parameters, mode);
      }
      throw error;
    } finally {
      await session.close();
    }
  }

  private async ensureConnected(): Promise<void> {
    try {
      await this.connect();
    } catch (error) {
      await this.reconnect();
    }
  }

  private async reconnect(): Promise<void> {
    if (this.reconnecting) return;
    this.connected = false;
    this.driver = null;
    try {
      await this.connect();
    } catch {
      // Reconnection failures are handled by the caller and surfaced as warnings.
    }
  }

  private normalizeNodeType(type: string): string {
    return type === 'Ticket' ? 'Jira' : (type || 'Unknown');
  }

  private normalizeNode(node: any): GraphNode | null {
    if (!node || !node.id) return null;
    return {
      ...node,
      type: this.normalizeNodeType(node.type),
      relationships: Array.isArray(node.relationships) ? node.relationships : []
    } as GraphNode;
  }

  private normalizeRelationshipType(type: string): string {
    const normalized = (type || 'RELATED_TO').toUpperCase();
    return RELATIONSHIP_TYPES.includes(normalized as typeof RELATIONSHIP_TYPES[number])
      ? normalized
      : 'RELATED_TO';
  }

  private isTransientError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /ServiceUnavailable|connection|connect|Transient|temporar|database is unavailable/i.test(message);
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }
}
