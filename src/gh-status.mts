#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

interface ScialectConfig {
  github?: {
    repo?: string;
  };
}

function loadConfig(): ScialectConfig {
  const configPath = resolve(process.cwd(), 'scialect.json');
  const examplePath = resolve(process.cwd(), 'scialect.example.json');

  let pathToUse = configPath;

  if (!existsSync(configPath)) {
    if (existsSync(examplePath)) {
      pathToUse = examplePath;
    } else {
      console.error('No scialect.json or scialect.example.json found.');
      console.error('Create scialect.json with at least: { "github": { "repo": "owner/repo" } }');
      process.exit(1);
    }
  }

  try {
    const content = readFileSync(pathToUse, 'utf8');
    return JSON.parse(content) as ScialectConfig;
  } catch (e) {
    console.error(`Failed to read or parse ${pathToUse}`);
    console.error(e);
    process.exit(1);
  }
}

async function main() {
  const config = loadConfig();
  const repo = config.github?.repo;

  if (!repo) {
    console.error('No github.repo found in config.');
    console.error('Add "github": { "repo": "owner/repo" } to scialect.json');
    process.exit(1);
  }

  // GitHub PRs + checks (single fast query using GraphQL)
  console.log('--- Open PRs ---');

  const [owner, name] = repo.split('/');
  if (!owner || !name) {
    console.error(`Invalid repo format: ${repo}. Expected "owner/name".`);
    process.exit(1);
  }

  const graphqlQuery = `
    query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        pullRequests(first: 30, states: [OPEN], orderBy: {field: UPDATED_AT, direction: DESC}) {
          nodes {
            number
            title
            author { login }
            headRefName
            statusCheckRollup {
              state
              contexts(first: 20) {
                nodes {
                  ... on CheckRun { conclusion name status }
                  ... on StatusContext { state context }
                }
              }
            }
          }
        }
      }
    }
  `;

  const ghGraphql = spawnSync(
    'gh',
    ['api', 'graphql', '-f', `query=${graphqlQuery}`, '-f', `owner=${owner}`, '-f', `name=${name}`],
    { encoding: 'utf8' }
  );

  if (ghGraphql.status !== 0) {
    console.error('Failed to query GitHub (gh api graphql). Is gh installed and authenticated?');
    console.error(ghGraphql.stderr || ghGraphql.stdout);
    process.exit(1);
  }

  let data: any;
  try {
    data = JSON.parse(ghGraphql.stdout);
  } catch {
    console.error('Failed to parse GraphQL response');
    process.exit(1);
  }

  const prs = data?.data?.repository?.pullRequests?.nodes ?? [];

  if (prs.length === 0) {
    console.log('No open pull requests.\n');
    return;
  }

  const getCheckSymbol = (check: any): string => {
    const s = check.conclusion || check.state || '';
    switch (s) {
      case 'SUCCESS':
      case 'EXPECTED':
        return '🟢';
      case 'FAILURE':
      case 'ERROR':
      case 'CANCELLED':
        return '🔴';
      case 'PENDING':
      case 'IN_PROGRESS':
      case 'QUEUED':
        return '🟡';
      default:
        return '⚪';
    }
  };

  for (const pr of prs) {
    const title = pr.title.length > 55 ? pr.title.slice(0, 52) + '...' : pr.title;

    const checks = pr.statusCheckRollup?.contexts?.nodes ?? [];
    const symbols = checks.map((c: any) => getCheckSymbol(c)).join('');

    const overallState = pr.statusCheckRollup?.state;
    const overall = overallState ? getCheckSymbol({ conclusion: overallState }) : '';

    const line = `#${pr.number}  ${title}   ${symbols || overall || '—'}`;
    console.log(line);
  }

  console.log('');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
