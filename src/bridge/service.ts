import path from 'node:path';

import type { Config } from '../config.js';
import type { PendingPermissions } from '../permission-gateway.js';
import type { JsonFileStore, ThreadSummary, ThreadToolState } from '../store.js';
import type {
  BridgeAdapter,
  ChannelType,
  ChannelBinding,
  InboundMessage,
  PermissionRequestPayload,
} from './contracts.js';
import { runConversation } from './conversation.js';
import { FeishuAdapter } from './feishu.js';

const MAX_INPUT_LENGTH = 120_000;
const THREAD_LIST_PAGE_SIZE = 5;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncateInlineValue(value: string, maxChars = 120): string {
  const normalized = collapseWhitespace(value);
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function inlineCode(value: string): string {
  return `\`${value.replace(/`/g, "'")}\``;
}

function summarizePermissionScopes(value: unknown): string {
  if (!value || typeof value !== 'object') {
    return '';
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => {
      if (Array.isArray(entryValue)) {
        return entryValue.length > 0;
      }
      return Boolean(entryValue);
    })
    .map(([key, entryValue]) => {
      if (Array.isArray(entryValue)) {
        return `${key}(${entryValue.length})`;
      }
      return key;
    });

  if (entries.length === 0) {
    return '';
  }

  const preview = entries.slice(0, 3).join(', ');
  return entries.length > 3 ? `${preview} +${entries.length - 3}` : preview;
}

function renderPermissionRequestBody(
  binding: ChannelBinding,
  payload: PermissionRequestPayload,
  options?: { autoAllowed?: boolean },
): string {
  const lines: string[] = [];
  if (options?.autoAllowed) {
    lines.push('Rokid 通道已自动允许。');
  }

  lines.push(`**工具：** ${inlineCode(payload.toolName)}`);

  const reason = typeof payload.toolInput.reason === 'string'
    ? truncateInlineValue(payload.toolInput.reason, 100)
    : '';
  if (reason) {
    lines.push(`**说明：** ${reason}`);
  }

  if (payload.toolName === 'Bash') {
    const command = typeof payload.toolInput.command === 'string'
      ? truncateInlineValue(payload.toolInput.command, 100)
      : '';
    const cwd = typeof payload.toolInput.cwd === 'string'
      ? truncateInlineValue(payload.toolInput.cwd, 72)
      : '';
    if (command) {
      lines.push(`**命令：** ${inlineCode(command)}`);
    }
    if (cwd) {
      lines.push(`**目录：** ${inlineCode(cwd)}`);
    }
  } else if (payload.toolName === 'Edit') {
    const grantRoot = typeof payload.toolInput.grantRoot === 'string'
      ? truncateInlineValue(payload.toolInput.grantRoot, 72)
      : '';
    if (grantRoot) {
      lines.push(`**范围：** ${inlineCode(grantRoot)}`);
    }
  } else if (payload.toolName === 'Permissions') {
    const scopes = summarizePermissionScopes(payload.toolInput.permissions);
    if (scopes) {
      lines.push(`**权限：** ${scopes}`);
    }
  } else {
    const detail = truncateInlineValue(JSON.stringify(payload.toolInput), 100);
    if (detail) {
      lines.push(`**详情：** ${inlineCode(detail)}`);
    }
  }

  lines.push(`**线程：** ${inlineCode(`${binding.codepilotSessionId.slice(0, 8)}...`)}`);
  return lines.join('\n');
}

function truncateInput(text: string): string {
  if (text.length <= MAX_INPUT_LENGTH) {
    return text;
  }
  return text.slice(0, MAX_INPUT_LENGTH);
}

function isAbsoluteDir(value: string): boolean {
  return path.isAbsolute(value) && !value.includes('\0') && !value.includes('/../') && !value.endsWith('/..');
}

function validateMode(value: string): value is 'code' | 'plan' | 'ask' {
  return value === 'code' || value === 'plan' || value === 'ask';
}

function looksLikePermissionShortcut(rawText: string): boolean {
  return /^[123]$/.test(normalizeText(rawText));
}

