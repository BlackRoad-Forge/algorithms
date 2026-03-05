/**
 * Cloudflare Worker: algorithms-health-monitor
 *
 * Monitors repository health by checking GitHub Actions workflow status,
 * open issues/PRs, and package availability. Runs on a cron schedule
 * and exposes a /health endpoint for manual checks.
 */

const GITHUB_API = "https://api.github.com";

async function getWorkflowStatus(owner, repo, headers) {
  const resp = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/actions/runs?per_page=5&status=completed`,
    { headers }
  );
  if (!resp.ok) return { status: "unknown", message: "Failed to fetch workflow runs" };

  const data = await resp.json();
  if (!data.workflow_runs || data.workflow_runs.length === 0) {
    return { status: "no_runs", message: "No completed workflow runs found" };
  }

  const latest = data.workflow_runs[0];
  return {
    status: latest.conclusion === "success" ? "passing" : latest.conclusion,
    workflow: latest.name,
    run_number: latest.run_number,
    updated_at: latest.updated_at,
    html_url: latest.html_url,
  };
}

async function getRepoStats(owner, repo, headers) {
  const [issuesResp, prsResp] = await Promise.all([
    fetch(`${GITHUB_API}/repos/${owner}/${repo}/issues?state=open&per_page=1`, { headers }),
    fetch(`${GITHUB_API}/repos/${owner}/${repo}/pulls?state=open&per_page=1`, { headers }),
  ]);

  const issueCount = issuesResp.headers.get("Link")
    ? parseInt(issuesResp.headers.get("Link").match(/page=(\d+)>; rel="last"/)?.[1] || "0")
    : (await issuesResp.json()).length;

  const prCount = prsResp.headers.get("Link")
    ? parseInt(prsResp.headers.get("Link").match(/page=(\d+)>; rel="last"/)?.[1] || "0")
    : (await prsResp.json()).length;

  return { open_issues: issueCount, open_prs: prCount };
}

async function checkPyPI(packageName) {
  const resp = await fetch(`https://pypi.org/pypi/${packageName}/json`);
  if (!resp.ok) return { available: false };

  const data = await resp.json();
  return {
    available: true,
    latest_version: data.info.version,
    summary: data.info.summary,
  };
}

async function buildHealthReport(env) {
  const owner = env.REPO_OWNER || "blackboxprogramming";
  const repo = env.REPO_NAME || "algorithms";
  const headers = {
    "User-Agent": "algorithms-health-monitor/1.0",
    Accept: "application/vnd.github.v3+json",
  };

  if (env.GITHUB_TOKEN) {
    headers.Authorization = `token ${env.GITHUB_TOKEN}`;
  }

  const [ci, stats, pypi] = await Promise.all([
    getWorkflowStatus(owner, repo, headers),
    getRepoStats(owner, repo, headers),
    checkPyPI("algorithms"),
  ]);

  const allPassing = ci.status === "passing" || ci.status === "no_runs";

  return {
    healthy: allPassing,
    timestamp: new Date().toISOString(),
    repository: `${owner}/${repo}`,
    ci,
    stats,
    pypi,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health" || url.pathname === "/") {
      const report = await buildHealthReport(env);
      return new Response(JSON.stringify(report, null, 2), {
        status: report.healthy ? 200 : 503,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=60",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    if (url.pathname === "/badge") {
      const report = await buildHealthReport(env);
      const color = report.healthy ? "brightgreen" : "red";
      const label = report.healthy ? "healthy" : "unhealthy";
      return Response.redirect(
        `https://img.shields.io/badge/status-${label}-${color}`,
        302
      );
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    const report = await buildHealthReport(env);
    console.log(`Health check: ${report.healthy ? "HEALTHY" : "UNHEALTHY"}`, JSON.stringify(report));
  },
};
