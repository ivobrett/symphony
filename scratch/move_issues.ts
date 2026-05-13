import { GraphQLClient, gql } from 'graphql-request';
import * as dotenv from 'dotenv';
dotenv.config();

const client = new GraphQLClient('https://api.linear.app/graphql', {
  headers: { Authorization: process.env.LINEAR_API_KEY! },
});

async function moveIssues() {
  // Get the "Todo" state ID
  const stateQuery = gql`
    query {
      workflowStates {
        nodes {
          id
          name
        }
      }
    }
  `;
  const states: any = await client.request(stateQuery);
  const todoState = states.workflowStates.nodes.find((s: any) => s.name === 'Todo' || s.name === 'To Do');
  
  if (!todoState) throw new Error('Could not find Todo state');

  const updateMutation = gql`
    mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
      }
    }
  `;

  await client.request(updateMutation, { id: 'IVO-11', input: { stateId: todoState.id } });
  console.log('Moved IVO-11 to Todo');
  await client.request(updateMutation, { id: 'IVO-12', input: { stateId: todoState.id } });
  console.log('Moved IVO-12 to Todo');
}

moveIssues().catch(console.error);
