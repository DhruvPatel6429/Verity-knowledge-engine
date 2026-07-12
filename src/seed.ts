import { knowledgeGraph, seedGraph } from './graph';

async function seed() {
  seedGraph();
  console.log('📊 Current Nodes:', JSON.stringify(knowledgeGraph, null, 2));
}

seed();