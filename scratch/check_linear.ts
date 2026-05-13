import { GraphQLClient, gql } from 'graphql-request';
import * as dotenv from 'dotenv';
dotenv.config();

const client = new GraphQLClient('https://api.linear.app/graphql', {
  headers: { Authorization: process.env.LINEAR_API_KEY! },
});

async function checkIssues() {
  const query = gql`
    query {
      i11: issue(id: "IVO-11") { identifier title state { name } project { slugId } }
      i12: issue(id: "IVO-12") { identifier title state { name } project { slugId } }
    }
  `;
  const data: any = await client.request(query);
  console.log(JSON.stringify(data, null, 2));
}

checkIssues().catch(console.error);
