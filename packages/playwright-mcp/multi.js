/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Uses only publicly exported subpaths from playwright.
const { createConnection } = require('playwright/lib/mcp/index');
const { InProcessTransport, createServer } = require('playwright/lib/mcp/sdk/exports');

let _sessionCounter = 0;

/**
 * @typedef {{ client: import('@modelcontextprotocol/sdk/client/index.js').Client, close: () => Promise<void> }} Session
 */

class MultiSessionBackend {
  constructor(config) {
    this._config = config;
    /** @type {Map<string, Session>} */
    this._sessions = new Map();
    this._toolsCache = undefined;
  }

  async initialize(clientInfo) {
    // Nothing to do — sessions are initialized lazily.
  }

  /**
   * Create a new session by spinning up a full MCP server via createConnection
   * and connecting to it via in-process transport + Client.
   */
  async _createSession(sessionId) {
    // Each session needs its own isolated browser profile to avoid conflicts.
    const sessionConfig = {
      ...this._config,
      browser: { ...this._config.browser, isolated: true },
    };
    const server = await createConnection(sessionConfig);
    const transport = new InProcessTransport(server);
    const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
    const client = new Client({ name: 'multi-session-proxy', version: '1.0.0' });
    await client.connect(transport);
    await client.ping();
    const session = {
      client,
      close: async () => {
        await client.close();
      },
    };
    this._sessions.set(sessionId, session);
    return session;
  }

  async listTools() {
    if (!this._toolsCache) {
      // Create a temporary session to discover available tools
      const tempServer = await createConnection({ ...this._config, browser: { ...this._config.browser, isolated: true } });
      const transport = new InProcessTransport(tempServer);
      const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
      const tempClient = new Client({ name: 'tool-discovery', version: '1.0.0' });
      await tempClient.connect(transport);
      const { tools } = await tempClient.listTools();
      this._toolsCache = tools;
      await tempClient.close();
    }

    const sessionIdProperty = {
      type: 'string',
      description: 'Session ID returned by browser_new_session. If omitted, uses the most recently created session.',
    };

    // Inject sessionId into every existing tool's input schema
    const tools = this._toolsCache.map(tool => {
      const schema = { ...tool.inputSchema };
      schema.properties = {
        ...schema.properties,
        sessionId: sessionIdProperty,
      };
      return { ...tool, inputSchema: schema };
    });

    // Add session management tools
    tools.push({
      name: 'browser_new_session',
      description: 'Create a new browser session. Returns a sessionId that can be passed to other tools to target this browser.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      annotations: {
        title: 'New browser session',
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
      },
    });

    tools.push({
      name: 'browser_list_sessions',
      description: 'List all active browser sessions and their IDs.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      annotations: {
        title: 'List browser sessions',
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      },
    });

    tools.push({
      name: 'browser_close_session',
      description: 'Close a browser session and free its resources.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: {
            type: 'string',
            description: 'The session ID to close.',
          },
        },
        required: ['sessionId'],
      },
      annotations: {
        title: 'Close browser session',
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    });

    return tools;
  }

  async callTool(name, rawArguments, progress) {
    if (name === 'browser_new_session')
      return this._handleNewSession();
    if (name === 'browser_list_sessions')
      return this._handleListSessions();
    if (name === 'browser_close_session')
      return this._handleCloseSession(rawArguments);

    // Extract sessionId from arguments, route to the right session
    const { sessionId, ...toolArguments } = rawArguments || {};
    const resolvedId = sessionId || this._lastSessionId();
    if (!resolvedId) {
      return {
        content: [{ type: 'text', text: '### Error\nNo active sessions. Call browser_new_session first.' }],
        isError: true,
      };
    }

    const session = this._sessions.get(resolvedId);
    if (!session) {
      return {
        content: [{ type: 'text', text: `### Error\nSession "${resolvedId}" not found. Use browser_list_sessions to see active sessions.` }],
        isError: true,
      };
    }

    const result = await session.client.callTool({ name, arguments: toolArguments });

    // Prepend session info to the response
    const sessionPrefix = { type: 'text', text: `### Session\n${resolvedId}\n` };
    return {
      ...result,
      content: [sessionPrefix, ...(result.content || [])],
    };
  }

  _lastSessionId() {
    const keys = [...this._sessions.keys()];
    return keys.length > 0 ? keys[keys.length - 1] : undefined;
  }

  async _handleNewSession() {
    const sessionId = 'session_' + (++_sessionCounter);
    await this._createSession(sessionId);
    return {
      content: [{ type: 'text', text: `### Result\nCreated new browser session.\n\n### Session\n${sessionId}` }],
    };
  }

  _handleListSessions() {
    const sessions = [...this._sessions.keys()];
    if (sessions.length === 0) {
      return {
        content: [{ type: 'text', text: '### Result\nNo active sessions. Call browser_new_session to create one.' }],
      };
    }
    const list = sessions.map(id => `- ${id}`).join('\n');
    return {
      content: [{ type: 'text', text: `### Result\nActive sessions:\n${list}` }],
    };
  }

  async _handleCloseSession(rawArguments) {
    const { sessionId } = rawArguments || {};
    if (!sessionId) {
      return {
        content: [{ type: 'text', text: '### Error\nsessionId is required.' }],
        isError: true,
      };
    }
    const session = this._sessions.get(sessionId);
    if (!session) {
      return {
        content: [{ type: 'text', text: `### Error\nSession "${sessionId}" not found.` }],
        isError: true,
      };
    }
    await session.close();
    this._sessions.delete(sessionId);
    return {
      content: [{ type: 'text', text: `### Result\nSession "${sessionId}" closed.` }],
    };
  }

  async serverClosed() {
    for (const session of this._sessions.values())
      await session.close().catch(() => {});
    this._sessions.clear();
  }
}

module.exports = { MultiSessionBackend };
