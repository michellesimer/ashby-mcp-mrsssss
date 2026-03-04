/**
 * Ashby MCP Server for Cloudflare Workers
 *
 * What this file does, in plain English:
 * 1. Listens for requests from Claude
 * 2. When Claude asks "what tools do you have?", it returns a list of tools
 * 3. When Claude calls a tool, this file calls the Ashby API with your key
 * 4. Returns the result back to Claude
 *
 * The ONLY external URL this file ever calls is: https://api.ashbyhq.com
 * You can verify this by searching for "fetch(" below — every one points there.
 */

// ─── Ashby API helper ───────────────────────────────────────────────────────
// Calls the Ashby API. Your API key is stored as a secret in Cloudflare —
// it never appears in this code file.
async function callAshby(endpoint, body, apiKey) {
  const credentials = btoa(apiKey + ":"); // Basic auth: key as username, no password
  const res = await fetch(`https://api.ashbyhq.com/${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Basic ${credentials}`,
    },
    body: JSON.stringify(body ?? {}),
  });
  return res.json();
}

// ─── Tool definitions ────────────────────────────────────────────────────────
// These are the tools Claude can see and call. Each one maps to one Ashby endpoint.
const TOOLS = [
  {
    name: "list_jobs",
    description: "List all jobs in Ashby (open, closed, archived). Optionally filter by status: Open, Closed, Archived, Draft.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: "Filter by status: Open, Closed, Archived, or Draft",
        },
      },
    },
  },
  {
    name: "list_candidates",
    description: "List all candidates in Ashby. Returns names, emails, and IDs.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "search_candidates",
    description: "Search for a candidate by name or email.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Candidate name to search for" },
        email: { type: "string", description: "Candidate email to search for" },
      },
    },
  },
  {
    name: "list_applications",
    description: "List all job applications. Optionally filter by job ID.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "Filter applications by job ID" },
      },
    },
  },
  {
    name: "get_candidate",
    description: "Get full details for a single candidate by their ID.",
    inputSchema: {
      type: "object",
      required: ["candidateId"],
      properties: {
        candidateId: { type: "string", description: "The candidate's Ashby ID" },
      },
    },
  },
];

// ─── Tool execution ───────────────────────────────────────────────────────────
// This is the switch that routes each tool call to the correct Ashby endpoint.
async function executeTool(name, args, apiKey) {
  switch (name) {
    case "list_jobs":
      return callAshby("job.list", args.status ? { status: [args.status] } : {}, apiKey);

    case "list_candidates":
      return callAshby("candidate.list", {}, apiKey);

    case "search_candidates":
      return callAshby("candidate.search", {
        ...(args.name && { name: args.name }),
        ...(args.email && { email: args.email }),
      }, apiKey);

    case "list_applications":
      return callAshby("application.list", args.jobId ? { jobId: args.jobId } : {}, apiKey);

    case "get_candidate":
      return callAshby("candidate.info", { id: args.candidateId }, apiKey);

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ─── MCP Protocol handler ─────────────────────────────────────────────────────
// This speaks the MCP "language" that Claude understands.
// It handles 3 types of messages:
//   initialize    → Claude says hello, we say hello back
//   tools/list    → Claude asks what tools exist, we return TOOLS above
//   tools/call    → Claude calls a tool, we execute it and return the result
async function handleMCP(req, apiKey) {
  const msg = await req.json();
  const { method, id, params } = msg;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "ashby-mcp", version: "1.0.0" },
        capabilities: { tools: {} },
      },
    };
  }

  if (method === "notifications/initialized") {
    return null; // No response needed
  }

  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
  }

  if (method === "tools/call") {
    const result = await executeTool(params.name, params.arguments ?? {}, apiKey);
    return {
      jsonrpc: "2.0", id,
      result: {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      },
    };
  }

  return {
    jsonrpc: "2.0", id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

// ─── Cloudflare Worker entry point ────────────────────────────────────────────
// This is what Cloudflare calls when a request comes in.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS headers — required so Claude can talk to this server from the browser
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Content-Type": "application/json",
    };

    // Handle browser preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    // Health check — visit your worker URL in a browser to confirm it's running
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok", server: "ashby-mcp" }), { headers });
    }

    // Main MCP endpoint — this is where Claude connects
    if (url.pathname === "/mcp" && request.method === "POST") {
      const apiKey = env.ASHBY_API_KEY;
      if (!apiKey) {
        return new Response(JSON.stringify({ error: "ASHBY_API_KEY not set" }), { status: 500, headers });
      }
      const response = await handleMCP(request, apiKey);
      if (!response) return new Response(null, { status: 204, headers });
      return new Response(JSON.stringify(response), { headers });
    }

    return new Response(JSON.stringify({ error: "Not found" }), { status: 404, headers });
  },
};
