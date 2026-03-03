#!/usr/bin/env node
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

if (process.argv.includes('--multi')) {
  // Multi-session mode: strip --multi from argv and handle separately.
  process.argv = process.argv.filter(arg => arg !== '--multi');

  const { program, ProgramOption } = require('playwright-core/lib/utilsBundle');
  const { decorateMCPCommand } = require('playwright/lib/mcp/program');
  const { start } = require('playwright/lib/mcp/sdk/exports');
  const { MultiSessionBackend } = require('./multi');
  const packageJSON = require('./package.json');

  const p = program.version('Version ' + packageJSON.version).name('Playwright MCP (Multi)');

  // Reuse decorateMCPCommand to set up all standard options, but override the action.
  decorateMCPCommand(p, packageJSON.version);

  // Replace the action with our multi-session handler.
  const origHandler = p._actionHandler;
  p._actionHandler = null;
  p.action(async (options) => {
    // Use the original handler's setup logic by building config the same way.
    // We intercept at the factory level by passing our MultiSessionBackend.
    const config = buildConfigFromOptions(options);
    const factory = {
      name: 'Playwright (Multi)',
      nameInConfig: 'playwright',
      version: packageJSON.version,
      create: () => new MultiSessionBackend(config),
    };
    await start(factory, { port: options.port ? parseInt(options.port, 10) : undefined, host: options.host, allowedHosts: options.allowedHosts });
  });

  void program.parseAsync(process.argv);
} else {
  // Standard single-session mode — delegate entirely to Playwright.
  const { program } = require('playwright-core/lib/utilsBundle');
  const { decorateMCPCommand } = require('playwright/lib/mcp/program');

  const packageJSON = require('./package.json');
  const p = program.version('Version ' + packageJSON.version).name('Playwright MCP');
  decorateMCPCommand(p, packageJSON.version);
  void program.parseAsync(process.argv);
}

function buildConfigFromOptions(options) {
  const config = {};
  const browser = {};
  let hasBrowser = false;

  if (options.browser) {
    hasBrowser = true;
    const channelBrowsers = ['chrome', 'msedge'];
    if (channelBrowsers.includes(options.browser)) {
      browser.browserName = 'chromium';
      browser.launchOptions = { ...browser.launchOptions, channel: options.browser };
    } else {
      browser.browserName = options.browser;
    }
  }
  if (options.headless) {
    hasBrowser = true;
    browser.launchOptions = { ...browser.launchOptions, headless: true };
  }
  if (options.userDataDir) {
    hasBrowser = true;
    browser.userDataDir = options.userDataDir;
  }
  if (options.executablePath) {
    hasBrowser = true;
    browser.launchOptions = { ...browser.launchOptions, executablePath: options.executablePath };
  }
  if (options.cdpEndpoint) {
    hasBrowser = true;
    browser.cdpEndpoint = options.cdpEndpoint;
  }
  if (options.isolated) {
    hasBrowser = true;
    browser.isolated = true;
  }
  if (options.sandbox === false || options.noSandbox) {
    hasBrowser = true;
    browser.launchOptions = { ...browser.launchOptions, args: [...(browser.launchOptions?.args || []), '--no-sandbox'] };
  }
  if (options.viewportSize) {
    hasBrowser = true;
    browser.contextOptions = { ...browser.contextOptions, viewport: { width: options.viewportSize.width, height: options.viewportSize.height } };
  }
  if (options.device) {
    hasBrowser = true;
    browser.contextOptions = { ...browser.contextOptions, ...getDeviceDescriptor(options.device) };
  }
  if (options.ignoreHttpsErrors) {
    hasBrowser = true;
    browser.contextOptions = { ...browser.contextOptions, ignoreHTTPSErrors: true };
  }
  if (options.userAgent) {
    hasBrowser = true;
    browser.contextOptions = { ...browser.contextOptions, userAgent: options.userAgent };
  }
  if (options.storageState) {
    hasBrowser = true;
    browser.contextOptions = { ...browser.contextOptions, storageState: options.storageState };
  }
  if (options.proxyServer) {
    hasBrowser = true;
    const proxy = { server: options.proxyServer };
    if (options.proxyBypass)
      proxy.bypass = options.proxyBypass;
    browser.launchOptions = { ...browser.launchOptions, proxy };
  }
  if (options.cdpHeader) {
    hasBrowser = true;
    browser.cdpHeaders = options.cdpHeader;
  }
  if (options.cdpTimeout !== undefined) {
    hasBrowser = true;
    browser.cdpTimeout = options.cdpTimeout;
  }
  if (options.initScript) {
    hasBrowser = true;
    browser.initScript = Array.isArray(options.initScript) ? options.initScript : [options.initScript];
  }
  if (options.initPage) {
    hasBrowser = true;
    browser.initPage = Array.isArray(options.initPage) ? options.initPage : [options.initPage];
  }
  if (options.grantPermissions) {
    hasBrowser = true;
    browser.contextOptions = { ...browser.contextOptions, permissions: options.grantPermissions };
  }

  if (hasBrowser)
    config.browser = browser;

  if (options.caps) {
    const caps = Array.isArray(options.caps) ? options.caps : [options.caps];
    if (caps.includes('vision'))
      config.capabilities = [...(config.capabilities || []), 'vision'];
    if (caps.includes('pdf'))
      config.capabilities = [...(config.capabilities || []), 'pdf'];
    if (caps.includes('devtools'))
      config.capabilities = [...(config.capabilities || []), 'devtools'];
  }

  if (options.allowedOrigins || options.blockedOrigins) {
    config.network = {};
    if (options.allowedOrigins)
      config.network.allowedOrigins = options.allowedOrigins;
    if (options.blockedOrigins)
      config.network.blockedOrigins = options.blockedOrigins;
  }

  if (options.imageResponses)
    config.imageResponses = options.imageResponses;
  if (options.snapshotMode)
    config.snapshot = { mode: options.snapshotMode };
  if (options.outputDir)
    config.outputDir = options.outputDir;
  if (options.outputMode)
    config.outputMode = options.outputMode;
  if (options.saveSession)
    config.saveSession = true;
  if (options.saveTrace)
    config.saveTrace = true;
  if (options.saveVideo)
    config.saveVideo = options.saveVideo;
  if (options.testIdAttribute)
    config.testIdAttribute = options.testIdAttribute;
  if (options.timeoutAction !== undefined || options.timeoutNavigation !== undefined) {
    config.timeouts = {};
    if (options.timeoutAction !== undefined)
      config.timeouts.action = options.timeoutAction;
    if (options.timeoutNavigation !== undefined)
      config.timeouts.navigation = options.timeoutNavigation;
  }
  if (options.codegen)
    config.codegen = options.codegen;
  if (options.allowUnrestrictedFileAccess)
    config.allowUnrestrictedFileAccess = true;
  if (options.consoleLevel)
    config.console = { level: options.consoleLevel };
  if (options.secrets)
    config.secrets = options.secrets;
  if (options.blockServiceWorkers) {
    config.browser = config.browser || {};
    config.browser.contextOptions = { ...config.browser?.contextOptions, serviceWorkers: 'block' };
  }

  return config;
}

function getDeviceDescriptor(deviceName) {
  try {
    const { devices } = require('playwright-core');
    return devices[deviceName] || {};
  } catch {
    return {};
  }
}
