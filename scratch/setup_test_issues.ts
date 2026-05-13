import { GraphQLClient, gql } from 'graphql-request';
import * as dotenv from 'dotenv';
dotenv.config();

const client = new GraphQLClient('https://api.linear.app/graphql', {
  headers: { Authorization: process.env.LINEAR_API_KEY! },
});

async function setupTestIssues() {
  // 1. Get Projects and Teams
  const discoveryQuery = gql`
    query {
      teams {
        nodes {
          id
          name
          key
        }
      }
      projects {
        nodes {
          id
          name
          slugId
        }
      }
    }
  `;

  const discovery: any = await client.request(discoveryQuery);
  const projects = discovery.projects.nodes;
  const teams = discovery.teams.nodes;

  console.log('Found Teams:', teams.map((t: any) => `${t.name} (${t.id})`).join(', '));
  console.log('Found Projects:', projects.map((p: any) => `${p.name} (${p.slugId})`).join(', '));

  const tp1 = projects.find((p: any) => p.slugId === '82d7507f10a4');
  const tp2 = projects.find((p: any) => p.slugId === '3f33b5af0a14');

  if (!tp1 || !tp2) {
    throw new Error('Could not find both test projects in Linear');
  }

  // Assuming the first team is the one to use
  const teamId = teams[0].id;

  // 2. Create Issue for Project 1
  const createIssueMutation = gql`
    mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue {
          id
          identifier
          title
        }
      }
    }
  `;

  console.log('Creating test issue for Test Project 1...');
  const res1: any = await client.request(createIssueMutation, {
    input: {
      title: 'TEST: Add multi-project description to Project 1 README',
      description: 'Please add a small section to the README explaining that this project is now managed by the Symphony Multi-Project Orchestrator.',
      teamId,
      projectId: tp1.id,
    },
  });
  console.log('Issue 1 created:', res1.issueCreate.issue.identifier);

  // 3. Create Issue for Project 2
  console.log('Creating test issue for Test Project 2...');
  const res2: any = await client.request(createIssueMutation, {
    input: {
      title: 'TEST: Add multi-project description to Project 2 README',
      description: 'Please add a small section to the README explaining that this project is now managed by the Symphony Multi-Project Orchestrator.',
      teamId,
      projectId: tp2.id,
    },
  });
  console.log('Issue 2 created:', res2.issueCreate.issue.identifier);
}

setupTestIssues().catch(console.error);