function cleanThreadSwitchTarget(value: string): string {
  return value
    .trim()
    .replace(/^[「『“"']+/, '')
    .replace(/[」』”"']+$/, '')
    .trim();
}

function mapThreadShortcut(rawText: string): string | null {
  const normalized = normalizeText(rawText);
  const listAliases = new Set([
    '线程列表',
    '显示线程',
    '查看线程',
    '列出线程',
    '线程',
  ]);
  if (listAliases.has(normalized)) {
    return '/threads';
  }

  const switchPrefixes = ['切换线程', '切到线程', '切线程', '切换到线程'];
  for (const prefix of switchPrefixes) {
    if (!normalized.startsWith(prefix)) continue;
    const target = cleanThreadSwitchTarget(normalized.slice(prefix.length));
    return target ? `/thread switch ${target}` : '/threads';
  }

  const naturalSwitch = normalized.match(/^切换到(.+)线程$/u);
  if (naturalSwitch?.[1]) {
    const target = cleanThreadSwitchTarget(naturalSwitch[1]);
    return target ? `/thread switch ${target}` : '/threads';
  }

  return null;
}

function encodeProjectRoot(rootPath: string): string {
  return encodeURIComponent(rootPath);
}

function decodeProjectRoot(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parsePositiveInteger(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return parsed > 0 ? parsed : null;
}

function normalizeVisibleThreadCount(value?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return THREAD_LIST_PAGE_SIZE;
  }
  return Math.max(THREAD_LIST_PAGE_SIZE, Math.trunc(value));
}

function normalizeThreadPageStart(value?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.trunc(value));
}

function parseProjectThreadsCallback(value: string): { projectRoot: string; visibleCount?: number } {
  const lastColon = value.lastIndexOf(':');
  if (lastColon >= 0) {
    const maybeCount = parsePositiveInteger(value.slice(lastColon + 1));
    if (maybeCount) {
      return {
        projectRoot: decodeProjectRoot(value.slice(0, lastColon)),
        visibleCount: maybeCount,
      };
    }
  }

  return { projectRoot: decodeProjectRoot(value) };
}

function parseProjectThreadsPageCallback(value: string): { projectRoot: string; pageStart?: number } {
  const lastColon = value.lastIndexOf(':');
  if (lastColon >= 0) {
    const maybeStart = parsePositiveInteger(value.slice(lastColon + 1));
    if (maybeStart !== null) {
      return {
        projectRoot: decodeProjectRoot(value.slice(0, lastColon)),
        pageStart: maybeStart,
      };
    }
  }

  return { projectRoot: decodeProjectRoot(value) };
}

function permissionResolutionFromAction(action: string): {
  behavior: 'allow' | 'deny';
  updatedPermissions?: unknown[];
} | null {
  if (action === 'allow') {
    return { behavior: 'allow' };
  }
  if (action === 'allow_session') {
    return { behavior: 'allow', updatedPermissions: [{ scope: 'session' }] };
  }
  if (action === 'deny') {
    return { behavior: 'deny' };
  }
  return null;
}

function buildInboundDedupKey(message: InboundMessage): string {
  const base = `${message.address.channelType}:${message.address.chatId}:${message.messageId}`;
  if (message.callbackData) {
    return `${base}:callback:${message.callbackData}`;
  }
  return `${base}:message`;
}

function shouldResetSdkSessionOnError(errorMessage: string): boolean {
  const normalized = normalizeText(errorMessage).toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    normalized.includes('resuming session with different model')
    || normalized.includes('no such session')
    || normalized.includes('no such thread')
    || normalized.includes('session not found')
    || normalized.includes('thread not found')
    || normalized.includes('invalid thread')
    || normalized.includes('failed to resume')
    || (normalized.includes('thread/resume') && normalized.includes('not found'))
    || (normalized.includes('resume') && normalized.includes('session'))
  );
}

type ActiveTask = {
  abortController: AbortController;
};

export class FeishuBridgeService {
  private readonly adapter: BridgeAdapter;
  private readonly channelType: ChannelType;
  private readonly sessionChains = new Map<string, Promise<void>>();
  private readonly activeTasks = new Map<string, ActiveTask>();
  private running = false;

  constructor(
    private readonly config: Config,
    private readonly store: JsonFileStore,
    private readonly permissions: PendingPermissions,
    private readonly llm: import('./contracts.js').LLMProvider,
    adapter?: BridgeAdapter,
  ) {
    this.adapter = adapter ?? new FeishuAdapter(config, store);
    this.channelType = this.adapter.channelType;
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.adapter.start((message) => this.handleInbound(message));
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
    for (const task of this.activeTasks.values()) {
      task.abortController.abort();
    }
    this.activeTasks.clear();
    this.sessionChains.clear();
    await this.adapter.stop();
  }

  isRunning(): boolean {
    return this.running && this.adapter.isRunning();
  }

  getChannelType(): ChannelType {
    return this.channelType;
  }

  private async handleInbound(message: InboundMessage): Promise<void> {
    this.store.cleanupExpiredDedup();
    const dedupKey = buildInboundDedupKey(message);
    if (this.store.checkDedup(dedupKey)) {
      return;
    }
    this.store.insertDedup(dedupKey);

    if (message.callbackData) {
      await this.handleCallback(message);
      return;
    }

    const mappedThreadCommand = mapThreadShortcut(message.text);
    if (mappedThreadCommand) {
      await this.handleCommand(message, mappedThreadCommand);
      return;
    }

    if (message.text.startsWith('/')) {
      await this.handleCommand(message, message.text);
      return;
    }

    if (looksLikePermissionShortcut(message.text)) {
      const handled = await this.handlePermissionShortcut(message);
      if (handled) return;
    }

    const binding = this.resolveBinding(message.address.chatId);
    const chain = this.sessionChains.get(binding.codepilotSessionId) || Promise.resolve();
    const next = chain.then(
      () => this.handleConversationMessage(message, binding),
      () => this.handleConversationMessage(message, binding),
    );
    this.sessionChains.set(binding.codepilotSessionId, next);
    next.finally(() => {
      if (this.sessionChains.get(binding.codepilotSessionId) === next) {
        this.sessionChains.delete(binding.codepilotSessionId);
      }
    }).catch(() => {});
    await next;
  }

  private async handleCallback(message: InboundMessage): Promise<void> {
    const callbackData = message.callbackData || '';
    if (callbackData.startsWith('perm:')) {
      const parts = callbackData.split(':');
      const action = parts[1];
      const permissionId = parts.slice(2).join(':');
      const handled = this.resolvePermission(permissionId, action);
      await this.adapter.sendText(
        message.address.chatId,
        handled ? 'Permission response recorded.' : 'Permission not found or already resolved.',
        message.callbackMessageId || message.messageId,
      );
      return;
    }

    if (callbackData.startsWith('thread:switch:')) {
      const identifier = callbackData.slice('thread:switch:'.length);
      await this.switchThread(message, identifier);
      return;
    }

    if (callbackData.startsWith('thread:page:')) {
      const pageStart = parsePositiveInteger(callbackData.slice('thread:page:'.length));
      const binding = this.resolveBinding(message.address.chatId);
      await this.showThreads(message, binding.codepilotSessionId, pageStart ?? 0);
      return;
    }

    if (callbackData.startsWith('thread:list:')) {
      const visibleCount = parsePositiveInteger(callbackData.slice('thread:list:'.length));
      const binding = this.resolveBinding(message.address.chatId);
      const pageStart = visibleCount ? Math.max(0, visibleCount - THREAD_LIST_PAGE_SIZE) : 0;
      await this.showThreads(message, binding.codepilotSessionId, pageStart);
      return;
    }

    if (callbackData === 'project:list') {
      await this.showProjects(message);
      return;
    }

    if (callbackData.startsWith('project:threads-page:')) {
      const { projectRoot, pageStart } = parseProjectThreadsPageCallback(
        callbackData.slice('project:threads-page:'.length),
      );
      await this.showProjectThreads(message, projectRoot, pageStart ?? 0);
      return;
    }

    if (callbackData.startsWith('project:threads:')) {
      const { projectRoot, visibleCount } = parseProjectThreadsCallback(
        callbackData.slice('project:threads:'.length),
      );
      const pageStart = visibleCount ? Math.max(0, visibleCount - THREAD_LIST_PAGE_SIZE) : 0;
      await this.showProjectThreads(message, projectRoot, pageStart);
      return;
    }

    if (callbackData.startsWith('project:use:')) {
      const projectRoot = decodeProjectRoot(callbackData.slice('project:use:'.length));
      await this.selectProject(message, projectRoot);
      return;
    }

    if (callbackData.startsWith('project:new:')) {
      const projectRoot = decodeProjectRoot(callbackData.slice('project:new:'.length));
      await this.createAndSwitchThread(message, projectRoot);
      return;
    }

    if (callbackData === 'thread:list') {
      const binding = this.resolveBinding(message.address.chatId);
      await this.showThreads(message, binding.codepilotSessionId);
      return;
    }

    if (callbackData === 'thread:new') {
      const binding = this.resolveBinding(message.address.chatId);
      await this.createAndSwitchThread(message, this.resolveNewThreadWorkdir(binding));
      return;
    }
  }

  private async handlePermissionShortcut(message: InboundMessage): Promise<boolean> {
    const pendingLinks = this.store.listPendingPermissionLinksByChat(message.address.chatId);
    if (pendingLinks.length === 0) {
      return false;
    }
    if (pendingLinks.length > 1) {
      await this.adapter.sendText(
        message.address.chatId,
        `Multiple pending permissions (${pendingLinks.length}). Please use /perm allow|allow_session|deny <id>.`,
        message.messageId,
      );
      return true;
    }

    const actionMap: Record<string, string> = { '1': 'allow', '2': 'allow_session', '3': 'deny' };
    const action = actionMap[normalizeText(message.text)];
    const handled = this.resolvePermission(pendingLinks[0].permissionRequestId, action);
    await this.adapter.sendText(
      message.address.chatId,
      handled ? `${action === 'allow' ? 'Allow' : action === 'allow_session' ? 'Allow Session' : 'Deny'}: recorded.` : 'Permission not found or already resolved.',
      message.messageId,
    );
    return true;
  }

  private async handleCommand(message: InboundMessage, rawText: string): Promise<void> {
    const normalized = normalizeText(rawText);
    const [rawCommand, ...rest] = normalized.split(/\s+/);
    const command = rawCommand.toLowerCase();
    const args = rest.join(' ').trim();
    const binding = this.resolveBinding(message.address.chatId);

    switch (command) {
      case '/start':
      case '/help':
        await this.adapter.sendCommandReply(message.address.chatId, [
          `<b>Codex ${this.adapter.displayName}</b>`,
          '',
          '/new [path] - Start a new thread',
          '/cwd /abs/path - Change working directory',
          '/mode code|plan|ask - Change mode',
          '/status - Show current thread',
          '/threads - Show thread picker',
          '/projects - Show Codex projects',
          '/project list | use <id> | threads <id> | new <id>',
          '/thread switch <id|index> - Switch thread',
          '/stop - Stop current task',
          '/perm allow|allow_session|deny <id> - Resolve permission',
          '/permtest - Trigger an approval test',
        ].join('\n'), message.messageId);
        return;

      case '/new': {
        const workDir = args && isAbsoluteDir(args)
          ? args
          : this.resolveNewThreadWorkdir(binding);
        await this.createAndSwitchThread(message, workDir);
        return;
      }

      case '/cwd': {
        if (!args || !isAbsoluteDir(args)) {
          await this.adapter.sendText(message.address.chatId, 'Usage: /cwd /absolute/path', message.messageId);
          return;
        }
        this.store.updateChannelBinding(binding.id, {
          workingDirectory: args,
          preferredWorkingDirectory: args,
        });
        this.store.touchChatThread(this.channelType, message.address.chatId, binding.codepilotSessionId, { workingDirectory: args });
        await this.adapter.sendCommandReply(message.address.chatId, `Working directory set to <code>${escapeHtml(args)}</code>`, message.messageId);
        return;
      }

      case '/mode': {
        if (!validateMode(args)) {
          await this.adapter.sendText(message.address.chatId, 'Usage: /mode code|plan|ask', message.messageId);
          return;
        }
        this.store.updateChannelBinding(binding.id, { mode: args });
        await this.adapter.sendCommandReply(message.address.chatId, `Mode set to <b>${args}</b>`, message.messageId);
        return;
      }

      case '/status': {
        const summary = this.store.describeChatThread(this.channelType, message.address.chatId, binding.codepilotSessionId);
        const busy = this.store.getBusyLocalThreadState(binding.codepilotSessionId);
        const lines = [
          `<b>Codex ${this.adapter.displayName} Status</b>`,
          '',
          `Session: <code>${binding.codepilotSessionId.slice(0, 8)}...</code>`,
          `CWD: <code>${escapeHtml(binding.workingDirectory || '~')}</code>`,
          `Mode: <b>${binding.mode}</b>`,
          `Model: <code>${escapeHtml(binding.model || 'default')}</code>`,
        ];
        if (summary?.latestUserPreview) {
          lines.push(`Recent: ${escapeHtml(summary.latestUserPreview)}`);
        }
        if (binding.preferredWorkingDirectory && binding.preferredWorkingDirectory !== binding.workingDirectory) {
          lines.push(`Project: <code>${escapeHtml(binding.preferredWorkingDirectory)}</code>`);
        }
        if (busy) {
          lines.push('Busy: <b>desktop thread active</b>');
        }
        await this.adapter.sendCommandReply(message.address.chatId, lines.join('\n'), message.messageId);
        return;
      }

      case '/threads':
        await this.showThreads(message, binding.codepilotSessionId);
        return;

      case '/projects':
        await this.showProjects(message);
        return;

      case '/thread':
        if (!args) {
          await this.adapter.sendText(message.address.chatId, 'Usage: /thread list | /thread switch <index|id>', message.messageId);
          return;
        }
        if (args === 'list') {
          await this.showThreads(message, binding.codepilotSessionId);
          return;
        }
        if (args.startsWith('switch ')) {
          await this.switchThread(message, args.slice('switch '.length).trim());
          return;
        }
        if (args === 'new') {
          await this.createAndSwitchThread(message, this.resolveNewThreadWorkdir(binding));
          return;
        }
        await this.adapter.sendText(message.address.chatId, 'Usage: /thread list | /thread switch <index|id>', message.messageId);
        return;

      case '/project':
        if (!args || args === 'list') {
          await this.showProjects(message);
          return;
        }
        if (args.startsWith('use ')) {
          await this.selectProject(message, args.slice('use '.length).trim());
          return;
        }
        if (args.startsWith('threads ')) {
          await this.showProjectThreads(message, args.slice('threads '.length).trim());
          return;
        }
        if (args.startsWith('new ')) {
          const project = this.store.findCodexProject(args.slice('new '.length).trim());
          if (!project) {
            await this.adapter.sendText(message.address.chatId, 'Project not found.', message.messageId);
            return;
          }
          await this.createAndSwitchThread(message, project.rootPath);
          return;
        }
        await this.adapter.sendText(message.address.chatId, 'Usage: /project list | /project use <index|name> | /project threads <index|name> | /project new <index|name>', message.messageId);
        return;

      case '/stop': {
        const active = this.activeTasks.get(binding.codepilotSessionId);
        if (!active) {
          await this.adapter.sendText(message.address.chatId, 'No task is currently running.', message.messageId);
          return;
        }
        active.abortController.abort();
        this.activeTasks.delete(binding.codepilotSessionId);
        await this.adapter.sendText(message.address.chatId, 'Stopping current task...', message.messageId);
        return;
      }

      case '/perm': {
        const [action, permissionId] = args.split(/\s+/, 2);
        if (!action || !permissionId) {
          await this.adapter.sendText(message.address.chatId, 'Usage: /perm allow|allow_session|deny <id>', message.messageId);
          return;
        }
        const handled = this.resolvePermission(permissionId, action);
        await this.adapter.sendText(
          message.address.chatId,
          handled ? `Permission ${action}: recorded.` : 'Permission not found or already resolved.',
          message.messageId,
        );
        return;
      }

      case '/permtest':
        await this.runPermissionTest(message, binding);
        return;

      default:
        await this.adapter.sendText(message.address.chatId, `Unknown command: ${command}`, message.messageId);
    }
  }

  private async deliverThreadPicker(
    message: InboundMessage,
    threads: ThreadSummary[],
    currentSessionId: string,
    options: {
      title: string;
      subtitle?: string;
      maxItems?: number;
      inlineRows?: boolean;
      includeProjectLabel?: boolean;
      actions?: Array<{ label: string; callbackData: string; style?: 'default' | 'primary' | 'danger'; disabled?: boolean }>;
      loadMoreCallbackData?: string;
    },
    replaceExisting = false,
  ): Promise<void> {
    if (replaceExisting && message.callbackMessageId && this.adapter.updateThreadPicker) {
      const updated = await this.adapter.updateThreadPicker(
        message.address.chatId,
        message.callbackMessageId,
        threads,
        currentSessionId,
        options,
      );
      if (updated) {
        return;
      }
    }

    await this.adapter.sendThreadPicker(
      message.address.chatId,
      threads,
      currentSessionId,
      message.callbackMessageId || message.messageId,
      options,
    );
  }

  private async showThreads(
    message: InboundMessage,
    currentSessionId: string,
    pageStart = 0,
    replaceExisting = false,
  ): Promise<void> {
    const threads = this.store.listChatThreads(this.channelType, message.address.chatId);
    const normalizedPageStart = normalizeThreadPageStart(pageStart);
    const nextPageStart = normalizedPageStart + THREAD_LIST_PAGE_SIZE < threads.length
      ? normalizedPageStart + THREAD_LIST_PAGE_SIZE
      : null;

    await this.deliverThreadPicker(
      message,
      threads,
      currentSessionId,
      {
        title: '最近线程',
        startIndex: normalizedPageStart,
        maxItems: THREAD_LIST_PAGE_SIZE,
        inlineRows: true,
        includeProjectLabel: true,
        loadMoreCallbackData: nextPageStart !== null ? `thread:page:${nextPageStart}` : undefined,
      },
      replaceExisting,
    );
  }

  private async showProjects(message: InboundMessage): Promise<void> {
    const projects = this.store.listCodexProjects();
    await this.adapter.sendProjectPicker(message.address.chatId, projects, message.messageId);
  }

  private async showProjectThreads(
    message: InboundMessage,
    identifier: string,
    pageStart = 0,
    replaceExisting = false,
  ): Promise<void> {
    const project = this.store.findCodexProject(identifier);
    if (!project) {
      await this.adapter.sendText(message.address.chatId, '未找到对应项目。', message.messageId);
      return;
    }

    const binding = this.resolveBinding(message.address.chatId);
    const threads = this.store.listProjectThreads(this.channelType, message.address.chatId, project.rootPath);
    const normalizedPageStart = normalizeThreadPageStart(pageStart);
    const nextPageStart = normalizedPageStart + THREAD_LIST_PAGE_SIZE < threads.length
      ? normalizedPageStart + THREAD_LIST_PAGE_SIZE
      : null;

    await this.deliverThreadPicker(
      message,
      threads,
      binding.codepilotSessionId,
      {
        title: `${project.displayName} · 线程`,
        subtitle: `项目：${project.displayName}`,
        startIndex: normalizedPageStart,
        maxItems: THREAD_LIST_PAGE_SIZE,
        inlineRows: true,
        actions: [
          { label: '项目列表', callbackData: 'project:list', style: 'default' },
          {
            label: binding.preferredWorkingDirectory === project.rootPath ? '当前项目' : '使用项目',
            callbackData: `project:use:${encodeProjectRoot(project.rootPath)}`,
            style: 'default',
            disabled: binding.preferredWorkingDirectory === project.rootPath,
          },
          { label: '在此新建', callbackData: `project:new:${encodeProjectRoot(project.rootPath)}`, style: 'primary' },
        ],
        loadMoreCallbackData: nextPageStart !== null
          ? `project:threads-page:${encodeProjectRoot(project.rootPath)}:${nextPageStart}`
          : undefined,
      },
      replaceExisting,
    );
  }

  private async selectProject(message: InboundMessage, identifier: string): Promise<void> {
    const project = this.store.findCodexProject(identifier);
    if (!project) {
      await this.adapter.sendText(message.address.chatId, '未找到对应项目。', message.messageId);
      return;
    }

    const binding = this.resolveBinding(message.address.chatId);
    this.store.updateChannelBinding(binding.id, {
      preferredWorkingDirectory: project.rootPath,
    });
    await this.adapter.sendCommandReply(
      message.address.chatId,
      `<b>已切换当前项目</b>\n\n<b>${escapeHtml(project.displayName)}</b>\n\n后续 <code>/new</code> 会默认在这个项目下创建线程。`,
      message.messageId,
    );
  }

  private async createAndSwitchThread(message: InboundMessage, workDir?: string): Promise<void> {
    const newBinding = this.createBinding(message.address.chatId, workDir);
    const summary = this.store.describeChatThread(this.channelType, message.address.chatId, newBinding.codepilotSessionId);
    const title = summary?.title || '新线程';
    const projectLabel = summary?.projectLabel || '聊天';
    await this.adapter.sendCommandReply(
      message.address.chatId,
      `<b>已新建线程</b>\n\n<b>${escapeHtml(title)}</b>\n项目：${escapeHtml(projectLabel)}`,
      message.messageId,
    );
  }

  private async switchThread(message: InboundMessage, identifier: string): Promise<void> {
    const currentBinding = this.resolveBinding(message.address.chatId);
    const target = this.store.findChatThread(this.channelType, message.address.chatId, identifier);
    if (!target) {
      await this.adapter.sendText(message.address.chatId, '未找到对应线程。', message.messageId);
      return;
    }

    const resolved = target.importable
      ? this.store.importChatThread(this.channelType, message.address.chatId, target.sdkSessionId)
      : target;

    if (!resolved) {
      await this.adapter.sendText(message.address.chatId, '导入线程失败。', message.messageId);
      return;
    }

    this.store.updateChannelBinding(currentBinding.id, {
      codepilotSessionId: resolved.sessionId,
      sdkSessionId: resolved.sdkSessionId,
      workingDirectory: resolved.workingDirectory,
      preferredWorkingDirectory: resolved.workingDirectory,
      model: resolved.model,
      updatedAt: new Date().toISOString(),
    });
    this.store.touchChatThread(this.channelType, message.address.chatId, resolved.sessionId, {
      workingDirectory: resolved.workingDirectory,
      model: resolved.model,
      title: resolved.title,
      touch: false,
    });

    await this.adapter.sendCommandReply(
      message.address.chatId,
      `<b>已切换线程</b>\n\n<b>${escapeHtml(resolved.title)}</b>\n项目：${escapeHtml(resolved.projectLabel || '聊天')}`,
      message.messageId,
    );

    const mirrored = await this.maybeMirrorBusyThread(message, this.resolveBinding(message.address.chatId));
    if (mirrored) {
      return;
    }
  }

  private async runPermissionTest(message: InboundMessage, binding: ChannelBinding): Promise<void> {
    await this.handleConversationMessage({
      ...message,
      text: 'Run a harmless shell command that requires approval: create and then remove ~/.codex-feishu/.permtest-smoke . Do not do anything else.',
    }, binding);
  }

  private async handleConversationMessage(message: InboundMessage, binding: ChannelBinding): Promise<void> {
    const mirrored = await this.maybeMirrorBusyThread(message, binding);
    if (mirrored) return;

    const prompt = truncateInput(message.text || (message.attachments?.length ? 'Describe this attachment.' : ''));
    if (!prompt && !message.attachments?.length) {
      return;
    }

    this.adapter.beginResponse(message.address.chatId, message.messageId);
    const abortController = new AbortController();
    let inboundAbortListener: (() => void) | null = null;
    if (message.abortSignal) {
      inboundAbortListener = () => abortController.abort();
      if (message.abortSignal.aborted) {
        abortController.abort();
      } else {
        message.abortSignal.addEventListener('abort', inboundAbortListener, { once: true });
      }
    }
    this.activeTasks.set(binding.codepilotSessionId, { abortController });
    let partialText = '';
    let tools: ThreadToolState[] = [];

    try {
      const result = await runConversation(this.store, this.llm, binding, prompt, {
        abortSignal: abortController.signal,
        files: message.attachments,
        callbacks: {
          onPartialText: (fullText) => {
            partialText = fullText;
            this.adapter.updateResponse(message.address.chatId, fullText, tools);
          },
          onTools: (nextTools) => {
            tools = nextTools;
            this.adapter.updateResponse(message.address.chatId, partialText, tools);
          },
          onPermission: async (payload) => {
            await this.forwardPermissionRequest(message, binding, payload);
          },
        },
      });

      if (binding.id) {
        const nextSdkSessionId = result.sdkSessionId || binding.sdkSessionId;
        if (nextSdkSessionId && !shouldResetSdkSessionOnError(result.errorMessage)) {
          this.store.updateChannelBinding(binding.id, { sdkSessionId: nextSdkSessionId });
        } else if (result.hasError && shouldResetSdkSessionOnError(result.errorMessage)) {
          this.store.updateChannelBinding(binding.id, { sdkSessionId: '' });
        }
      }
      this.store.touchChatThread(this.channelType, message.address.chatId, binding.codepilotSessionId, {
        workingDirectory: binding.workingDirectory,
        model: binding.model,
      });
      this.store.syncBridgeThreadFromLocal(binding.codepilotSessionId);

      if (result.responseText) {
        await this.adapter.finalizeResponse(message.address.chatId, 'completed', result.responseText, message.messageId);
      } else if (result.hasError) {
        await this.adapter.finalizeResponse(
          message.address.chatId,
          'error',
          `Error\n\n${result.errorMessage}`,
          message.messageId,
        );
      } else {
        await this.adapter.finalizeResponse(message.address.chatId, 'completed', 'Done.', message.messageId);
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      const status = abortController.signal.aborted ? 'interrupted' : 'error';
      await this.adapter.finalizeResponse(message.address.chatId, status, messageText, message.messageId);
    } finally {
      if (message.abortSignal && inboundAbortListener) {
        message.abortSignal.removeEventListener('abort', inboundAbortListener);
      }
      this.activeTasks.delete(binding.codepilotSessionId);
    }
  }

  private async maybeMirrorBusyThread(message: InboundMessage, binding: ChannelBinding): Promise<boolean> {
    const busyThread = this.store.getBusyLocalThreadState(binding.codepilotSessionId);
    if (!busyThread) {
      return false;
    }

    await this.adapter.sendText(message.address.chatId, '当前线程忙碌中', message.messageId);
    this.adapter.beginResponse(message.address.chatId, message.messageId);

    const abortController = new AbortController();
    let inboundAbortListener: (() => void) | null = null;
    if (message.abortSignal) {
      inboundAbortListener = () => abortController.abort();
      if (message.abortSignal.aborted) {
        abortController.abort();
      } else {
        message.abortSignal.addEventListener('abort', inboundAbortListener, { once: true });
      }
    }
    this.activeTasks.set(binding.codepilotSessionId, { abortController });
    let streamedText = busyThread.previewText || '';
    let finalText = busyThread.finalText || streamedText;
    let tools: ThreadToolState[] = busyThread.tools;
    this.adapter.updateResponse(message.address.chatId, streamedText, tools);

    try {
      const result = await this.store.followBusyLocalThread(binding.codepilotSessionId, {
        abortSignal: abortController.signal,
        onText: (fullText) => {
          streamedText = fullText;
          this.adapter.updateResponse(message.address.chatId, streamedText, tools);
        },
        onTools: (nextTools) => {
          tools = nextTools;
          this.adapter.updateResponse(message.address.chatId, streamedText, tools);
        },
      });

      if (result.finalText) {
        finalText = result.finalText;
      }

      if (result.completed) {
        const synced = this.store.syncImportedThreadFromLocalSource(binding.codepilotSessionId);
        if (!finalText) {
          finalText = synced?.assistantText || synced?.userText || '';
        }
      }

      await this.adapter.finalizeResponse(
        message.address.chatId,
        result.completed ? 'completed' : 'interrupted',
        finalText || streamedText,
        message.messageId,
      );
    } catch (error) {
      await this.adapter.finalizeResponse(
        message.address.chatId,
        abortController.signal.aborted ? 'interrupted' : 'error',
        finalText || streamedText || (error instanceof Error ? error.message : String(error)),
        message.messageId,
      );
    } finally {
      if (message.abortSignal && inboundAbortListener) {
        message.abortSignal.removeEventListener('abort', inboundAbortListener);
      }
      this.activeTasks.delete(binding.codepilotSessionId);
    }

    return true;
  }

  private async forwardPermissionRequest(
    message: InboundMessage,
    binding: ChannelBinding,
    payload: PermissionRequestPayload,
  ): Promise<void> {
    if (this.channelType === 'rokid' && this.config.rokidAutoAllowPermissions) {
      const resolution: { behavior: 'allow'; updatedPermissions: unknown[] } = {
        behavior: 'allow',
        updatedPermissions: [{ scope: 'session' }],
      };
      if (!this.permissions.resolve(payload.permissionRequestId, resolution)) {
        setTimeout(() => {
          this.permissions.resolve(payload.permissionRequestId, resolution);
        }, 0);
      }
      const body = renderPermissionRequestBody(binding, payload, { autoAllowed: true });
      await this.adapter.sendPermissionRequest(
        message.address.chatId,
        body,
        payload.permissionRequestId,
        message.messageId,
      );
      return;
    }

    this.store.insertPermissionLink({
      permissionRequestId: payload.permissionRequestId,
      channelType: this.channelType,
      chatId: message.address.chatId,
      messageId: message.messageId,
      toolName: payload.toolName,
      suggestions: JSON.stringify(payload.suggestions || []),
    });

    const body = renderPermissionRequestBody(binding, payload);

    await this.adapter.sendPermissionRequest(
      message.address.chatId,
      body,
      payload.permissionRequestId,
      message.messageId,
    );
  }

  private resolvePermission(permissionId: string, action: string): boolean {
    const resolution = permissionResolutionFromAction(action);
    if (!resolution) return false;
    const claimed = this.store.markPermissionLinkResolved(permissionId);
    if (!claimed) return false;
    return this.permissions.resolve(permissionId, resolution);
  }

  private resolveBinding(chatId: string): ChannelBinding {
    const existing = this.store.getChannelBinding(this.channelType, chatId);
    if (existing) {
      const session = this.store.getSession(existing.codepilotSessionId);
      if (session) return existing;
    }
    return this.createBinding(chatId, this.resolveDefaultWorkdir());
  }

  private resolveDefaultWorkdir(): string {
    return this.store.getDefaultChatRoot() || this.config.defaultWorkDir;
  }

  private resolveNewThreadWorkdir(binding: ChannelBinding): string {
    return binding.preferredWorkingDirectory
      || binding.workingDirectory
      || this.resolveDefaultWorkdir();
  }

  private createBinding(chatId: string, workDir?: string): ChannelBinding {
    const workingDirectory = workDir || this.resolveDefaultWorkdir();
    const model = this.config.defaultModel || '';
    const session = this.store.createSession(
      `${this.adapter.displayName} ${chatId}`,
      model,
      undefined,
      workingDirectory,
      this.config.defaultMode,
    );
    const defaultProviderId = this.store.getDefaultProviderId();
    if (defaultProviderId) {
      this.store.updateSessionProviderId(session.id, defaultProviderId);
    }
    const binding = this.store.upsertChannelBinding({
      channelType: this.channelType,
      chatId,
      codepilotSessionId: session.id,
      workingDirectory: session.working_directory,
      preferredWorkingDirectory: session.working_directory,
      model: session.model,
    });
    const initialTitle = session.working_directory === this.store.getDefaultChatRoot()
      ? '新线程'
      : (path.basename(session.working_directory) || '新线程');
    this.store.touchChatThread(this.channelType, chatId, binding.codepilotSessionId, {
      workingDirectory: session.working_directory,
      model: session.model,
      title: initialTitle,
      touch: false,
    });
    return binding;
  }
}
