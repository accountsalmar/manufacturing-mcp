import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { registerAllTools } from './tools/register-all.js';
import { warmCache } from './services/odoo-client.js';
import { warmPool } from './services/odoo-pool.js';

// ============================================
// Global Error Handlers - Prevent crashes
// ============================================
process.on('uncaughtException', (error) => {
  console.error('[FATAL] Uncaught exception (server will continue):', error.message);
});

process.on('unhandledRejection', (reason) => {
  console.error('[WARN] Unhandled promise rejection (server will continue):',
    reason instanceof Error ? reason.message : reason);
});

// Create MCP server instance
const server = new McpServer({
  name: 'odoo-manufacturing-mcp-server',
  version: '1.0.0'
});

// Register all manufacturing tools
registerAllTools(server);

// ============================================
// STDIO Transport (for Desktop Claude, Claude Code)
// ============================================
async function runStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Manufacturing MCP Server running on stdio');

  // Warm cache and pool asynchronously (non-blocking)
  Promise.all([warmCache(), warmPool()])
    .then(() => console.error('Cache and pool warmed successfully'))
    .catch(err => console.error('Warm-up error:', err instanceof Error ? err.message : err));
}

// ============================================
// HTTP Transport (for browser Claude.ai)
// ============================================
async function runHTTP(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // CORS headers for browser access
  app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    next();
  });

  app.options('/mcp', (_req, res) => {
    res.sendStatus(204);
  });

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', server: 'odoo-manufacturing-mcp-server', version: '1.0.0' });
  });

  // MCP endpoint - stateless, creates new transport per request
  app.post('/mcp', async (req, res) => {
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // Stateless mode
        enableJsonResponse: true
      });

      res.on('close', () => {
        transport.close();
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('MCP request error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  const port = parseInt(process.env.PORT || '3001');
  const host = process.env.HOST || '0.0.0.0';

  app.listen(port, host, () => {
    console.error(`Manufacturing MCP Server running on http://${host}:${port}/mcp`);

    // Warm cache and pool asynchronously (non-blocking)
    Promise.all([warmCache(), warmPool()])
      .then(() => console.error('Cache and pool warmed successfully'))
      .catch(err => console.error('Warm-up error:', err instanceof Error ? err.message : err));
  });
}

// ============================================
// Main Entry Point
// ============================================
const transport = process.env.TRANSPORT || 'stdio';

if (transport === 'http') {
  runHTTP().catch((error) => {
    console.error('Server error:', error);
    process.exit(1);
  });
} else {
  runStdio().catch((error) => {
    console.error('Server error:', error);
    process.exit(1);
  });
}
